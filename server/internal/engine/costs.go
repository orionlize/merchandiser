package engine

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/exchange"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

// Exact costs ("费用明细"): every minute, read each follower account's fills
// and funding from the venue and book them to the tasks they belong to.
// Fees go to the task whose order it was (matched by client id); funding is
// split between the tasks holding the coin on that account by their share.

type costCursor struct {
	Fills   int64 `json:"fills"`
	Funding int64 `json:"funding"`
}

const (
	// Fills are re-read for this long: an order row is written after the
	// venue call returns, so a fill can show up before its order does.
	costOverlapMs = 2 * 60_000
	// How far back fees are backfilled the first time an account is read.
	costBackfillMs = 7 * 86_400_000
	// Stopped tasks still get the costs of their last (closing) fills.
	costStoppedGraceMs = 60 * 60_000
)

func costCursorKey(conn string) string { return "cost_cursor:" + conn }

// costConnections lists the follower accounts of tasks that may still incur
// costs, with the ids of those tasks.
func (e *Engine) costConnections(ctx context.Context) (map[string][]string, error) {
	tasks, err := store.Tasks(ctx, e.DB)
	if err != nil {
		return nil, err
	}
	now := util.NowMs()
	out := map[string][]string{}
	for _, t := range tasks {
		if t.Status == "stopped" && (t.StoppedAt == nil || now-*t.StoppedAt > costStoppedGraceMs) {
			continue
		}
		fs, err := store.Followers(ctx, e.DB, t.ID)
		if err != nil {
			return nil, err
		}
		for _, f := range fs {
			out[f.ConnectionID] = append(out[f.ConnectionID], t.ID)
		}
	}
	return out, nil
}

// SyncCosts reads and books new fees and funding of every followed account.
func (e *Engine) SyncCosts(ctx context.Context) {
	conns, err := e.costConnections(ctx)
	if err != nil {
		slog.Warn("cost sync", "err", err)
		return
	}
	changed := false
	for conn := range conns {
		n, err := e.syncConnCosts(ctx, conn)
		if err != nil {
			slog.Debug("cost sync", "conn", conn, "err", err)
		}
		changed = changed || n > 0
	}
	if changed {
		e.Changed("costs")
	}
}

func (e *Engine) syncConnCosts(ctx context.Context, conn string) (int, error) {
	ex, err := e.Adapter(ctx, conn)
	if err != nil {
		return 0, err
	}
	cr, ok := ex.(exchange.CostReporter)
	if !ok {
		return 0, nil
	}
	m, err := e.Markets(ctx, ex)
	if err != nil {
		return 0, err
	}
	now := util.NowMs()
	cur := costCursor{Fills: now - costBackfillMs, Funding: now}
	if v, _ := store.GetSetting(ctx, e.DB, costCursorKey(conn)); v != nil {
		_ = json.Unmarshal([]byte(*v), &cur)
	}
	booked := 0
	fills, err := cr.FillsSince(ctx, m, cur.Fills)
	if err != nil {
		return 0, err
	}
	if len(fills) > 0 {
		orders, err := store.OrdersByClientID(ctx, e.DB, conn, cur.Fills-86_400_000)
		if err != nil {
			return 0, err
		}
		for i := range fills {
			if e.bookFee(ctx, conn, &fills[i], orders) {
				booked++
			}
		}
	}
	pays, err := cr.FundingSince(ctx, m, cur.Funding)
	if err != nil {
		return booked, err
	}
	for i := range pays {
		booked += e.bookFunding(ctx, conn, &pays[i])
	}
	next := costCursor{Fills: max(cur.Fills, now-costOverlapMs), Funding: max(cur.Funding, now-costOverlapMs)}
	if b, err := json.Marshal(next); err == nil {
		_ = store.SetSetting(ctx, e.DB, costCursorKey(conn), string(b))
	}
	return booked, nil
}

// bookFee records a fill's fee against the task whose order it was. Fills of
// orders we did not place (manual trades) belong to no task.
func (e *Engine) bookFee(ctx context.Context, conn string, f *exchange.Fill, orders map[string]store.OrderRef) bool {
	if f.ClientID == "" || f.Fee.IsZero() {
		return false
	}
	o, ok := orders[f.ClientID]
	if !ok {
		return false
	}
	var rate *string
	if n := f.Qty.Mul(f.Px); n.IsPositive() {
		rate = util.Ptr(util.Fmt(f.Fee.Div(n).RoundBank(8)))
	}
	maker := f.Maker
	row := &store.CostRow{
		TaskID: o.TaskID, ConnectionID: conn, Base: f.Base, Ts: f.Ts, Kind: "fee", Amount: util.Fmt(f.Fee.RoundBank(8)),
		Rate: rate, Qty: util.Ptr(util.Fmt(f.Qty)), Px: util.Ptr(util.Fmt(f.Px)), Maker: &maker, OrderID: &o.ID,
		Ref: "fee|" + conn + "|" + f.ID,
	}
	if f.Dir != "" {
		row.Dir = util.Ptr(f.Dir)
	}
	fresh, err := store.InsertCost(ctx, e.DB, row)
	if err != nil || !fresh {
		return false
	}
	_ = store.AddOrderFee(ctx, e.DB, o.ID, f.Fee)
	e.LedgerCost(o.TaskID, conn, f.Base, "fee", f.Fee, f.Ts)
	return true
}

// bookFunding splits one funding payment between the tasks holding the coin
// on the account on the same side, by their share of the charged position.
// Returns the number of tasks booked.
func (e *Engine) bookFunding(ctx context.Context, conn string, p *exchange.FundingPay) int {
	if p.Amount.IsZero() || p.Size.IsZero() {
		return 0
	}
	type share struct {
		task string
		size decimal.Decimal
	}
	var shares []share
	sum := decimal.Zero
	e.ledgerMu.Lock()
	for k, lp := range e.ledger {
		if k.conn == conn && k.base == p.Base && !lp.size.IsZero() && lp.size.Sign() == p.Size.Sign() {
			shares = append(shares, share{k.task, lp.size.Abs()})
			sum = sum.Add(lp.size.Abs())
		}
	}
	e.ledgerMu.Unlock()
	// The account may hold more than the tasks (manual positions): each task
	// pays for its own share only.
	base := util.MaxD(sum, p.Size.Abs())
	n := 0
	for _, s := range shares {
		amount := p.Amount.Mul(s.size).Div(base).RoundBank(8)
		if amount.IsZero() {
			continue
		}
		size := s.size.Mul(util.Signum(p.Size))
		row := &store.CostRow{
			TaskID: s.task, ConnectionID: conn, Base: p.Base, Ts: p.Ts, Kind: "funding", Amount: util.Fmt(amount),
			Rate: util.Ptr(util.Fmt(p.Rate)), Qty: util.Ptr(util.Fmt(size)), Ref: "funding|" + conn + "|" + p.ID + "|" + s.task,
		}
		fresh, err := store.InsertCost(ctx, e.DB, row)
		if err != nil || !fresh {
			continue
		}
		e.LedgerCost(s.task, conn, p.Base, "funding", amount, p.Ts)
		n++
	}
	return n
}

func (e *Engine) costLoop() {
	t := time.NewTicker(60 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-t.C:
			if e.Secrets == nil || !e.Secrets.Locked() {
				e.SyncCosts(e.ctx)
			}
		}
	}
}
