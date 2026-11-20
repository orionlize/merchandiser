package engine

import (
	"context"
	"log/slog"
	"sort"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/model"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

// The task ledger splits each follower account into per-task virtual
// positions. Several tasks may follow into the same account (even the same
// coin); each one sizes, reconciles and reports PnL against its own share
// only, never against what other tasks (or the user, by hand) hold there.
//
// Shares move with the fills of the task's own orders (market orders and
// mirrored resting orders). When the account ends up holding less than the
// tasks' shares add up to (liquidation, a manual close, a mirror cancelled
// rather than filled), the shares are scaled down to match.

type ledgerKey struct{ task, conn, base string }

type ledgerPos struct {
	size, avgPx, realized decimal.Decimal
	// Last time this share changed through a fill (ms).
	changedAt int64
}

// shortfall tracks an account holding less than the tasks' shares, so a
// single snapshot racing a fresh fill is never taken as a liquidation.
type shortfall struct {
	since int64
	held  decimal.Decimal
}

// A shortfall must be seen on snapshots spanning this long, and taken at
// least this long after the last fill, before the shares are cut.
const shortfallMs = 5_000

func (e *Engine) loadLedger(ctx context.Context) {
	rows, err := store.TaskPositions(ctx, e.DB, "")
	if err != nil {
		slog.Error("load task ledger", "err", err)
		return
	}
	e.ledgerMu.Lock()
	defer e.ledgerMu.Unlock()
	for _, p := range rows {
		e.ledger[ledgerKey{p.TaskID, p.ConnectionID, p.Base}] = &ledgerPos{size: util.Dec(p.Size), avgPx: util.Dec(p.AvgPx), realized: util.Dec(p.Realized), changedAt: p.UpdatedAt}
	}
}

// persist writes one share; the caller holds ledgerMu.
func (e *Engine) persistLedger(k ledgerKey, p *ledgerPos) {
	err := store.UpsertTaskPosition(context.Background(), e.DB, &store.TaskPositionRow{
		TaskID: k.task, ConnectionID: k.conn, Base: k.base,
		Size: util.Fmt(p.size), AvgPx: util.Fmt(p.avgPx), Realized: util.Fmt(p.realized), UpdatedAt: util.NowMs(),
	})
	if err != nil {
		slog.Error("persist task ledger", "task", k.task, "base", k.base, "err", err)
	}
}

// applyFill books a signed fill (qty > 0 = bought) at px, average-cost style.
func (p *ledgerPos) applyFill(qty, px decimal.Decimal) {
	if qty.IsZero() {
		return
	}
	if p.size.IsZero() || p.size.Sign() == qty.Sign() {
		tot := p.size.Abs().Add(qty.Abs())
		p.avgPx = p.size.Abs().Mul(p.avgPx).Add(qty.Abs().Mul(px)).Div(tot)
		p.size = p.size.Add(qty)
		return
	}
	closed := util.MinD(qty.Abs(), p.size.Abs())
	p.realized = p.realized.Add(closed.Mul(px.Sub(p.avgPx)).Mul(util.Signum(p.size)))
	p.size = p.size.Add(qty)
	switch {
	case p.size.IsZero():
		p.avgPx = decimal.Zero
	case p.size.Sign() == qty.Sign(): // flipped through zero
		p.avgPx = px
	}
}

// LedgerFill books a fill of one task's own order.
func (e *Engine) LedgerFill(task, conn, base string, qty, px decimal.Decimal) {
	if qty.IsZero() || !px.IsPositive() {
		return
	}
	k := ledgerKey{task, conn, base}
	e.ledgerMu.Lock()
	defer e.ledgerMu.Unlock()
	p := e.ledger[k]
	if p == nil {
		p = &ledgerPos{}
		e.ledger[k] = p
	}
	p.applyFill(qty, px)
	p.changedAt = util.NowMs()
	delete(e.short, connBase(conn, base))
	e.persistLedger(k, p)
}

// Held is a task's signed share of one coin on one account.
func (e *Engine) Held(task, conn, base string) decimal.Decimal {
	e.ledgerMu.Lock()
	defer e.ledgerMu.Unlock()
	if p := e.ledger[ledgerKey{task, conn, base}]; p != nil {
		return p.size
	}
	return decimal.Zero
}

type heldPos struct {
	base        string
	size, avgPx decimal.Decimal
}

// heldOn lists a task's non-zero shares on one account, sorted by coin.
func (e *Engine) heldOn(task, conn string) []heldPos {
	e.ledgerMu.Lock()
	defer e.ledgerMu.Unlock()
	var out []heldPos
	for k, p := range e.ledger {
		if k.task == task && k.conn == conn && !p.size.IsZero() {
			out = append(out, heldPos{k.base, p.size, p.avgPx})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].base < out[j].base })
	return out
}

