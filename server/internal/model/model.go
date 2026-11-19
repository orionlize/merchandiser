// Package model is the unified domain model. Every quantity is in *coins* of
// the base asset (BTC, PEPE …) and every price is *per coin*. Adapters
// convert to and from the venue's own units (contracts, 1000-multiplier
// symbols, …).
package model

import (
	"github.com/shopspring/decimal"

	"merchandiser/server/internal/util"
)

type Platform string

const (
	Okx         Platform = "okx"
	Binance     Platform = "binance"
	Gate        Platform = "gate"
	Hyperliquid Platform = "hyperliquid"
	Paper       Platform = "paper"
)

var LivePlatforms = []Platform{Okx, Binance, Gate, Hyperliquid}

func ParsePlatform(s string) (Platform, bool) {
	switch Platform(s) {
	case Okx, Binance, Gate, Hyperliquid, Paper:
		return Platform(s), true
	}
	return "", false
}

func (p Platform) Label() string {
	switch p {
	case Okx:
		return "OKX"
	case Binance:
		return "币安"
	case Gate:
		return "Gate"
	case Hyperliquid:
		return "Hyperliquid"
	case Paper:
		return "模拟"
	}
	return string(p)
}

// Credentials: for Hyperliquid `api_key` is the main account address and
// `secret` is the API (agent) wallet private key.
type Credentials struct {
	APIKey     string  `json:"api_key"`
	Secret     string  `json:"secret"`
	Passphrase *string `json:"passphrase"`
}

func (c Credentials) Pass() string {
	if c.Passphrase == nil {
		return ""
	}
	return *c.Passphrase
}

type ContractSpec struct {
	Platform Platform `json:"platform"`
	// Normalised base coin, e.g. "BTC", "PEPE".
	Base string `json:"base"`
	// Venue symbol / instrument id, e.g. "BTC-USDT-SWAP", "1000PEPEUSDT", "kPEPE".
	Symbol string `json:"symbol"`
	// Coins per one unit of venue order quantity.
	CoinPerUnit decimal.Decimal `json:"coin_per_unit"`
	// Coins per one unit of venue price (1 for most, 1000 for 1000PEPE / kPEPE).
	PxUnit decimal.Decimal `json:"px_unit"`
	// Venue quantity step / minimum (venue units).
	QtyStep decimal.Decimal `json:"qty_step"`
	MinQty  decimal.Decimal `json:"min_qty"`
	// Venue price tick. Zero means significant-figure rules (Hyperliquid).
	Tick        decimal.Decimal `json:"tick"`
	MinNotional decimal.Decimal `json:"min_notional"`
	MaxLeverage uint32          `json:"max_leverage"`
	Quote       string          `json:"quote"`
	// Hyperliquid asset index and size decimals.
	AssetIndex uint32 `json:"asset_index"`
	SzDecimals uint32 `json:"sz_decimals"`
}

// ToUnits converts coins to venue units, floored to the venue step.
func (s *ContractSpec) ToUnits(coins decimal.Decimal) decimal.Decimal {
	raw := coins.Abs().Div(s.CoinPerUnit)
	return util.FloorStep(raw, s.QtyStep)
}

func (s *ContractSpec) UnitsToCoins(units decimal.Decimal) decimal.Decimal {
	return units.Mul(s.CoinPerUnit)
}

// MinUnits is the smallest tradable quantity in venue units.
func (s *ContractSpec) MinUnits() decimal.Decimal { return util.MaxD(s.MinQty, s.QtyStep) }

func (s *ContractSpec) VenuePx(pxPerCoin decimal.Decimal) decimal.Decimal {
	return pxPerCoin.Mul(s.PxUnit)
}

func (s *ContractSpec) CoinPx(venuePx decimal.Decimal) decimal.Decimal {
	if s.PxUnit.IsZero() {
		return venuePx
	}
	return venuePx.Div(s.PxUnit)
}

type Position struct {
	Base   string `json:"base"`
	Symbol string `json:"symbol"`
	// Signed size in coins, positive = long.
	Size     decimal.Decimal  `json:"size"`
	EntryPx  decimal.Decimal  `json:"entry_px"`
	MarkPx   decimal.Decimal  `json:"mark_px"`
	Leverage *decimal.Decimal `json:"leverage"`
	Upnl     decimal.Decimal  `json:"upnl"`
}

type OrderKind string

