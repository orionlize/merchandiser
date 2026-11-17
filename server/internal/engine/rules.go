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
)

type Sizing struct {
	Mode     SizingMode      `json:"mode"`
	K        decimal.Decimal `json:"k"`
	Notional decimal.Decimal `json:"notional"`
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
}

func (l *Leverage) UnmarshalJSON(b []byte) error {
	type plain Leverage
	p := plain{Value: 10, Cap: 10}
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
}

func (r *Rules) UnmarshalJSON(b []byte) error {
	type plain Rules
	p := plain{
		Whitelist: []string{}, Blacklist: []string{}, Direction: "both",
		MinChangeUSDT: util.D(10), Exec: "market", ReconcileSecs: 15, TolerancePct: util.D(2), ReconcileMode: "auto_fix",
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
}

func (r *Risk) UnmarshalJSON(b []byte) error {
	type plain Risk
	p := plain{MaxSlippagePct: decimal.RequireFromString("0.3"), SourceLostSecs: 30, SourceLostAction: "keep"}
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

// OrderFactor is the multiplier applied to a source order quantity for mirrored orders.
func OrderFactor(s *Sizing, srcEquity, followerEquity, orderNotional decimal.Decimal) decimal.Decimal {
	switch s.Mode {
	case EquityRatio:
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
