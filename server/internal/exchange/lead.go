package exchange

// Exchange lead traders (copy-trading squares) as read-only signal sources.
//
// Only public data is used, so only positions are available: no open
// orders, no fills. Verified venues:
//   - OKX: official public endpoints `/api/v5/copytrading/public-*`.
//     Positions come as sub-positions in contracts; the trader's own equity
//     is not exposed, so equity is reported as 0 (equity-ratio sizing is
//     refused).
//   - Binance: the website's `bapi` copy-trade endpoints (unofficial). Sizes
//     are in venue units; `marginBalance` is the trader's equity. Traders can
//     hide positions, which we treat as an error, never as "flat". Their
//     fills stay public, so a source may instead run in `fills` mode, which
//     reconstructs positions from the public trade history, about the last
//     two months (see leadfills.go, leadbackfill.go); that feed is ~2 minutes
//     behind the trader. A fills source polls that history either on a timer
//     or, in trigger mode, only when the trader's `lastTradeTime` moves.
//   - Gate: its web endpoints sit behind a bot wall, so it is not supported.
//
// Snapshots are cached per trader for a few seconds and shared by every task
// and view, so many tasks on one trader cost one request.

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/util"
)

const (
	okxCopy = "https://www.okx.com/api/v5/copytrading"
	bnCopy  = "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade"
)

// rawPos is one position as the venue reports it (sizes in venue units, signed).
type rawPos struct {
	symbol string
	// Settlement asset when the feed names it (Binance `collateral`).
	quote    string
	units    decimal.Decimal
	entry    decimal.Decimal
	mark     decimal.Decimal
	leverage *decimal.Decimal
	upnl     decimal.Decimal
}

type rawSnap struct {
	equity    decimal.Decimal
	positions []rawPos
	// Symbol → fill totals (fills mode only).
	trades map[string]model.TradeCum
}

type cachedRaw struct {
	at  time.Time
	raw rawSnap
}

type fillBook struct {
	mu     sync.Mutex
	state  *FillState
	cached *cachedRaw
	// Trigger mode: watch the trader's lastTradeTime (a cheap GET outside the
	// POST "system busy" budget) and read the trade history only when it
	// moves, plus a slow safety poll.
	trigger atomic.Bool
	// Last trade-history read.
	polledAt time.Time
	// lastTradeTime the fills have caught up with.
	seenTrade int64
	// When lastTradeTime first ran ahead of the fills, while it still does.
	pendingSince time.Time
	ordersMu     sync.Mutex
	orders       *cachedOrders
}

type cachedOrders struct {
	at    time.Time
	trade int64
	list  []LeadOrder
}

const (
	// Interval mode: read the trade history this often.
	fillsPollEvery = 6 * time.Second
	// Trigger mode: check lastTradeTime this often.
	triggerCheckEvery = 2 * time.Second
	// Trigger mode: read the trade history at least this often anyway.
	triggerSafetyPoll = 30 * time.Second
	// lastTradeTime runs ~1 s after the fill time it reports.
	tradeSlackMs = 10_000
	// Stop chasing a lastTradeTime the trade history never shows.
	triggerPendingMax = 3 * time.Minute
)

// SetFillsTrigger switches a fills source between interval polling and
// trigger mode; running tasks pick it up on their next snapshot.
func SetFillsTrigger(sourceID string, on bool) {
	b := bookOf(sourceID)
	if b.trigger.Swap(on) != on {
		b.mu.Lock()
		b.cached = nil
		b.mu.Unlock()
	}
}

type leadCache struct {
	snapMu  sync.Mutex // held across a fetch so concurrent callers wait for one request
	snaps   map[string]cachedRaw
	detMu   sync.Mutex
	details map[string]struct {
		at time.Time
		v  util.J
	}
	okxBucket *TokenBucket
	bnBucket  *TokenBucket
	// Binance trade history answers "system busy" when polled fast.
	bnFillsBucket *TokenBucket
	booksMu       sync.Mutex
	books         map[string]*fillBook
	// Source id → history backfill job (see leadbackfill.go).
	backfills map[string]*Backfill
	// Binance mark prices by symbol, for reconstructed positions.
	marksMu sync.Mutex
	marks   map[string]decimal.Decimal
	marksAt time.Time
}

var lc = &leadCache{
	snaps: map[string]cachedRaw{},
	details: map[string]struct {
		at time.Time
		v  util.J
	}{},
	okxBucket: NewBucket(4, 2*time.Second),
	bnBucket:  NewBucket(10, 10*time.Second),
	// Strictly one request per 3 s (measured: faster gets "system busy").
	bnFillsBucket: NewBucket(1, 3*time.Second),
	books:         map[string]*fillBook{},
	backfills:     map[string]*Backfill{},
}

// ForgetFills drops a source's in-memory fill book (after it is deleted).
func ForgetFills(sourceID string) {
	lc.booksMu.Lock()
	delete(lc.books, sourceID)
	delete(lc.backfills, sourceID)
	lc.booksMu.Unlock()
}

