// Package exchange has one adapter per venue behind a single interface; the
// engine only sees the unified model.
package exchange

import (
	"context"
	"github.com/shopspring/decimal"

	"merchandiser/server/internal/model"
	"merchandiser/server/internal/util"
)

type Exchange interface {
	Platform() model.Platform
	Testnet() bool
	// Contracts lists all live linear perpetual contracts.
	Contracts(ctx context.Context) ([]model.ContractSpec, error)
	// Snapshot reads equity, positions and (optionally) open orders.
	Snapshot(ctx context.Context, m *Markets, withOrders bool) (*model.AccountSnapshot, error)
	// BBO returns the best bid / ask per coin.
	BBO(ctx context.Context, spec *model.ContractSpec) (bid, ask decimal.Decimal, err error)
	Place(ctx context.Context, spec *model.ContractSpec, req *model.OrderRequest) (*model.OrderResult, error)
	Cancel(ctx context.Context, spec *model.ContractSpec, clientID string) error
	// Query looks an order up by our client id (nil, nil = not found).
	Query(ctx context.Context, spec *model.ContractSpec, clientID string) (*model.OrderResult, error)
	SetLeverage(ctx context.Context, spec *model.ContractSpec, leverage uint32) error
	// Info checks connectivity, permissions, position mode, equity.
	Info(ctx context.Context) (*model.ConnectionInfo, error)
	SetOneWay(ctx context.Context) error
	// ServerTime is the venue time in ms (nil when the venue exposes none).
	ServerTime(ctx context.Context) (*int64, error)
	// CanTrade is false for public address sources.
	CanTrade() bool
	// NeedsContracts is false for sources whose feed already names symbols
	// and coin sizes.
	NeedsContracts() bool
}

// Markets holds the contract specs of one venue, by base coin and by symbol.
type Markets struct {
	ByBase   map[string]*model.ContractSpec
	BySymbol map[string]*model.ContractSpec
}

func EmptyMarkets() *Markets {
	return &Markets{ByBase: map[string]*model.ContractSpec{}, BySymbol: map[string]*model.ContractSpec{}}
}

func MarketsFromSpecs(specs []model.ContractSpec) *Markets {
	m := EmptyMarkets()
	for i := range specs {
		s := specs[i]
		// Prefer USDT-quoted over USDC when a venue lists both.
		existing, ok := m.ByBase[s.Base]
		replace := !ok || (existing.Quote != "USDT" && s.Quote == "USDT")
		cp := s
		m.BySymbol[s.Symbol] = &cp
		if replace {
			cp2 := s
			m.ByBase[s.Base] = &cp2
		}
	}
	return m
}

func (m *Markets) Base(b string) *model.ContractSpec { return m.ByBase[b] }

func (m *Markets) Symbol(s string) *model.ContractSpec { return m.BySymbol[s] }

// Clone copies the maps (specs are copied too).
func (m *Markets) Clone() *Markets {
	out := EmptyMarkets()
	for k, v := range m.ByBase {
		c := *v
		out.ByBase[k] = &c
	}
	for k, v := range m.BySymbol {
		c := *v
		out.BySymbol[k] = &c
	}
	return out
}

// AggressivePx is the price bound for market emulation / IOC limits: ref ± slip.
func AggressivePx(ref decimal.Decimal, buy bool, slip decimal.Decimal) decimal.Decimal {
	if buy {
		return ref.Mul(util.One.Add(slip))
	}
	return ref.Mul(util.One.Sub(slip))
}

func decPtr(d decimal.Decimal) *decimal.Decimal { return &d }