// claimShare gives a task its opening share of a position already on the
// account (tasks that ran before the ledger existed, or that start on an
// account already holding the coin): at most the target, and never what
// other tasks already own.
func (e *Engine) claimShare(task, conn, base string, target, actual, entryPx decimal.Decimal) {
	e.ledgerMu.Lock()
	defer e.ledgerMu.Unlock()
	k := ledgerKey{task, conn, base}
	if p := e.ledger[k]; p != nil && !p.size.IsZero() {
		return
	}
	others := decimal.Zero
	for ok, p := range e.ledger {
		if ok.conn == conn && ok.base == base && ok.task != task {
			others = others.Add(p.size)
		}
	}
	free := actual.Sub(others)
	if free.IsZero() || target.IsZero() || free.Sign() != target.Sign() || (!actual.IsZero() && free.Sign() != actual.Sign()) {
		return
	}
	size := util.MinD(free.Abs(), target.Abs()).Mul(util.Signum(target))
	p := e.ledger[k]
	if p == nil {
		p = &ledgerPos{}
		e.ledger[k] = p
	}
	p.size, p.avgPx, p.changedAt = size, entryPx, util.NowMs()
	e.persistLedger(k, p)
}

func connBase(conn, base string) string { return conn + "|" + base }

// reconcileLedger scales the shares on an account down when it holds less
// than they add up to. Only same-direction shares are cut: when tasks hold
// opposite sides the netted account position says nothing about which one
// changed. px prices the cut part (it is booked as realised).
func (e *Engine) reconcileLedger(conn string, snap *model.AccountSnapshot, px func(base string) decimal.Decimal) {
	if snap == nil {
		return
	}
	e.ledgerMu.Lock()
	defer e.ledgerMu.Unlock()
	byBase := map[string][]ledgerKey{}
	for k, p := range e.ledger {
		if k.conn == conn && !p.size.IsZero() {
			byBase[k.base] = append(byBase[k.base], k)
		}
	}
	now := util.NowMs()
	for base, keys := range byBase {
		sum, sign, mixed, last := decimal.Zero, 0, false, int64(0)
		for _, k := range keys {
			p := e.ledger[k]
			sum = sum.Add(p.size)
			if sign == 0 {
				sign = p.size.Sign()
			} else if sign != p.size.Sign() {
				mixed = true
			}
			last = max(last, p.changedAt)
		}
		actual := snap.Position(base)
		var keep decimal.Decimal // total the shares should shrink to (abs)
		switch {
		case mixed:
			continue
		case actual.Sign() != sign:
			keep = decimal.Zero
		case actual.Abs().LessThan(sum.Abs()):
			keep = actual.Abs()
		default:
			delete(e.short, connBase(conn, base))
			continue
		}
		if snap.Ts < last+shortfallMs {
			continue // too soon after a fill: the snapshot may predate it
		}
		cb := connBase(conn, base)
		sf, seen := e.short[cb]
		if !seen || !sf.held.Equal(sum) {
			e.short[cb] = shortfall{since: snap.Ts, held: sum}
			continue
		}
		if snap.Ts-sf.since < shortfallMs {
			continue
		}
		delete(e.short, cb)
		price := px(base)
		for _, k := range keys {
			p := e.ledger[k]
			newSize := p.size.Mul(keep).Div(sum.Abs())
			cut := newSize.Sub(p.size) // opposite sign of size
			if price.IsPositive() {
				p.applyFill(cut, price)
			} else {
				p.size = newSize
				if p.size.IsZero() {
					p.avgPx = decimal.Zero
				}
			}
			p.changedAt = now
			e.persistLedger(k, p)
			slog.Info("task ledger cut to account", "task", k.task, "base", base, "size", p.size)
		}
	}
}