const (
	KindLimit            OrderKind = "limit"
	KindStopMarket       OrderKind = "stop_market"
	KindTakeProfitMarket OrderKind = "take_profit_market"
	KindOther            OrderKind = "other"
)

type OpenOrder struct {
	ID       string  `json:"id"`
	ClientID *string `json:"client_id"`
	Base     string  `json:"base"`
	Symbol   string  `json:"symbol"`
	Buy      bool    `json:"buy"`
	// Remaining / original quantity in coins.
	Qty        decimal.Decimal  `json:"qty"`
	OrigQty    decimal.Decimal  `json:"orig_qty"`
	Price      decimal.Decimal  `json:"price"`
	TriggerPx  *decimal.Decimal `json:"trigger_px"`
	Kind       OrderKind        `json:"kind"`
	ReduceOnly bool             `json:"reduce_only"`
}

type AccountSnapshot struct {
	Equity    decimal.Decimal `json:"equity"`
	Available decimal.Decimal `json:"available"`
	Positions []Position      `json:"positions"`
	Orders    []OpenOrder     `json:"orders"`
	Ts        int64           `json:"ts"`
	// Running totals of the account's own fills per coin, when the source
	// exposes them (lead traders followed by fills). Two snapshots' totals
	// differ by exactly the fills in between: their VWAP, last fill time and
	// realised PnL. Nil when unknown.
	Trades map[string]TradeCum `json:"-"`
}

// TradeCum accumulates fills: Qty in coins (absolute), Notional in quote.
type TradeCum struct {
	Qty      decimal.Decimal `json:"qty"`
	Notional decimal.Decimal `json:"notional"`
	Realized decimal.Decimal `json:"realized"`
	LastTs   int64           `json:"last_ts"`
}

func (a *AccountSnapshot) Position(base string) decimal.Decimal {
	s := decimal.Zero
	for _, p := range a.Positions {
		if p.Base == base {
			s = s.Add(p.Size)
		}
	}
	return s
}

func (a *AccountSnapshot) Upnl() decimal.Decimal {
	s := decimal.Zero
	for _, p := range a.Positions {
		s = s.Add(p.Upnl)
	}
	return s
}

func (a *AccountSnapshot) Notional() decimal.Decimal {
	s := decimal.Zero
	for _, p := range a.Positions {
		s = s.Add(p.Size.Mul(p.MarkPx).Abs())
	}
	return s
}

type OrderTypeKind int

const (
	OrderMarket OrderTypeKind = iota
	// Limit IOC at a price that bounds slippage.
	OrderLimitIoc
	// Resting GTC limit.
	OrderLimit
	// Conditional market order on trigger.
	OrderTrigger
)

type OrderType struct {
	Kind       OrderTypeKind
	Price      decimal.Decimal
	TriggerPx  decimal.Decimal
	TakeProfit bool
}

type OrderRequest struct {
	Buy bool
	// Quantity in coins (positive).
	Qty        decimal.Decimal
	Type       OrderType
	ReduceOnly bool
	// Internal client id: 24 lowercase hex chars; adapters adapt the format.
	ClientID string
	// Reference price per coin used for market emulation / slippage maths.
	RefPx decimal.Decimal
}

type FillStatus string

const (
	Filled   FillStatus = "filled"
	Partial  FillStatus = "partial"
	Open     FillStatus = "open"
	Rejected FillStatus = "rejected"
)

type OrderResult struct {
	OrderID string
	Status  FillStatus
	// Filled quantity in coins, average fill price per coin.
	Filled decimal.Decimal
	AvgPx  *decimal.Decimal
}

type Permissions struct {
	Read  bool `json:"read"`
	Trade bool `json:"trade"`
	// nil = venue cannot tell us.
	Withdraw     *bool   `json:"withdraw"`
	Transfer     *bool   `json:"transfer"`
	IPRestricted *bool   `json:"ip_restricted"`
	Note         *string `json:"note"`
}

type ConnectionInfo struct {
	Equity    decimal.Decimal `json:"equity"`
	Available decimal.Decimal `json:"available"`
	// true = one-way / net mode.
	OneWay      bool        `json:"one_way"`
	MarginMode  string      `json:"margin_mode"`
	Perms       Permissions `json:"perms"`
	LatencyMs   uint64      `json:"latency_ms"`
	ClockSkewMs int64       `json:"clock_skew_ms"`
	MarginAsset string      `json:"margin_asset"`
}
