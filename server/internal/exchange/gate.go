package exchange

// Gate USDT-margined perpetual futures (API v4). Sizes are integer contracts
// (`quanto_multiplier` coins each), signed: negative = short/sell.

import (
	"context"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/util"
)

type Gate struct {
	client  *http.Client
	creds   model.Credentials
	testnet bool
	bucket  *TokenBucket
}

func NewGate(creds model.Credentials, testnet bool, proxy string) (*Gate, error) {
	c, err := Client(proxy)
	if err != nil {
		return nil, err
	}
	return &Gate{client: c, creds: creds, testnet: testnet, bucket: NewBucket(100, 10*time.Second)}, nil
}

func (g *Gate) host() string {
	if g.testnet {
		return "https://fx-api-testnet.gateio.ws"
	}
	return "https://api.gateio.ws"
}

func (g *Gate) request(ctx context.Context, method, path string, query []kv, body any, signed, high bool) (util.J, error) {
	if err := g.bucket.Acquire(ctx, 1, high); err != nil {
		return util.J{}, err
	}
	full := "/api/v4" + path
	qs := buildQS(query)
	bodyS := ""
	if body != nil {
		b, _ := json.Marshal(body)
		bodyS = string(b)
	}
	u := g.host() + full
	if qs != "" {
		u += "?" + qs
	}
	req, err := newReq(ctx, method, u, bodyS)
	if err != nil {
		return util.J{}, err
	}
	req.Header.Set("Accept", "application/json")
	if signed {
		ts := strconv.FormatInt(util.NowMs()/1000, 10)
		h := sha512.Sum512([]byte(bodyS))
		pre := fmt.Sprintf("%s\n%s\n%s\n%s\n%s", method, full, qs, hex.EncodeToString(h[:]), ts)
		req.Header.Set("KEY", g.creds.APIKey)
		req.Header.Set("Timestamp", ts)
		req.Header.Set("SIGN", hex.EncodeToString(HmacSHA512([]byte(g.creds.Secret), []byte(pre))))
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	v, err := SendJSON(g.client, model.Gate, req)
	if e, ok := errs.AsExchange(err); ok {
		label, m := e.Code, e.Msg
		if j, perr := util.ParseJ([]byte(e.Msg)); perr == nil {
			if l, ok := j.Get("label").AsStr(); ok {
				label = l
			}
			if mm, ok := j.Get("message").AsStr(); ok {
				m = mm
			}
		}
		if label == "TOO_MANY_REQUESTS" {
			return v, &errs.RateLimited{Msg: m}
		}
		return v, &errs.Exchange{Code: label, Msg: m, Retryable: e.Retryable}
	}
	return v, err
}

func (g *Gate) get(ctx context.Context, path string, q []kv, signed bool) (util.J, error) {
	return g.request(ctx, http.MethodGet, path, q, nil, signed, false)
}

// gateText: Gate client order ids must start with "t-" and be ≤ 30 chars.
func gateText(clientID string) string { return "t-" + clientID }

func gateSpec(c util.J) *model.ContractSpec {
	if c.Get("in_delisting").BoolOr(false) {
		return nil
	}
	name := c.JStr("name")
	rawBase, quote, ok := strings.Cut(name, "_")
	if !ok || quote != "USDT" {
		return nil
	}
	base, mult := util.NormalizeBase(rawBase)
	lev := uint32(20)
	if l := c.JDec("leverage_max"); l.IsPositive() {
		lev = uint32(l.IntPart())
	}
	return &model.ContractSpec{
		Platform: model.Gate, Base: base, Symbol: name,
		CoinPerUnit: c.JDec("quanto_multiplier").Mul(mult), PxUnit: mult,
		QtyStep: util.One, MinQty: util.MaxD(c.JDec("order_size_min"), util.One),
		Tick: c.JDec("order_price_round"), MaxLeverage: lev, Quote: "USDT",
	}
}

func gateResult(spec *model.ContractSpec, o util.J) *model.OrderResult {
	size := o.JDec("size").Abs()
	left := o.JDec("left").Abs()
	filled := spec.UnitsToCoins(size.Sub(left))
	fp := o.JDec("fill_price")
	r := &model.OrderResult{OrderID: o.JStr("id"), Filled: filled}
	switch {
	case o.JStr("status") == "open":
		r.Status = model.Open
	case left.IsZero() && o.JStr("finish_as") == "filled":
		r.Status = model.Filled
	case !filled.IsZero():
		r.Status = model.Partial
	default:
		r.Status = model.Rejected
	}
	if !fp.IsZero() {
		r.AvgPx = decPtr(spec.CoinPx(fp))
	}
	return r
}

func (g *Gate) Platform() model.Platform { return model.Gate }
func (g *Gate) Testnet() bool            { return g.testnet }
func (g *Gate) CanTrade() bool           { return true }
func (g *Gate) NeedsContracts() bool     { return true }

func (g *Gate) Contracts(ctx context.Context) ([]model.ContractSpec, error) {
	v, err := g.get(ctx, "/futures/usdt/contracts", nil, false)
	if err != nil {
		return nil, err
	}
	var out []model.ContractSpec
	for _, c := range v.Arr() {
		if s := gateSpec(c); s != nil {
			out = append(out, *s)
		}
	}
	return out, nil
}

func (g *Gate) Snapshot(ctx context.Context, m *Markets, withOrders bool) (*model.AccountSnapshot, error) {
	a, err := g.get(ctx, "/futures/usdt/accounts", nil, true)
	if err != nil {
		return nil, err
	}
	snap := &model.AccountSnapshot{Equity: a.JDec("total").Add(a.JDec("unrealised_pnl")), Available: a.JDec("available"), Ts: util.NowMs(), Positions: []model.Position{}, Orders: []model.OpenOrder{}}
	ps, err := g.get(ctx, "/futures/usdt/positions", []kv{{"holding", "true"}}, true)
	if err != nil {
		return nil, err
	}
	for _, p := range ps.Arr() {
		size := p.JDec("size")
		if size.IsZero() {
			continue
		}
		sym := p.JStr("contract")
		spec := m.Symbol(sym)
		if spec == nil {
			continue
		}
		lev := p.JDec("leverage")
		if lev.IsZero() {
			lev = p.JDec("cross_leverage_limit")
		}
		snap.Positions = append(snap.Positions, model.Position{
			Base: spec.Base, Symbol: sym, Size: spec.UnitsToCoins(size),
			EntryPx: spec.CoinPx(p.JDec("entry_price")), MarkPx: spec.CoinPx(p.JDec("mark_price")),
			Leverage: decPtr(lev), Upnl: p.JDec("unrealised_pnl"),
		})
	}
	if withOrders {
		oo, err := g.get(ctx, "/futures/usdt/orders", []kv{{"status", "open"}}, true)
		if err != nil {
			return nil, err
		}
		for _, o := range oo.Arr() {
			sym := o.JStr("contract")
			spec := m.Symbol(sym)
			if spec == nil {
				continue
			}
			size := o.JDec("size")
			var cid *string
			if c, ok := strings.CutPrefix(o.JStr("text"), "t-"); ok {
				cid = &c
			}
			snap.Orders = append(snap.Orders, model.OpenOrder{
				ID: o.JStr("id"), ClientID: cid, Base: spec.Base, Symbol: sym, Buy: size.IsPositive(),
				Qty: spec.UnitsToCoins(o.JDec("left").Abs()), OrigQty: spec.UnitsToCoins(size.Abs()),
				Price: spec.CoinPx(o.JDec("price")), Kind: model.KindLimit, ReduceOnly: o.Get("is_reduce_only").BoolOr(false),
			})
		}
		po, err := g.get(ctx, "/futures/usdt/price_orders", []kv{{"status", "open"}}, true)
		if err != nil {
			return nil, err
		}
		for _, o := range po.Arr() {
			init := o.Get("initial")
			sym := init.JStr("contract")
			spec := m.Symbol(sym)
			if spec == nil {
				continue
			}
			size := init.JDec("size")
			trig := o.Get("trigger")
			// rule 1: price >= trigger, 2: price <= trigger
			rule, _ := trig.Get("rule").Int()
			buy := size.IsPositive() || (size.IsZero() && strings.Contains(o.JStr("order_type"), "short"))
			kind := model.KindStopMarket
			if (!buy && rule == 1) || (buy && rule == 2) {
				kind = model.KindTakeProfitMarket
			}
			snap.Orders = append(snap.Orders, model.OpenOrder{
				ID: o.JStr("id"), Base: spec.Base, Symbol: sym, Buy: buy,
				Qty: spec.UnitsToCoins(size.Abs()), OrigQty: spec.UnitsToCoins(size.Abs()),
				Price: decimal.Zero, TriggerPx: decPtr(spec.CoinPx(trig.JDec("price"))), Kind: kind,
				ReduceOnly: init.Get("is_reduce_only").BoolOr(false) || init.Get("is_close").BoolOr(false),
			})
		}
	}
	return snap, nil
}

func (g *Gate) BBO(ctx context.Context, spec *model.ContractSpec) (decimal.Decimal, decimal.Decimal, error) {
	v, err := g.get(ctx, "/futures/usdt/order_book", []kv{{"contract", spec.Symbol}, {"limit", "1"}}, false)
	if err != nil {
		return decimal.Zero, decimal.Zero, err
	}
	return spec.CoinPx(v.Get("bids").At(0).JDec("p")), spec.CoinPx(v.Get("asks").At(0).JDec("p")), nil
}

func (g *Gate) Place(ctx context.Context, spec *model.ContractSpec, req *model.OrderRequest) (*model.OrderResult, error) {
	units := spec.ToUnits(req.Qty).Truncate(0)
	if units.IsZero() || units.LessThan(spec.MinQty) {
		return nil, errs.Msg("数量低于最小下单量")
	}
	size := units.IntPart()
	if !req.Buy {
		size = -size
	}
	if req.Type.Kind == model.OrderTrigger {
		// rule 1: >=, 2: <=. A sell TP fires when price rises; a sell SL when it falls.
		rule := 2
		if (!req.Buy && req.Type.TakeProfit) || (req.Buy && !req.Type.TakeProfit) {
			rule = 1
		}
		body := map[string]any{
			"initial": map[string]any{"contract": spec.Symbol, "size": size, "price": "0", "tif": "ioc", "reduce_only": req.ReduceOnly, "text": gateText(req.ClientID)},
			"trigger": map[string]any{"strategy_type": 0, "price_type": 1, "price": util.Fmt(roundTick(spec, req.Type.TriggerPx, false)), "rule": rule},
		}
		v, err := g.request(ctx, http.MethodPost, "/futures/usdt/price_orders", nil, body, true, true)
		if err != nil {
			return nil, err
		}
		return &model.OrderResult{OrderID: v.JStr("id"), Status: model.Open}, nil
	}
	price, tif := "0", "ioc"
	switch req.Type.Kind {
	case model.OrderLimitIoc:
		price = util.Fmt(roundTick(spec, req.Type.Price, req.Buy))
	case model.OrderLimit:
		price, tif = util.Fmt(roundTick(spec, req.Type.Price, !req.Buy)), "gtc"
	}
	body := map[string]any{"contract": spec.Symbol, "size": size, "price": price, "tif": tif, "reduce_only": req.ReduceOnly, "text": gateText(req.ClientID)}
	v, err := g.request(ctx, http.MethodPost, "/futures/usdt/orders", nil, body, true, req.ReduceOnly)
	if err != nil {
		return nil, err
	}
	return gateResult(spec, v), nil
}

func (g *Gate) Cancel(ctx context.Context, spec *model.ContractSpec, clientID string) error {
	_, err := g.request(ctx, http.MethodDelete, "/futures/usdt/orders/"+gateText(clientID), nil, nil, true, true)
	if e, ok := errs.AsExchange(err); ok && (e.Code == "ORDER_NOT_FOUND" || e.Code == "ORDER_FINISHED") {
		return nil
	}
	return err
}

func (g *Gate) Query(ctx context.Context, spec *model.ContractSpec, clientID string) (*model.OrderResult, error) {
	v, err := g.get(ctx, "/futures/usdt/orders/"+gateText(clientID), nil, true)
	if e, ok := errs.AsExchange(err); ok && e.Code == "ORDER_NOT_FOUND" {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return gateResult(spec, v), nil
}

func (g *Gate) SetLeverage(ctx context.Context, spec *model.ContractSpec, leverage uint32) error {
	// leverage=0 means cross margin with the given limit.
	lev := strconv.Itoa(int(min(max(leverage, 1), max(spec.MaxLeverage, 1))))
	_, err := g.request(ctx, http.MethodPost, "/futures/usdt/positions/"+spec.Symbol+"/leverage", []kv{{"leverage", "0"}, {"cross_leverage_limit", lev}}, nil, true, false)
	return err
}

func (g *Gate) Info(ctx context.Context) (*model.ConnectionInfo, error) {
	t0 := time.Now()
	a, err := g.get(ctx, "/futures/usdt/accounts", nil, true)
	if err != nil {
		return nil, err
	}
	latency := uint64(time.Since(t0).Milliseconds())
	st, err := g.ServerTime(ctx)
	if err != nil {
		return nil, err
	}
	var skew int64
	if st != nil {
		skew = util.NowMs() - *st - int64(latency/2)
	}
	return &model.ConnectionInfo{
		Equity: a.JDec("total").Add(a.JDec("unrealised_pnl")), Available: a.JDec("available"),
		OneWay: !a.Get("in_dual_mode").BoolOr(false), MarginMode: "全仓",
		Perms:     model.Permissions{Read: true, Trade: true, Note: util.Ptr("Gate 不提供查询 Key 权限的接口，请在官网确认已关闭提币权限")},
		LatencyMs: latency, ClockSkewMs: skew, MarginAsset: "USDT",
	}, nil
}

func (g *Gate) SetOneWay(ctx context.Context) error {
	_, err := g.request(ctx, http.MethodPost, "/futures/usdt/dual_mode", []kv{{"dual_mode", "false"}}, nil, true, false)
	return err
}

func (g *Gate) ServerTime(ctx context.Context) (*int64, error) {
	v, err := g.get(ctx, "/spot/time", nil, false)
	if err != nil {
		return nil, err
	}
	if t, ok := v.Get("server_time").Int(); ok {
		return &t, nil
	}
	return nil, nil
}