func leadTTL(p model.Platform) time.Duration {
	if p == model.Binance {
		return 4 * time.Second
	}
	return 2 * time.Second
}

func LeadSupported(p model.Platform) bool { return p == model.Okx || p == model.Binance }

func isAlnum(c rune) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func allOf(s string, f func(rune) bool) bool {
	for _, c := range s {
		if !f(c) {
			return false
		}
	}
	return true
}

func isDigit(c rune) bool { return c >= '0' && c <= '9' }
func isHex(c rune) bool   { return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') }

// ParseLeadID pulls a trader id out of a pasted profile link or bare id.
func ParseLeadID(p model.Platform, input string) (string, bool) {
	tokens := strings.FieldsFunc(strings.TrimSpace(input), func(c rune) bool { return !isAlnum(c) })
	found := ""
	for _, t := range tokens {
		switch p {
		case model.Okx:
			// OKX unique codes: 16 hex chars, or long numeric ids.
			if (len(t) == 16 && allOf(t, isHex)) || (len(t) >= 15 && allOf(t, isDigit)) {
				found = strings.ToUpper(t)
			}
		case model.Binance:
			// Binance portfolio ids: long numbers.
			if len(t) >= 15 && allOf(t, isDigit) {
				found = t
			}
		}
	}
	return found, found != ""
}

func LeadProfileURL(p model.Platform, id string) *string {
	switch p {
	case model.Okx:
		return util.Ptr("https://www.okx.com/copy-trading/account/" + id + "?tab=swap")
	case model.Binance:
		return util.Ptr("https://www.binance.com/copy-trading/lead-details/" + id)
	}
	return nil
}

type fillsSrc struct {
	sourceID string
	db       *sql.DB
	anchor   int64
}

type LeadTrader struct {
	venue  model.Platform
	id     string
	client *http.Client
	// Public client of the venue for contracts and prices.
	public Exchange
	// Set in `fills` mode.
	fills *fillsSrc
}

// LeadProbe is what a trader exposes, checked before adding them.
type LeadProbe struct {
	Platform        model.Platform `json:"platform"`
	ID              string         `json:"id"`
	Nickname        string         `json:"nickname"`
	PositionsPublic bool           `json:"positions_public"`
	FillsPublic     bool           `json:"fills_public"`
	LastFillMs      *int64         `json:"last_fill_ms"`
	Equity          *string        `json:"equity"`
}

func NewLeadTrader(venue model.Platform, id, proxy string) (*LeadTrader, error) {
	if !LeadSupported(venue) {
		return nil, errs.Msg("%s 带单员暂不支持", venue.Label())
	}
	pid, ok := ParseLeadID(venue, id)
	if !ok {
		return nil, errs.Msg("带单员 ID 格式不正确")
	}
	dummy := model.Credentials{Passphrase: util.Ptr("-")}
	var pub Exchange
	var err error
	if venue == model.Okx {
		pub, err = NewOkx(dummy, false, proxy)
	} else {
		pub, err = NewBinance(dummy, false, proxy)
	}
	if err != nil {
		return nil, err
	}
	c, err := Client(proxy)
	if err != nil {
		return nil, err
	}
	return &LeadTrader{venue: venue, id: pid, client: c, public: pub}, nil
}

// WithFills follows by reconstructing positions from fills (Binance only).
// trigger selects how the trade history is polled (see fillBook).
func (l *LeadTrader) WithFills(sourceID string, db *sql.DB, anchor int64, trigger bool) (*LeadTrader, error) {
	if l.venue != model.Binance {
		return nil, errs.Msg("只有币安带单员支持按成交记录推算")
	}
	l.fills = &fillsSrc{sourceID: sourceID, db: db, anchor: anchor}
	SetFillsTrigger(sourceID, trigger)
	return l, nil
}

func (l *LeadTrader) Probe(ctx context.Context) (*LeadProbe, error) {
	if l.venue == model.Binance {
		d, err := l.bnDetail(ctx)
		if err != nil {
			return nil, err
		}
		page, err := l.bnFillsPage(ctx, 1)
		if err != nil {
			return nil, err
		}
		p := &LeadProbe{Platform: l.venue, ID: l.id, Nickname: d.JStr("nickname"), PositionsPublic: d.Get("positionShow").BoolOr(false), FillsPublic: len(page) > 0}
		if len(page) > 0 {
			t := page[0].Time
			p.LastFillMs = &t
		}
		if e := d.JStr("marginBalance"); e != "" {
			p.Equity = &e
		}
		return p, nil
	}
	if _, err := l.fetchOkx(ctx); err != nil {
		return nil, err
	}
	return &LeadProbe{Platform: l.venue, ID: l.id, Nickname: l.id, PositionsPublic: true}, nil
}

func (l *LeadTrader) fetch(ctx context.Context) (rawSnap, error) {
	if l.fills != nil {
		return l.fetchFills(ctx)
	}
	key := string(l.venue) + "|" + l.id
	lc.snapMu.Lock()
	defer lc.snapMu.Unlock()
	if c, ok := lc.snaps[key]; ok && time.Since(c.at) < leadTTL(l.venue) {
		return c.raw, nil
	}
	var raw rawSnap
	var err error
	if l.venue == model.Okx {
		raw, err = l.fetchOkx(ctx)
	} else {
		raw, err = l.fetchBinance(ctx)
	}
	if err != nil {
		return raw, err
	}
	lc.snaps[key] = cachedRaw{time.Now(), raw}
	return raw, nil
}

func (l *LeadTrader) okxGet(ctx context.Context, path string, q url.Values) (util.J, error) {
	if err := lc.okxBucket.Acquire(ctx, 1, false); err != nil {
		return util.J{}, err
	}
	req, err := newReq(ctx, http.MethodGet, okxCopy+"/"+path+"?"+q.Encode(), "")
	if err != nil {
		return util.J{}, err
	}
	v, err := SendJSON(l.client, model.Okx, req)
	if err != nil {
		return v, err
	}
	code := v.JStr("code")
	if code != "0" {
		if code == "50011" {
			return v, &errs.RateLimited{Msg: "OKX 带单接口限频"}
		}
		msg := "OKX " + code + " " + v.JStr("msg")
		if code == "59269" {
			msg = "该 OKX 带单员不存在或已停止带单"
		}
		return v, &errs.Exchange{Code: code, Msg: msg}
	}
	return v, nil
}

func (l *LeadTrader) fetchOkx(ctx context.Context) (rawSnap, error) {
	var positions []rawPos
	after := ""
	// Sub-positions are paged 100 at a time, newest first.
	for range 10 {
		q := url.Values{"instType": {"SWAP"}, "uniqueCode": {l.id}, "limit": {"100"}}
		if after != "" {
			q.Set("after", after)
		}
		v, err := l.okxGet(ctx, "public-current-subpositions", q)
		if err != nil {
			return rawSnap{}, err
		}
		rows := v.Get("data").Arr()
		for _, p := range rows {
			units := p.JDec("subPos")
			switch p.JStr("posSide") {
			case "short":
				units = units.Abs().Neg()
			case "long":
				units = units.Abs()
			}
			positions = append(positions, rawPos{symbol: p.JStr("instId"), units: units, entry: p.JDec("openAvgPx"), mark: p.JDec("markPx"), leverage: decPtr(p.JDec("lever")), upnl: p.JDec("upl")})
		}
		if len(rows) < 100 {
			break
		}
		after = rows[len(rows)-1].JStr("subPosId")
	}
	return rawSnap{equity: decimal.Zero, positions: positions}, nil
}

func (l *LeadTrader) bnGet(ctx context.Context, path string) (util.J, error) {
	if err := lc.bnBucket.Acquire(ctx, 1, false); err != nil {
		return util.J{}, err
	}
	req, err := newReq(ctx, http.MethodGet, bnCopy+"/"+path, "")
	if err != nil {
		return util.J{}, err
	}
	v, err := SendJSON(l.client, model.Binance, req)
	if err != nil {
		return v, err
	}
	if !v.Get("success").BoolOr(false) {
		msg, ok := v.Get("message").AsStr()
		if !ok {
			msg = "请求失败"
		}
		return v, &errs.Exchange{Code: v.JStr("code"), Msg: "币安带单：" + msg}
	}
	return v.Get("data"), nil
}

func (l *LeadTrader) bnDetail(ctx context.Context) (util.J, error) {
	return l.bnDetailAge(ctx, time.Minute)
}

// bnDetailAge returns the portfolio detail, at most maxAge old.
func (l *LeadTrader) bnDetailAge(ctx context.Context, maxAge time.Duration) (util.J, error) {
	lc.detMu.Lock()
	defer lc.detMu.Unlock()
	if d, ok := lc.details[l.id]; ok && time.Since(d.at) < maxAge {
		return d.v, nil
	}
	v, err := l.bnGet(ctx, "lead-portfolio/detail?portfolioId="+l.id)
	if err != nil {
		return v, err
	}
	lc.details[l.id] = struct {
		at time.Time
		v  util.J
	}{time.Now(), v}
	return v, nil
}

func (l *LeadTrader) fetchBinance(ctx context.Context) (rawSnap, error) {
	d, err := l.bnDetail(ctx)
	if err != nil {
		return rawSnap{}, err
	}
	if !d.Get("positionShow").BoolOr(false) {
		return rawSnap{}, errs.Msg("该币安带单员未公开持仓，无法跟随")
	}
	equity := d.JDec("marginBalance")
	if !equity.IsPositive() {
		return rawSnap{}, errs.Msg("无法读取币安带单员权益")
	}
	v, err := l.bnGet(ctx, "lead-data/positions?portfolioId="+l.id)
	if err != nil {
		return rawSnap{}, err
	}
	rows := v.Arr()
	// A public portfolio lists every symbol (mostly zero). An empty list
	// means visibility changed; never read it as "all flat".
	if len(rows) == 0 {
		return rawSnap{}, errs.Msg("币安带单员持仓暂不可见")
	}
	var positions []rawPos
	for _, p := range rows {
		units := p.JDec("positionAmount")
		if units.IsZero() {
			continue
		}
		switch p.JStr("positionSide") {
		case "SHORT":
			units = units.Abs().Neg()
		case "LONG":
			units = units.Abs()
		}
		positions = append(positions, rawPos{symbol: p.JStr("symbol"), quote: p.JStr("collateral"), units: units, entry: p.JDec("entryPrice"), mark: p.JDec("markPrice"), leverage: decPtr(p.JDec("leverage")), upnl: p.JDec("unrealizedProfit")})
	}
	return rawSnap{equity: equity, positions: positions}, nil
}

// bnFillsPage returns one page (newest first) of the public trade history.
func (l *LeadTrader) bnFillsPage(ctx context.Context, page int) ([]Fill, error) {
	f, err := l.bnFillsPageOnce(ctx, page)
	if errs.IsRateLimited(err) {
		return l.bnFillsPageOnce(ctx, page)
	}
	return f, err
}

func (l *LeadTrader) bnFillsPageOnce(ctx context.Context, page int) ([]Fill, error) {
	f, _, err := l.bnFillsPageSized(ctx, page, 50)
	return f, err
}

// bnFillsPageSized returns one page and the venue's total fill count.
// The venue caps pageSize at 200.
func (l *LeadTrader) bnFillsPageSized(ctx context.Context, page, size int) ([]Fill, int64, error) {
	// High priority = no reserve: a 1-token bucket would otherwise never fill.
	if err := lc.bnFillsBucket.Acquire(ctx, 1, true); err != nil {
		return nil, 0, err
	}
	body, _ := json.Marshal(map[string]any{"pageNumber": page, "pageSize": size, "portfolioId": l.id})
	req, err := newReq(ctx, http.MethodPost, bnCopy+"/lead-portfolio/trade-history", string(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	v, err := SendJSON(l.client, model.Binance, req)
	if err != nil {
		return nil, 0, err
	}
	if !v.Get("success").BoolOr(false) {
		if v.JStr("code") == "11012005" {
			return nil, 0, &errs.RateLimited{Msg: "币安成交记录接口繁忙"}
		}
		msg, ok := v.Get("message").AsStr()
		if !ok {
			msg = "请求失败"
		}
		return nil, 0, &errs.Exchange{Code: v.JStr("code"), Msg: "币安带单：" + msg}
	}
	var out []Fill
	for _, x := range v.Get("data").Get("list").Arr() {
		if f := ParseFill(x); f != nil {
			out = append(out, *f)
		}
	}
	total, _ := v.Get("data").Get("total").Int()
	return out, total, nil
}

func (l *LeadTrader) fetchFills(ctx context.Context) (rawSnap, error) {
	fs := l.fills
	b := bookOf(fs.sourceID)
	// One poll per source at a time; others reuse the result.
	b.mu.Lock()
	defer b.mu.Unlock()
	trigger := b.trigger.Load()
	ttl, detailAge := fillsPollEvery, time.Minute
	if trigger {
		ttl, detailAge = triggerCheckEvery, triggerCheckEvery
	}
	if b.cached != nil && time.Since(b.cached.at) < ttl {
		return b.cached.raw, nil
	}
	if bf := backfillOf(fs.sourceID); bf != nil && bf.Running {
		return rawSnap{}, errs.Msg("正在从历史成交重建仓位，请稍候")
	}
	if b.state == nil {
		var j string
		err := fs.db.QueryRowContext(ctx, "SELECT json FROM lead_fill_state WHERE source_id = ?", fs.sourceID).Scan(&j)
		switch {
		case err == sql.ErrNoRows:
			b.state = NewFillState(fs.anchor)
		case err != nil:
			return rawSnap{}, err
		default:
			st := &FillState{}
			if err := json.Unmarshal([]byte(j), st); err != nil {
				return rawSnap{}, err
			}
			st.init()
			b.state = st
		}
	}
	d, err := l.bnDetailAge(ctx, detailAge)
	if err != nil {
		return rawSnap{}, err
	}
	equity := d.JDec("marginBalance")
	if !equity.IsPositive() {
		return rawSnap{}, errs.Msg("无法读取币安带单员权益")
	}
	st := b.state
	poll := true
	var lastTrade int64
	if trigger {
		lastTrade, _ = d.Get("lastTradeTime").Int()
		poll = b.needPoll(lastTrade)
	}
	if poll {
		if err := l.pollFills(ctx, st); err != nil {
			return rawSnap{}, err
		}
		b.polledAt = time.Now()
		if trigger {
			b.afterPoll(st, lastTrade)
		}
	}
	raw := l.reconRaw(ctx, st, equity)
	b.cached = &cachedRaw{time.Now(), raw}
	return raw, nil
}

// needPoll: whether trigger mode should read the trade history now.
func (b *fillBook) needPoll(lastTrade int64) bool {
	switch {
	case lastTrade <= 0:
		// The venue stopped reporting it: fall back to interval polling.
		return time.Since(b.polledAt) >= fillsPollEvery
	case b.polledAt.IsZero(), time.Since(b.polledAt) >= triggerSafetyPoll:
		return true
	}
	return lastTrade != b.seenTrade
}

// afterPoll records whether the fills have caught up with lastTradeTime.
// Until they do, needPoll keeps answering yes (the trade-history bucket
// spaces those reads 3 s apart).
func (b *fillBook) afterPoll(st *FillState, lastTrade int64) {
	switch {
	case lastTrade <= 0 || lastTrade == b.seenTrade:
	case st.LastTs >= lastTrade-tradeSlackMs:
		b.seenTrade = lastTrade
	default:
		if b.pendingSince.IsZero() {
			b.pendingSince = time.Now()
		}
		if time.Since(b.pendingSince) < triggerPendingMax {
			return
		}
		slog.Warn("binance lead trader: lastTradeTime never showed up in the trade history", "last_trade", lastTrade)
		b.seenTrade = lastTrade
	}
	b.pendingSince = time.Time{}
}

// pollFills reads the trade history back to fills already processed and
// applies the new ones.
func (l *LeadTrader) pollFills(ctx context.Context, st *FillState) error {
	fs := l.fills
	var fills []Fill
	for page := 1; page <= 40; page++ {
		p, err := l.bnFillsPage(ctx, page)
		if err != nil {
			return err
		}
		if page == 1 && len(p) == 0 {
			return errs.Msg("币安带单员成交记录不可见")
		}
		done := len(p) < 50 || st.PageReachesKnown(p)
		fills = append(fills, p...)
		if done {
			break
		}
		if page == 40 {
			return errs.Msg("币安带单员短时间成交过多，无法确认是否漏单")
		}
	}
	beforeTs, beforeLen := st.LastTs, len(st.Window)
	applied := st.Ingest(fills)
	if applied > 0 || st.LastTs != beforeTs || len(st.Window) != beforeLen {
		j, err := json.Marshal(st)
		if err != nil {
			return err
		}
		if _, err := fs.db.ExecContext(ctx, "INSERT INTO lead_fill_state (source_id, json) VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET json = excluded.json", fs.sourceID, string(j)); err != nil {
			return err
		}
	}
	return nil
}

// reconRaw prices the reconstructed positions at the live mark.
func (l *LeadTrader) reconRaw(ctx context.Context, st *FillState, equity decimal.Decimal) rawSnap {
	recon := st.Positions()
	// The trader's last fill price can be days old; prefer the live mark.
	var marks map[string]decimal.Decimal
	if len(recon) > 0 {
		marks = l.bnMarks(ctx)
	}
	var positions []rawPos
	for _, p := range recon {
		mark := p.LastPx
		if m, ok := marks[p.Symbol]; ok && m.IsPositive() {
			mark = m
		}
		positions = append(positions, rawPos{symbol: p.Symbol, units: p.Qty, entry: p.Entry, mark: mark, upnl: mark.Sub(p.Entry).Mul(p.Qty)})
	}
	trades := make(map[string]model.TradeCum, len(st.Cum))
	for sym, c := range st.Cum {
		trades[sym] = *c
	}
	return rawSnap{equity: equity, positions: positions, trades: trades}
}

// LeadOrder is one order from a Binance lead trader's public order history.
type LeadOrder struct {
	Time    int64           `json:"time"`
	Symbol  string          `json:"symbol"`
	Buy     bool            `json:"buy"`
	PosSide string          `json:"pos_side"` // LONG / SHORT / BOTH
	Type    string          `json:"type"`     // MARKET / LIMIT / ...
	Qty     decimal.Decimal `json:"qty"`
	AvgPx   decimal.Decimal `json:"avg_px"`
	Pnl     decimal.Decimal `json:"pnl"`
}

// LastTrade is the trader's lastTradeTime as last read (ms), if known.
func (l *LeadTrader) LastTrade(ctx context.Context) *int64 {
	if l.venue != model.Binance {
		return nil
	}
	d, err := l.bnDetail(ctx)
	if err != nil {
		return nil
	}
	if t, ok := d.Get("lastTradeTime").Int(); ok && t > 0 {
		return &t
	}
	return nil
}

// RecentOrders returns the newest orders of a Binance lead trader. It shares
// the trade history's request budget, so it is cached: refreshed at most
// every 10 s, and kept up to a minute while lastTradeTime stays put.
func (l *LeadTrader) RecentOrders(ctx context.Context, sourceID string) ([]LeadOrder, error) {
	if l.venue != model.Binance {
		return nil, errs.Msg("只有币安带单员公开订单记录")
	}
	var trade int64
	if t := l.LastTrade(ctx); t != nil {
		trade = *t
	}
	b := bookOf(sourceID)
	b.ordersMu.Lock()
	defer b.ordersMu.Unlock()
	if c := b.orders; c != nil {
		age := time.Since(c.at)
		if age < 10*time.Second || (c.trade == trade && trade > 0 && age < time.Minute) {
			return c.list, nil
		}
	}
	if err := lc.bnFillsBucket.Acquire(ctx, 1, true); err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]any{"pageNumber": 1, "pageSize": 20, "portfolioId": l.id})
	req, err := newReq(ctx, http.MethodPost, bnCopy+"/lead-portfolio/order-history", string(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	v, err := SendJSON(l.client, model.Binance, req)
	if err != nil {
		return nil, err
	}
	if !v.Get("success").BoolOr(false) {
		if v.JStr("code") == "11012005" {
			return nil, &errs.RateLimited{Msg: "币安订单记录接口繁忙"}
		}
		msg, ok := v.Get("message").AsStr()
		if !ok {
			msg = "请求失败"
		}
		return nil, &errs.Exchange{Code: v.JStr("code"), Msg: "币安带单：" + msg}
	}
	out := []LeadOrder{}
	for _, x := range v.Get("data").Get("list").Arr() {
		t, ok := x.Get("orderTime").Int()
		if !ok {
			continue
		}
		ps := x.JStr("positionSide")
		if ps != "LONG" && ps != "SHORT" {
			ps = "BOTH"
		}
		out = append(out, LeadOrder{Time: t, Symbol: x.JStr("symbol"), Buy: x.JStr("side") == "BUY", PosSide: ps, Type: x.JStr("type"), Qty: x.JDec("executedQty"), AvgPx: x.JDec("avgPrice"), Pnl: x.JDec("totalPnl")})
	}
	b.orders = &cachedOrders{at: time.Now(), trade: trade, list: out}
	return out, nil
}

// bnMarks returns live mark prices by symbol, or nil when unreachable.
// Served from www.binance.com, which answers where fapi.binance.com is
// geo-blocked. One request covers every symbol; shared for a few seconds.
func (l *LeadTrader) bnMarks(ctx context.Context) map[string]decimal.Decimal {
	lc.marksMu.Lock()
	defer lc.marksMu.Unlock()
	if lc.marks != nil && time.Since(lc.marksAt) < 5*time.Second {
		return lc.marks
	}
	req, err := newReq(ctx, http.MethodGet, "https://www.binance.com/fapi/v1/premiumIndex", "")
	if err != nil {
		return lc.marks
	}
	v, err := SendJSON(l.client, model.Binance, req)
	if err != nil {
		slog.Debug("binance mark prices", "err", err)
		return lc.marks
	}
	out := map[string]decimal.Decimal{}
	for _, x := range v.Arr() {
		if m := x.JDec("markPrice"); m.IsPositive() {
			out[x.JStr("symbol")] = m
		}
	}
	if len(out) > 0 {
		lc.marks, lc.marksAt = out, time.Now()
	}
	return lc.marks
}

// leadResolve returns (base, coins per size unit, coins per price unit) for
// one raw position. Binance symbols are self-describing (`1000PEPEUSDT` =
// 1000 PEPE per unit), so no contract list is needed; OKX sizes are
// contracts and need `ctVal` from the venue.
func leadResolve(r *rawPos, m *Markets) (string, decimal.Decimal, decimal.Decimal, bool) {
	if spec := m.Symbol(r.symbol); spec != nil {
		pxUnit := spec.PxUnit
		if pxUnit.IsZero() {
			pxUnit = util.One
		}
		return spec.Base, spec.CoinPerUnit, pxUnit, true
	}
	quote := r.quote
	if quote == "" {
		for _, q := range []string{"USDT", "USDC"} {
			if strings.HasSuffix(r.symbol, q) {
				quote = q
				break
			}
		}
		if quote == "" {
			return "", decimal.Zero, decimal.Zero, false
		}
	}
	rawBase, ok := strings.CutSuffix(r.symbol, quote)
	// Dated delivery contracts (BTCUSDT_250328) are not perpetuals.
	if !ok || rawBase == "" || strings.Contains(r.symbol, "_") {
		return "", decimal.Zero, decimal.Zero, false
	}
	base, mult := util.NormalizeBase(rawBase)
	return base, mult, mult, true
}

// leadTrades converts per-symbol fill totals to coins and per-coin prices,
// keyed by base.
func leadTrades(raw *rawSnap, m *Markets) map[string]model.TradeCum {
	if raw.trades == nil {
		return nil
	}
	out := map[string]model.TradeCum{}
	for sym, c := range raw.trades {
		base, perUnit, _, ok := leadResolve(&rawPos{symbol: sym}, m)
		if !ok {
			continue
		}
		// Notional is units × venue price = quote, unchanged by unit conversion.
		a := out[base]
		a.Qty = a.Qty.Add(c.Qty.Mul(perUnit))
		a.Notional = a.Notional.Add(c.Notional)
		a.Realized = a.Realized.Add(c.Realized)
		a.LastTs = max(a.LastTs, c.LastTs)
		out[base] = a
	}
	return out
}

// leadAggregate merges sub-positions / hedge legs into one net position per coin.
func leadAggregate(raw *rawSnap, m *Markets) []model.Position {
	type acc struct {
		pos                      model.Position
		notional, gross, largest decimal.Decimal
	}
	by := map[string]*acc{}
	var order []string
	for i := range raw.positions {
		r := &raw.positions[i]
		base, perUnit, pxUnit, ok := leadResolve(r, m)
		if !ok {
			continue
		}
		coins := r.units.Mul(perUnit)
		a, ok := by[base]
		if !ok {
			a = &acc{pos: model.Position{Base: base, Symbol: r.symbol}}
			by[base] = a
			order = append(order, base)
		}
		a.pos.Size = a.pos.Size.Add(coins)
		a.pos.Upnl = a.pos.Upnl.Add(r.upnl)
		a.notional = a.notional.Add(coins.Abs().Mul(r.entry).Div(pxUnit))
		a.gross = a.gross.Add(coins.Abs())
		if !r.mark.IsZero() {
			a.pos.MarkPx = r.mark.Div(pxUnit)
		}
		if coins.Abs().GreaterThan(a.largest) {
			a.largest = coins.Abs()
			a.pos.Leverage = r.leverage
		}
	}
	out := []model.Position{}
	for _, b := range order {
		a := by[b]
		if a.pos.Size.IsZero() {
			continue
		}
		if !a.gross.IsZero() {
			a.pos.EntryPx = a.notional.Div(a.gross)
		}
		out = append(out, a.pos)
	}
	return out
}

func (l *LeadTrader) Platform() model.Platform { return l.venue }
func (l *LeadTrader) Testnet() bool            { return false }
func (l *LeadTrader) CanTrade() bool           { return false }

// NeedsContracts: Binance lead positions are self-describing; skipping the
// list also avoids fapi.binance.com, which is geo-blocked in places where
// the www.binance.com copy-trade pages still work.
func (l *LeadTrader) NeedsContracts() bool { return l.venue != model.Binance }

func (l *LeadTrader) Contracts(ctx context.Context) ([]model.ContractSpec, error) {
	return l.public.Contracts(ctx)
}

func (l *LeadTrader) Snapshot(ctx context.Context, m *Markets, _ bool) (*model.AccountSnapshot, error) {
	raw, err := l.fetch(ctx)
	if err != nil {
		return nil, err
	}
	return &model.AccountSnapshot{Equity: raw.equity, Positions: leadAggregate(&raw, m), Orders: []model.OpenOrder{}, Ts: util.NowMs(), Trades: leadTrades(&raw, m)}, nil
}

func (l *LeadTrader) BBO(ctx context.Context, spec *model.ContractSpec) (decimal.Decimal, decimal.Decimal, error) {
	return l.public.BBO(ctx, spec)
}

func (l *LeadTrader) Place(context.Context, *model.ContractSpec, *model.OrderRequest) (*model.OrderResult, error) {
	return nil, errs.Msg("带单员信号源只读")
}
func (l *LeadTrader) Cancel(context.Context, *model.ContractSpec, string) error {
	return errs.Msg("带单员信号源只读")
}
func (l *LeadTrader) Query(context.Context, *model.ContractSpec, string) (*model.OrderResult, error) {
	return nil, nil
}
func (l *LeadTrader) SetLeverage(context.Context, *model.ContractSpec, uint32) error {
	return errs.Msg("带单员信号源只读")
}
func (l *LeadTrader) Info(ctx context.Context) (*model.ConnectionInfo, error) {
	raw, err := l.fetch(ctx)
	if err != nil {
		return nil, err
	}
	return &model.ConnectionInfo{Equity: raw.equity, OneWay: true, MarginMode: "公开持仓", Perms: model.Permissions{Read: true, Note: util.Ptr("交易所带单员，仅公开持仓")}, MarginAsset: "USDT"}, nil
}
func (l *LeadTrader) SetOneWay(context.Context) error            { return nil }
func (l *LeadTrader) ServerTime(context.Context) (*int64, error) { return nil, nil }

// ---------- discovery ----------

type LeadSummary struct {
	Platform model.Platform `json:"platform"`
	ID       string         `json:"id"`
	Nickname string         `json:"nickname"`
	Avatar   *string        `json:"avatar"`
	// Assets under management incl. copiers (venue definition).
	Aum        *string `json:"aum"`
	Copiers    *int64  `json:"copiers"`
	MaxCopiers *int64  `json:"max_copiers"`
	// Return in percent over the venue's window.
	RoiPct *string `json:"roi_pct"`
	Pnl    *string `json:"pnl"`
	// nil when the list does not say.
	PositionsPublic *bool   `json:"positions_public"`
	URL             *string `json:"url"`
}

func numI(v util.J, k string) *int64 {
	f, err := strconv.ParseFloat(v.JStr(k), 64)
	if err != nil {
		return nil
	}
	i := int64(f)
	return &i
}

func optStr(v util.J, k string) *string {
	s := v.JStr(k)
	if s == "" || s == "null" {
		return nil
	}
	return &s
}

// SearchLeadTraders browses or searches lead traders. `query` may be a
// nickname, an id or a link.
func SearchLeadTraders(ctx context.Context, p model.Platform, query string, page int, proxy string) ([]LeadSummary, error) {
	client, err := Client(proxy)
	if err != nil {
		return nil, err
	}
	q := strings.TrimSpace(query)
	out := []LeadSummary{}
	switch p {
	case model.Okx:
		// An id or link: look the trader up directly.
		if id, ok := ParseLeadID(p, q); ok {
			lt, err := NewLeadTrader(p, id, proxy)
			if err != nil {
				return nil, err
			}
			v, err := lt.okxGet(ctx, "public-stats", url.Values{"instType": {"SWAP"}, "uniqueCode": {id}, "lastDays": {"4"}})
			if err != nil {
				return nil, err
			}
			s := v.Get("data").At(0)
			return append(out, LeadSummary{Platform: p, ID: id, Nickname: id, Pnl: optStr(s, "curCopyTraderPnl"), PositionsPublic: util.Ptr(true), URL: LeadProfileURL(p, id)}), nil
		}
		// OKX has no name search: scan a few ranked pages and filter.
		pages := []int{max(page, 1)}
		if q != "" {
			pages = []int{1, 2, 3, 4, 5}
		}
		for _, pg := range pages {
			if err := lc.okxBucket.Acquire(ctx, 1, false); err != nil {
				return nil, err
			}
			req, err := newReq(ctx, http.MethodGet, okxCopy+"/public-lead-traders?"+url.Values{"instType": {"SWAP"}, "sortType": {"aum"}, "page": {strconv.Itoa(pg)}}.Encode(), "")
			if err != nil {
				return nil, err
			}
			v, err := SendJSON(client, model.Okx, req)
			if err != nil {
				return nil, err
			}
			if v.JStr("code") != "0" {
				return nil, errs.Msg("OKX %s %s", v.JStr("code"), v.JStr("msg"))
			}
			ranks := v.Get("data").At(0).Get("ranks").Arr()
			if len(ranks) == 0 {
				break
			}
			for _, r := range ranks {
				nick := r.JStr("nickName")
				if q != "" && !strings.Contains(strings.ToLower(nick), strings.ToLower(q)) {
					continue
				}
				id := r.JStr("uniqueCode")
				roi := util.Fmt(r.JDec("pnlRatio").Mul(util.Hundred).RoundBank(2))
				out = append(out, LeadSummary{
					Platform: p, URL: LeadProfileURL(p, id), ID: id, Nickname: nick, Avatar: optStr(r, "portLink"),
					Aum: optStr(r, "aum"), Copiers: numI(r, "copyTraderNum"), MaxCopiers: numI(r, "maxCopyTraderNum"),
					RoiPct: &roi, Pnl: optStr(r, "pnl"), PositionsPublic: util.Ptr(true),
				})
			}
		}
		return out, nil
	case model.Binance:
		if id, ok := ParseLeadID(p, q); ok {
			lt, err := NewLeadTrader(p, id, proxy)
			if err != nil {
				return nil, err
			}
			d, err := lt.bnDetail(ctx)
			if err != nil {
				return nil, err
			}
			var pp *bool
			if b, ok := d.Get("positionShow").Bool(); ok {
				pp = &b
			}
			return append(out, LeadSummary{
				Platform: p, URL: LeadProfileURL(p, id), ID: id, Nickname: d.JStr("nickname"), Avatar: optStr(d, "avatarUrl"),
				Aum: optStr(d, "aumAmount"), Copiers: numI(d, "currentCopyCount"), MaxCopiers: numI(d, "maxCopyCount"), PositionsPublic: pp,
			}), nil
		}
		if err := lc.bnBucket.Acquire(ctx, 1, false); err != nil {
			return nil, err
		}
		body, _ := json.Marshal(map[string]any{"pageNumber": max(page, 1), "pageSize": 20, "timeRange": "30D", "dataType": "AUM", "favoriteOnly": false, "hideFull": false, "nickname": q, "order": "DESC", "userAsset": 0, "portfolioType": "PUBLIC"})
		req, err := newReq(ctx, http.MethodPost, bnCopy+"/home-page/query-list", string(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		v, err := SendJSON(client, model.Binance, req)
		if err != nil {
			return nil, err
		}
		if !v.Get("success").BoolOr(false) {
			msg, ok := v.Get("message").AsStr()
			if !ok {
				msg = "请求失败"
			}
			return nil, errs.Msg("币安带单：%s", msg)
		}
		for _, r := range v.Get("data").Get("list").Arr() {
			id := r.JStr("leadPortfolioId")
			out = append(out, LeadSummary{
				Platform: p, URL: LeadProfileURL(p, id), ID: id, Nickname: r.JStr("nickname"), Avatar: optStr(r, "avatarUrl"),
				Aum: optStr(r, "aum"), Copiers: numI(r, "currentCopyCount"), MaxCopiers: numI(r, "maxCopyCount"),
				RoiPct: optStr(r, "roi"), Pnl: optStr(r, "pnl"),
			})
		}
		return out, nil
	}
	return nil, errs.Msg("%s 带单员暂不支持", p.Label())
}
