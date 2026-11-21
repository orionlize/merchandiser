package engine

// Task configuration (stored as JSON) and the pure sizing maths.

import (
	"encoding/json"
	"strings"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/util"
)

type SizingMode string

const (
	// follower equity ÷ source equity × k
	EquityRatio SizingMode = "equity_ratio"
	// source qty × k
	FixedMultiple SizingMode = "fixed_multiple"
	// fixed USDT notional per opened position
	FixedNotional SizingMode = "fixed_notional"
	// allocated capital ÷ source equity × k: each task sizes against its own
	// capital, so several tasks can share one account without crowding it
	Allocated SizingMode = "allocated"
)

type Sizing struct {
	Mode     SizingMode      `json:"mode"`
	K        decimal.Decimal `json:"k"`
	Notional decimal.Decimal `json:"notional"`
	// Allocated mode: USDT capital per follower account.
	Capital decimal.Decimal `json:"capital"`
	// Allocated mode: the task's realised PnL on the account grows / shrinks the capital.
	Compound bool `json:"compound"`
}

func (s *Sizing) UnmarshalJSON(b []byte) error {
	type plain Sizing
	p := plain{K: util.One}
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*s = Sizing(p)
	return nil
}

type LeverageMode string

const (
	LevFollow LeverageMode = "follow"
	LevFixed  LeverageMode = "fixed"
)

type Leverage struct {
	Mode  LeverageMode `json:"mode"`
	Value uint32       `json:"value"`
	Cap   uint32       `json:"cap"`
	// cross | isolated
	Margin string `json:"margin"`
}

func (l *Leverage) Cross() bool { return l.Margin != "isolated" }

func (l *Leverage) UnmarshalJSON(b []byte) error {
	type plain Leverage
	p := plain{Value: 10, Cap: 10, Margin: "cross"}
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*l = Leverage(p)
	return nil
}

type Mirror struct {
	Enabled bool   `json:"enabled"`
	GraceMs uint64 `json:"grace_ms"`
	// Do not mirror orders further than this (%) from the follower's book.
	MaxDeviationPct decimal.Decimal `json:"max_deviation_pct"`
}

func (m *Mirror) UnmarshalJSON(b []byte) error {
	type plain Mirror
	p := plain{GraceMs: 2000, MaxDeviationPct: util.D(5)}
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*m = Mirror(p)
	return nil
}

// TPSL closes the task's share of a coin on its own ROE (PnL ÷ margin, from
// the share's average entry and the account's leverage). Nil levels are off.
type TPSL struct {
	Enabled bool `json:"enabled"`
	// Take profit at ROE ≥ +TPPct %.
	TPPct *decimal.Decimal `json:"tp_pct"`
	// Stop loss at ROE ≤ −SLPct % (stored positive).
	SLPct *decimal.Decimal `json:"sl_pct"`
	// Trailing: once ROE reaches +TrailActivatePct %, close when it falls
	// TrailCallbackPct ROE points below its peak.
	TrailActivatePct *decimal.Decimal `json:"trail_activate_pct"`
	TrailCallbackPct *decimal.Decimal `json:"trail_callback_pct"`
}

func isSet(d *decimal.Decimal) bool { return d != nil && d.IsPositive() }

// Active reports whether any exit level is set.
func (t *TPSL) Active() bool {
	return t.Enabled && (isSet(t.TPPct) || isSet(t.SLPct) || (isSet(t.TrailActivatePct) && isSet(t.TrailCallbackPct)))
}

// Exit decides whether a share at roe (percent) with peak ROE so far should
// close: "tp", "sl", "trail" or "".
func (t *TPSL) Exit(roe, peak decimal.Decimal) string {
	if !t.Enabled {
		return ""
	}
	if isSet(t.SLPct) && roe.LessThanOrEqual(t.SLPct.Neg()) {
		return "sl"
	}
	if isSet(t.TPPct) && roe.GreaterThanOrEqual(*t.TPPct) {
		return "tp"
	}
	if isSet(t.TrailActivatePct) && isSet(t.TrailCallbackPct) && peak.GreaterThanOrEqual(*t.TrailActivatePct) && peak.Sub(roe).GreaterThanOrEqual(*t.TrailCallbackPct) {
		return "trail"
	}
	return ""
}

// ROE is the return on margin in percent of a position of signed size at
// avgPx, marked at px, with the given leverage.
func ROE(size, avgPx, px, leverage decimal.Decimal) decimal.Decimal {
	if size.IsZero() || !avgPx.IsPositive() || !px.IsPositive() {
		return decimal.Zero
	}
	lev := leverage
	if !lev.IsPositive() {
		lev = util.One
	}
	return px.Div(avgPx).Sub(util.One).Mul(util.Signum(size)).Mul(lev).Mul(util.Hundred)
}

