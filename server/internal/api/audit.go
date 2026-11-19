package api

import (
	"context"
	"database/sql"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

// Task deviation audit: one CSV row per (source signal, follower), pairing
// what the source did with what we did, so time, position share, price and
// return gaps can be checked against the venues by hand.
//
// Our side is replayed from this task's own fills (average cost), so a
// position the follower held before the task started is not included.

var hundred = decimal.NewFromInt(100)

// followerBook replays one follower's position in one coin.
type followerBook struct {
	pos, avg decimal.Decimal
}

// apply books a fill and returns the realised PnL in quote.
func (b *followerBook) apply(buy bool, qty, px decimal.Decimal) decimal.Decimal {
	d := qty
	if !buy {
		d = d.Neg()
	}
	realized := decimal.Zero
	if !b.pos.IsZero() && b.pos.Sign() != d.Sign() {
		closed := util.MinD(qty, b.pos.Abs())
		realized = px.Sub(b.avg).Mul(closed).Mul(util.Signum(b.pos))
		next := b.pos.Add(d)
		switch {
		case next.IsZero():
			b.avg = decimal.Zero
		case next.Sign() != b.pos.Sign():
			b.avg = px
		}
		b.pos = next
		return realized
	}
	next := b.pos.Add(d)
	if !next.IsZero() {
		b.avg = b.avg.Mul(b.pos.Abs()).Add(px.Mul(qty)).Div(next.Abs())
	}
	b.pos = next
	return realized
}

// auditGroup is our side of one signal on one follower.
type auditGroup struct {
	signalID   *int64
	conn       string
	base       string
	purpose    string
	firstTs    int64
	lastTs     int64
	buy        *bool
	before     decimal.Decimal
	avgBefore  decimal.Decimal
	after      decimal.Decimal
	qty        decimal.Decimal
	notional   decimal.Decimal
	realized   decimal.Decimal
	filled     bool
	statuses   []string
	reasons    []string
	orderCount int
}

func (g *auditGroup) vwap() decimal.Decimal {
	if g.qty.IsZero() {
		return decimal.Zero
	}
	return g.notional.Div(g.qty)
}

// changePct is the relative size change from `a` to `b`: blank for an open
// or a flip, −100 for a close.
func changePct(a, b decimal.Decimal) string {
	if a.IsZero() || (!b.IsZero() && a.Sign() != b.Sign()) {
		return ""
	}
	return pctStr(b.Abs().Sub(a.Abs()).Div(a.Abs()).Mul(hundred))
}

// returnPct is the price return of closing a `pos` held at `entry` at `px`.
func returnPct(pos, entry, px decimal.Decimal) *decimal.Decimal {
	if pos.IsZero() || !entry.IsPositive() || !px.IsPositive() {
		return nil
	}
	r := px.Sub(entry).Div(entry).Mul(hundred).Mul(util.Signum(pos))
	return &r
}

// reduces: whether going from a to b closes part of a.
func reduces(a, b decimal.Decimal) bool {
	return !a.IsZero() && (b.Abs().LessThan(a.Abs()) || a.Sign() != b.Sign())
}

func pctStr(d decimal.Decimal) string { return d.StringFixed(4) }

func pctP(d *decimal.Decimal) string {
	if d == nil {
		return ""
	}
	return pctStr(*d)
}

func decOrBlank(d decimal.Decimal) string {
	if d.IsZero() {
		return ""
	}
	return util.Fmt(d)
}

func fmtTs(ts int64) string {
	if ts == 0 {
		return ""
	}
	return time.UnixMilli(ts).Local().Format("2006-01-02 15:04:05.000")
}

func csvEsc(v string) string {
	if strings.ContainsAny(v, ",\"\n") {
		return `"` + strings.ReplaceAll(v, `"`, `""`) + `"`
	}
	return v
}

// equityAt is the follower's equity at the snapshot nearest before ts (else after).
func equityAt(ctx context.Context, db *sql.DB, conn string, ts int64) decimal.Decimal {
	var e string
	err := db.QueryRowContext(ctx, "SELECT equity FROM equity_snapshots WHERE connection_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1", conn, ts).Scan(&e)
	if err != nil {
		err = db.QueryRowContext(ctx, "SELECT equity FROM equity_snapshots WHERE connection_id = ? AND ts > ? ORDER BY ts ASC LIMIT 1", conn, ts).Scan(&e)
	}
	if err != nil {
		return decimal.Zero
	}
	return util.Dec(e)
}

var statusLabel = map[string]string{
	"filled": "已成交", "partial": "部分成交", "open": "未成交", "failed": "失败", "skipped": "跳过", "cancelled": "已撤",
}

var kindLabel = map[string]string{
	"open": "开仓", "add": "加仓", "reduce": "减仓", "close": "平仓", "flip": "反手",
}

var purposeLabel = map[string]string{
	"sync": "信号跟随", "mirror": "挂单镜像", "close": "平仓", "reconcile": "对账补单",
}

func exportTaskAudit(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		TaskID string `json:"task_id"`
		Range  string `json:"range"`
	}](body)
	if err != nil {
		return nil, err
	}
	db := s.E.DB
	task, err := store.Task(ctx, db, a.TaskID)
	if err != nil {
		return nil, err
	}
	if task == nil {
		return nil, errs.Msg("任务不存在")
	}
	since := rangeStart(a.Range)

	followers, err := store.Followers(ctx, db, a.TaskID)
	if err != nil {
		return nil, err
	}
	conns, err := store.Connections(ctx, db)
	if err != nil {
		return nil, err
	}
	alias := map[string]string{}
	for _, c := range conns {
		alias[c.ID] = c.Alias
	}

	sigs, err := store.Signals(ctx, db, "WHERE task_id = ? AND kind IN ('open','add','reduce','close','flip') ORDER BY ts, id", a.TaskID)
	if err != nil {
		return nil, err
	}
	// Every order from the start: the replay needs the full history.
	orders, err := store.Orders(ctx, db, "WHERE task_id = ? ORDER BY ts, id", a.TaskID)
	if err != nil {
		return nil, err
	}

	books := map[string]*followerBook{}
	groups := map[string]*auditGroup{}
	var loose []*auditGroup // orders with no signal, one row each
	for _, o := range orders {
		conn := ""
		if o.ConnectionID != nil {
			conn = *o.ConnectionID
		}
		var g *auditGroup
		if o.SignalID != nil {
			key := strconv.FormatInt(*o.SignalID, 10) + "|" + conn
			g = groups[key]
			if g == nil {
				g = &auditGroup{signalID: o.SignalID, conn: conn, base: o.Base, purpose: o.Purpose, firstTs: o.Ts}
				groups[key] = g
			}
		} else {
			g = &auditGroup{conn: conn, base: o.Base, purpose: o.Purpose, firstTs: o.Ts}
			loose = append(loose, g)
		}
		g.orderCount++
		g.lastTs = o.Ts
		g.statuses = append(g.statuses, o.Status)
		if o.Reason != nil && *o.Reason != "" {
			g.reasons = append(g.reasons, *o.Reason)
		}
		bk := books[conn+"|"+o.Base]
		if bk == nil {
			bk = &followerBook{}
			books[conn+"|"+o.Base] = bk
		}
		if !g.filled {
			g.before, g.avgBefore, g.after = bk.pos, bk.avg, bk.pos
		}
		if o.Buy == nil || o.FillQty == nil || o.FillPx == nil {
			continue
		}
		q, px := util.Dec(*o.FillQty), util.Dec(*o.FillPx)
		if !q.IsPositive() || !px.IsPositive() {
			continue
		}
		g.filled = true
		g.buy = o.Buy
		g.qty = g.qty.Add(q)
		g.notional = g.notional.Add(q.Mul(px))
		g.realized = g.realized.Add(bk.apply(*o.Buy, q, px))
		g.after = bk.pos
	}

	var b strings.Builder
	b.WriteString("\ufeff")
	header := []string{
		"信号ID", "品种", "源动作", "跟单账户", "用途", "我方状态", "原因",
		"源成交时间", "信号检测时间", "我方成交时间", "检测延迟(ms)", "时间偏差(ms)",
		"源仓位前", "源仓位后", "我方仓位前", "我方仓位后", "我方方向", "我方成交量",
		"源变动比例%", "我方变动比例%", "变动比例偏差(pp)",
		"源权益", "我方权益", "源仓位占权益%", "我方仓位占权益%", "占比偏差(pp)",
		"源成交价", "我方成交均价", "价格偏差%(正=我方不利)",
		"源持仓均价(变动前)", "我方持仓均价(变动前)", "源收益率%", "我方收益率%", "收益率偏差(pp)",
		"源已实现盈亏", "我方已实现盈亏", "源数据口径",
	}
	b.WriteString(strings.Join(header, ","))
	b.WriteByte('\n')
	type line struct {
		ts   int64
		cols []string
	}
	var lines []line
	// Rows sort by the source's time, else ours.
	var at int64
	write := func(cols []string) { lines = append(lines, line{at, cols}) }

	ourCols := func(g *auditGroup) (status, reason, ts, dir, qty, vwap string) {
		if g == nil {
			return "无订单", "", "", "", "", ""
		}
		seen := map[string]bool{}
		var ss []string
		for _, st := range g.statuses {
			l := statusLabel[st]
			if l == "" {
				l = st
			}
			if !seen[l] {
				seen[l] = true
				ss = append(ss, l)
			}
		}
		status = strings.Join(ss, "/")
		reason = strings.Join(g.reasons, "；")
		if g.filled {
			ts = fmtTs(g.lastTs)
			dir = "卖"
			if *g.buy {
				dir = "买"
			}
			qty = util.Fmt(g.qty)
			vwap = util.Fmt(g.vwap())
		}
		return
	}

	for _, sg := range sigs {
		srcFrom, srcTo := util.DecP(sg.FromSize), util.DecP(sg.ToSize)
		srcPx, srcEntry, srcEq := util.DecP(sg.SrcPx), util.DecP(sg.SrcEntry), util.DecP(sg.SrcEquity)
		srcTs := sg.Ts
		if sg.SrcTs != nil && *sg.SrcTs > 0 {
			srcTs = *sg.SrcTs
		}
		if max(srcTs, sg.Ts) < since {
			continue
		}
		basis := "持仓推算"
		if sg.SrcBasis == nil {
			basis = "旧数据(无源价格)"
		} else if *sg.SrcBasis == "fills" {
			basis = "源成交记录"
		}
		srcChange := changePct(srcFrom, srcTo)
		var srcShare *decimal.Decimal
		if srcEq.IsPositive() && srcPx.IsPositive() {
			v := srcTo.Abs().Mul(srcPx).Div(srcEq).Mul(hundred)
			srcShare = &v
		}
		var srcRet *decimal.Decimal
		if reduces(srcFrom, srcTo) {
			srcRet = returnPct(srcFrom, srcEntry, srcPx)
		}
		srcRealized := ""
		if sg.SrcRealized != nil {
			srcRealized = *sg.SrcRealized
		} else if reduces(srcFrom, srcTo) && srcEntry.IsPositive() && srcPx.IsPositive() {
			closed := util.MinD(srcFrom.Abs(), srcFrom.Sub(srcTo).Abs())
			srcRealized = util.Fmt(srcPx.Sub(srcEntry).Mul(closed).Mul(util.Signum(srcFrom)).Round(4))
		}

		at = srcTs
		for _, f := range followers {
			g := groups[strconv.FormatInt(sg.ID, 10)+"|"+f.ConnectionID]
			status, reason, ourTs, dir, qty, vwap := ourCols(g)
			detect := strconv.FormatInt(sg.Ts-srcTs, 10)
			purpose := ""
			var timeGap, ourBefore, ourAfter, ourChange, changeGap, ourEq, ourShareS, shareGap, pxGap, ourAvg, ourRetS, retGap, ourRealized string
			if g != nil {
				purpose = purposeLabel[g.purpose]
				ourBefore, ourAfter = util.Fmt(g.before), util.Fmt(g.after)
			}
			if g != nil && g.filled {
				timeGap = strconv.FormatInt(g.lastTs-srcTs, 10)
				ourChange = changePct(g.before, g.after)
				if ourChange != "" && srcChange != "" {
					changeGap = pctStr(util.Dec(ourChange).Sub(util.Dec(srcChange)))
				}
				eq := equityAt(ctx, db, g.conn, g.lastTs)
				ourEq = decOrBlank(eq)
				if eq.IsPositive() {
					share := g.after.Abs().Mul(g.vwap()).Div(eq).Mul(hundred)
					ourShareS = pctStr(share)
					if srcShare != nil {
						shareGap = pctStr(share.Sub(*srcShare))
					}
				}
				if srcPx.IsPositive() {
					gap := g.vwap().Sub(srcPx).Div(srcPx).Mul(hundred)
					if !*g.buy {
						gap = gap.Neg()
					}
					pxGap = pctStr(gap)
				}
				ourAvg = decOrBlank(g.avgBefore)
				if reduces(g.before, g.after) {
					r := returnPct(g.before, g.avgBefore, g.vwap())
					ourRetS = pctP(r)
					if r != nil && srcRet != nil {
						retGap = pctStr(r.Sub(*srcRet))
					}
					ourRealized = util.Fmt(g.realized.Round(4))
				}
			}
			write([]string{
				strconv.FormatInt(sg.ID, 10), sg.Base, kindLabel[sg.Kind], alias[f.ConnectionID], purpose, status, reason,
				fmtTs(srcTs), fmtTs(sg.Ts), ourTs, detect, timeGap,
				util.Fmt(srcFrom), util.Fmt(srcTo), ourBefore, ourAfter, dir, qty,
				srcChange, ourChange, changeGap,
				decOrBlank(srcEq), ourEq, pctP(srcShare), ourShareS, shareGap,
				decOrBlank(srcPx), vwap, pxGap,
				decOrBlank(srcEntry), ourAvg, pctP(srcRet), ourRetS, retGap,
				srcRealized, ourRealized, basis,
			})
		}
	}

	// Orders not tied to a signal (reconcile top-ups, mirrors, stop-close):
	// listed so the replayed totals add up; no source side to compare.
	for _, g := range loose {
		if !g.filled || g.lastTs < since {
			continue
		}
		at = g.lastTs
		status, reason, ourTs, dir, qty, vwap := ourCols(g)
		ourEq, ourShareS, ourRetS, ourRealized := "", "", "", ""
		eq := equityAt(ctx, db, g.conn, g.lastTs)
		ourEq = decOrBlank(eq)
		if eq.IsPositive() {
			ourShareS = pctStr(g.after.Abs().Mul(g.vwap()).Div(eq).Mul(hundred))
		}
		if reduces(g.before, g.after) {
			ourRetS = pctP(returnPct(g.before, g.avgBefore, g.vwap()))
			ourRealized = util.Fmt(g.realized.Round(4))
		}
		write([]string{
			"", g.base, "", alias[g.conn], purposeLabel[g.purpose], status, reason,
			"", "", ourTs, "", "",
			"", "", util.Fmt(g.before), util.Fmt(g.after), dir, qty,
			"", changePct(g.before, g.after), "",
			"", ourEq, "", ourShareS, "",
			"", vwap, "",
			"", decOrBlank(g.avgBefore), "", ourRetS, "",
			"", ourRealized, "无源信号",
		})
	}

	sort.SliceStable(lines, func(i, j int) bool { return lines[i].ts < lines[j].ts })
	for _, l := range lines {
		for i, c := range l.cols {
			l.cols[i] = csvEsc(c)
		}
		b.WriteString(strings.Join(l.cols, ","))
		b.WriteByte('\n')
	}
	return map[string]any{"csv": b.String(), "rows": len(lines), "name": task.Name}, nil
}