// releaseLedger drops a stopped task's shares, booking them at the latest
// mark: the positions stay on the account but no longer belong to the task.
func (e *Engine) releaseLedger(task string) {
	e.ledgerMu.Lock()
	defer e.ledgerMu.Unlock()
	for k, p := range e.ledger {
		if k.task != task || p.size.IsZero() {
			continue
		}
		if px := e.markOf(k.conn, k.base); px.IsPositive() {
			p.applyFill(p.size.Neg(), px)
		} else {
			p.size, p.avgPx = decimal.Zero, decimal.Zero
		}
		p.changedAt = util.NowMs()
		e.persistLedger(k, p)
	}
}

// DropLedger forgets a deleted task.
func (e *Engine) DropLedger(ctx context.Context, task string) error {
	e.ledgerMu.Lock()
	for k := range e.ledger {
		if k.task == task {
			delete(e.ledger, k)
		}
	}
	e.ledgerMu.Unlock()
	return store.DeleteTaskLedger(ctx, e.DB, task)
}

// markOf is the latest mark price of a coin on an account (zero if not held).
func (e *Engine) markOf(conn, base string) decimal.Decimal {
	if s := e.LatestSnapshot(conn); s != nil {
		for _, p := range s.Positions {
			if p.Base == base && p.MarkPx.IsPositive() {
				return p.MarkPx
			}
		}
	}
	return decimal.Zero
}

// TaskPnl is a task's cumulative PnL from its own shares: realised plus
// unrealised at the latest account marks.
func (e *Engine) TaskPnl(task string) (pnl decimal.Decimal, ok bool) {
	e.ledgerMu.Lock()
	defer e.ledgerMu.Unlock()
	for k, p := range e.ledger {
		if k.task != task {
			continue
		}
		ok = true
		pnl = pnl.Add(p.realized)
		if !p.size.IsZero() {
			if px := e.markOf(k.conn, k.base); px.IsPositive() {
				pnl = pnl.Add(p.size.Mul(px.Sub(p.avgPx)))
			}
		}
	}
	return pnl, ok
}

// taskShares lists a task's open shares as positions for the UI, priced at the
// account's marks.
func (e *Engine) taskShares(task, conn, alias string, acct *model.AccountSnapshot) []PositionLive {
	out := []PositionLive{}
	for _, h := range e.heldOn(task, conn) {
		p := model.Position{Base: h.base, Symbol: h.base, Size: h.size, EntryPx: h.avgPx}
		if acct != nil {
			for _, ap := range acct.Positions {
				if ap.Base == h.base {
					p.Symbol, p.MarkPx, p.Leverage = ap.Symbol, ap.MarkPx, ap.Leverage
					break
				}
			}
		}
		if p.MarkPx.IsPositive() && p.EntryPx.IsPositive() {
			p.Upnl = p.Size.Mul(p.MarkPx.Sub(p.EntryPx))
		}
		out = append(out, newPositionLive(conn, alias, &p))
	}
	return out
}

// RecordTaskPnl samples every non-stopped task's ledger PnL (for ranges and
// daily sparklines).
func (e *Engine) RecordTaskPnl(ctx context.Context) {
	tasks, err := store.Tasks(ctx, e.DB)
	if err != nil {
		return
	}
	for _, t := range tasks {
		if t.Status == "stopped" {
			continue
		}
		if pnl, ok := e.TaskPnl(t.ID); ok {
			_ = store.InsertTaskPnl(ctx, e.DB, t.ID, pnl)
		}
	}
}

// closeSharesOn books every task's shares on an account closed after the
// whole account was flattened, at the marks of the snapshot taken before.
func (e *Engine) closeSharesOn(conn string, before *model.AccountSnapshot) {
	e.ledgerMu.Lock()
	defer e.ledgerMu.Unlock()
	for k, p := range e.ledger {
		if k.conn != conn || p.size.IsZero() {
			continue
		}
		px := decimal.Zero
		for _, ap := range before.Positions {
			if ap.Base == k.base {
				px = ap.MarkPx
			}
		}
		if px.IsPositive() {
			p.applyFill(p.size.Neg(), px)
		} else {
			p.size, p.avgPx = decimal.Zero, decimal.Zero
		}
		p.changedAt = util.NowMs()
		e.persistLedger(k, p)
	}
}