type Rules struct {
	Sizing        Sizing          `json:"sizing"`
	Leverage      Leverage        `json:"leverage"`
	Whitelist     []string        `json:"whitelist"`
	Blacklist     []string        `json:"blacklist"`
	Direction     string          `json:"direction"` // both | long_only | short_only
	Reverse       bool            `json:"reverse"`
	Start         string          `json:"start"` // new_only | sync_existing
	Stop          string          `json:"stop"`  // keep | close_all
	MinChangeUSDT decimal.Decimal `json:"min_change_usdt"`
	Exec          string          `json:"exec"` // market | limit_ioc
	Mirror        Mirror          `json:"mirror"`
	ReconcileSecs uint64          `json:"reconcile_secs"`
	TolerancePct  decimal.Decimal `json:"tolerance_pct"`
	ReconcileMode string          `json:"reconcile_mode"` // auto_fix | alert_only
	TPSL          TPSL            `json:"tpsl"`
	// copy | watch ("观察模式": push the source's signals, never trade).
	Mode  string `json:"mode"`
	Watch Watch  `json:"watch"`
}

// Watching is true for watch-only tasks.
func (r *Rules) Watching() bool { return r.Mode == "watch" }

// Watch picks which source signals a watch-only task pushes.
type Watch struct {
	Open   bool `json:"open"`
	Add    bool `json:"add"`
	Reduce bool `json:"reduce"`
	// Close and flip.
	Close bool `json:"close"`
	// Adds and reduces below this notional (USDT) are not pushed.
	MinNotional decimal.Decimal `json:"min_notional"`
}

func (w *Watch) UnmarshalJSON(b []byte) error {
	type plain Watch
	p := plain{Open: true, Add: true, Reduce: true, Close: true}
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*w = Watch(p)
	return nil
}

// Wants decides whether a signal of the given kind (open | add | reduce |
// close | flip) and notional is pushed.
func (w *Watch) Wants(kind string, notional decimal.Decimal) bool {
	switch kind {
	case "open":
		return w.Open
	case "close", "flip":
		return w.Close
	case "add":
		return w.Add && notional.GreaterThanOrEqual(w.MinNotional)
	case "reduce":
		return w.Reduce && notional.GreaterThanOrEqual(w.MinNotional)
	}
	return false
}

func (r *Rules) UnmarshalJSON(b []byte) error {
	type plain Rules
	p := plain{
		Whitelist: []string{}, Blacklist: []string{}, Direction: "both",
		MinChangeUSDT: util.D(10), Exec: "market", ReconcileSecs: 15, TolerancePct: util.D(2), ReconcileMode: "auto_fix",
		Mode: "copy", Watch: Watch{Open: true, Add: true, Reduce: true, Close: true},
	}
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	if p.Whitelist == nil {
		p.Whitelist = []string{}
	}
	if p.Blacklist == nil {
		p.Blacklist = []string{}
	}
	*r = Rules(p)
	return nil
}

type Risk struct {
	MaxSymbolNotional *decimal.Decimal `json:"max_symbol_notional"`
	MaxTotalNotional  *decimal.Decimal `json:"max_total_notional"`
	// Percent, e.g. 0.3 = 0.3 %.
	MaxSlippagePct   decimal.Decimal  `json:"max_slippage_pct"`
	DailyLossLimit   *decimal.Decimal `json:"daily_loss_limit"`
	TotalLossLimit   *decimal.Decimal `json:"total_loss_limit"`
	CloseOnLoss      bool             `json:"close_on_loss"`
	SourceLostSecs   uint64           `json:"source_lost_secs"`
	SourceLostAction string           `json:"source_lost_action"` // keep | pause | close
	// Loss limits in USDT, or in percent of the task's capital ("pct").
	LossUnit string `json:"loss_unit"` // usdt | pct
	// Most coins the task may hold at once per account (nil / 0 = no limit).
	MaxPositions *uint32 `json:"max_positions"`
	// Pause (or close and pause) once the task's PnL reaches this many USDT.
	ProfitTarget *decimal.Decimal `json:"profit_target"`
	ProfitAction string           `json:"profit_action"` // pause | close
	// Source drawdown breaker: pause (or close and pause) once the source's
	// cumulative PnL falls this many percent of its equity below its peak
	// since the task started (or last resumed). Nil / 0 = off.
	SourceDDPct    *decimal.Decimal `json:"source_dd_pct"`
	SourceDDAction string           `json:"source_dd_action"` // pause | close
}

// LossLimits are the daily / total loss limits in USDT for a task with the
// given capital (zero = unknown; percent limits are then off).
func (r *Risk) LossLimits(capital decimal.Decimal) (daily, total *decimal.Decimal) {
	conv := func(l *decimal.Decimal) *decimal.Decimal {
		if l == nil || !l.IsPositive() {
			return nil
		}
		if r.LossUnit != "pct" {
			return l
		}
		if !capital.IsPositive() {
			return nil
		}
		v := capital.Mul(*l).Div(util.Hundred)
		return &v
	}
	return conv(r.DailyLossLimit), conv(r.TotalLossLimit)
}

func (r *Risk) UnmarshalJSON(b []byte) error {
	type plain Risk
	p := plain{MaxSlippagePct: decimal.RequireFromString("0.3"), SourceLostSecs: 30, SourceLostAction: "keep", LossUnit: "usdt", ProfitAction: "pause", SourceDDAction: "pause"}
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*r = Risk(p)
	return nil
}

type FollowerOverride struct {
	Sizing   *Sizing   `json:"sizing"`
	Leverage *Leverage `json:"leverage"`
}

func (r *Rules) Allows(base string) bool {
	for _, b := range r.Blacklist {
		if strings.EqualFold(b, base) {
			return false
		}
	}
	if len(r.Whitelist) == 0 {
		return true
	}
	for _, b := range r.Whitelist {
		if strings.EqualFold(b, base) {
			return true
		}
	}
	return false
}

// Directional applies the direction filter and reverse flag to a source position.
func (r *Rules) Directional(src decimal.Decimal) decimal.Decimal {
	s := src
	if r.Reverse {
		s = src.Neg()
	}
	switch r.Direction {
	case "long_only":
		if s.IsPositive() {
			return s
		}
		return decimal.Zero
	case "short_only":
		if s.IsNegative() {
			return s
		}
		return decimal.Zero
	}
	return s
}

// SizingInput: inputs for one follower × symbol target computation.
type SizingInput struct {
	SrcSize        decimal.Decimal
	SrcEquity      decimal.Decimal
	FollowerEquity decimal.Decimal
	Price          decimal.Decimal
	// Source size when the position was opened (fixed-notional scaling of adds / reduces).
	SrcOpenSize decimal.Decimal
	// Allocated mode: the follower's effective capital (with compounding).
	Capital decimal.Decimal
}

// Target is the target position in coins for one follower.
func Target(s *Sizing, i SizingInput) decimal.Decimal {
	if i.SrcSize.IsZero() {
		return decimal.Zero
	}
	switch s.Mode {
	case EquityRatio:
		if !i.SrcEquity.IsPositive() {
			return decimal.Zero
		}
		return i.SrcSize.Mul(i.FollowerEquity).Div(i.SrcEquity).Mul(s.K)
	case Allocated:
		if !i.SrcEquity.IsPositive() || !i.Capital.IsPositive() {
			return decimal.Zero
		}
		return i.SrcSize.Mul(i.Capital).Div(i.SrcEquity).Mul(s.K)
	case FixedMultiple:
		return i.SrcSize.Mul(s.K)
	case FixedNotional:
		if i.Price.IsZero() || i.SrcOpenSize.IsZero() {
			return decimal.Zero
		}
		// Opening fixes N USDT; later adds / reduces scale with the source.
		baseQty := s.Notional.Div(i.Price)
		return baseQty.Mul(i.SrcSize.Div(i.SrcOpenSize.Abs()))
	}
	return decimal.Zero
}

// OrderFactor is the multiplier applied to a source order quantity for
// mirrored orders. followerEquity is the effective capital in allocated mode.
func OrderFactor(s *Sizing, srcEquity, followerEquity, orderNotional decimal.Decimal) decimal.Decimal {
	switch s.Mode {
	case EquityRatio, Allocated:
		if !srcEquity.IsPositive() {
			return decimal.Zero
		}
		return followerEquity.Div(srcEquity).Mul(s.K)
	case FixedMultiple:
		return s.K
	case FixedNotional:
		if orderNotional.IsZero() {
			return decimal.Zero
		}
		return s.Notional.Div(orderNotional)
	}
	return decimal.Zero
}

// SourceDrawdown is the source's drawdown in percent: how far its cumulative
// PnL is below the peak, relative to its equity at that peak.
func SourceDrawdown(peakPnl, peakEquity, pnl decimal.Decimal) decimal.Decimal {
	if !peakEquity.IsPositive() || !pnl.LessThan(peakPnl) {
		return decimal.Zero
	}
	return peakPnl.Sub(pnl).Div(peakEquity).Mul(util.Hundred)
}
