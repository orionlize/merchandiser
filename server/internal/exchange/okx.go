package exchange

// OKX v5 linear swaps (USDT / USDC margined). Quantities are contracts
// (`ctVal` coins each); prices are per coin.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/util"
)

const okxBase = "https://www.okx.com"

type Okx struct {
	client  *http.Client
	creds   model.Credentials
	testnet bool
	bucket  *TokenBucket
}

func NewOkx(creds model.Credentials, testnet bool, proxy string) (*Okx, error) {
	if creds.Pass() == "" {
		return nil, errs.Msg("OKX 需要 Passphrase")
	}
	c, err := Client(proxy)
	if err != nil {
		return nil, err
	}
	return &Okx{client: c, creds: creds, testnet: testnet, bucket: NewBucket(20, 2*time.Second)}, nil
}

func (o *Okx) request(ctx context.Context, method, path string, query []kv, body any, signed, high bool) (util.J, error) {
	if err := o.bucket.Acquire(ctx, 1, high); err != nil {
		return util.J{}, err
	}
	reqPath := path
	if len(query) > 0 {
		reqPath += "?" + buildQS(query)
	}
	bodyS := ""
	if body != nil {
		b, _ := json.Marshal(body)
		bodyS = string(b)
	}
	req, err := newReq(ctx, method, okxBase+reqPath, bodyS)
	if err != nil {
		return util.J{}, err
	}
	if signed {
		ts := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		pre := ts + method + reqPath + bodyS
		sig := base64.StdEncoding.EncodeToString(HmacSHA256([]byte(o.creds.Secret), []byte(pre)))
		req.Header.Set("OK-ACCESS-KEY", o.creds.APIKey)
		req.Header.Set("OK-ACCESS-SIGN", sig)
		req.Header.Set("OK-ACCESS-TIMESTAMP", ts)
		req.Header.Set("OK-ACCESS-PASSPHRASE", o.creds.Pass())
	}
	if o.testnet {
		req.Header.Set("x-simulated-trading", "1")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	v, err := SendJSON(o.client, model.Okx, req)
	if err != nil {
		return v, err
	}
	code := v.JStr("code")
	if code != "0" {
		// Per-item errors are reported in data[0].sCode / sMsg.
		d0 := v.Get("data").At(0)
		detail := strings.TrimSpace(d0.JStr("sCode") + " " + d0.JStr("sMsg"))
		if code == "50011" || code == "50061" {
			return v, &errs.RateLimited{Msg: "OKX " + code}
		}
		retryable := code == "50013" || code == "50001" || code == "50026"
		return v, &errs.Exchange{Code: code, Msg: strings.TrimSpace(v.JStr("msg") + " " + detail), Retryable: retryable}
	}
	return v, nil
}

func (o *Okx) get(ctx context.Context, path string, q []kv, signed bool) (util.J, error) {
	return o.request(ctx, http.MethodGet, path, q, nil, signed, false)
}

func okxSpec(i util.J) *model.ContractSpec {
	if i.JStr("ctType") != "linear" || i.JStr("state") != "live" {
		return nil
	}
	settle := i.JStr("settleCcy")
	if settle != "USDT" && settle != "USDC" {
		return nil
	}
	base, mult := util.NormalizeBase(i.JStr("ctValCcy"))
	ctVal := i.JDec("ctVal").Mul(util.MaxD(i.JDec("ctMult"), util.One))
	lev := uint32(20)
	if l, err := strconv.ParseFloat(i.JStr("lever"), 64); err == nil && l > 0 {
		lev = uint32(l)
	}
	return &model.ContractSpec{
		Platform: model.Okx, Base: base, Symbol: i.JStr("instId"),
		CoinPerUnit: ctVal.Mul(mult), PxUnit: mult,
		QtyStep: i.JDec("lotSz"), MinQty: i.JDec("minSz"), Tick: i.JDec("tickSz"),
		MinNotional: decimal.Zero, MaxLeverage: lev, Quote: settle,
	}
}

func okxKind(ordType string) model.OrderKind {
	switch ordType {
	case "limit", "post_only", "fok", "ioc":
		return model.KindLimit
	}
	return model.KindOther
}

func (o *Okx) Platform() model.Platform { return model.Okx }
func (o *Okx) Testnet() bool            { return o.testnet }
func (o *Okx) CanTrade() bool           { return true }
func (o *Okx) NeedsContracts() bool     { return true }

func (o *Okx) Contracts(ctx context.Context) ([]model.ContractSpec, error) {
	v, err := o.get(ctx, "/api/v5/public/instruments", []kv{{"instType", "SWAP"}}, false)
	if err != nil {
		return nil, err
	}
	var out []model.ContractSpec
	for _, i := range v.Get("data").Arr() {
		if s := okxSpec(i); s != nil {
			out = append(out, *s)
		}
	}
	return out, nil
}

func okxAvailable(b0 util.J, fallback bool) decimal.Decimal {
	avail := decimal.Zero
	for _, d := range b0.Get("details").Arr() {
		c := d.JStr("ccy")
		if c == "USDT" || c == "USDC" {
			a := d.JDec("availEq")
			if a.IsZero() && fallback {
				a = d.JDec("availBal")
			}
			avail = avail.Add(a)
		}
	}
	return avail
}

func (o *Okx) Snapshot(ctx context.Context, m *Markets, withOrders bool) (*model.AccountSnapshot, error) {
	bal, err := o.get(ctx, "/api/v5/account/balance", nil, true)
	if err != nil {
		return nil, err
	}
	b0 := bal.Get("data").At(0)
	snap := &model.AccountSnapshot{Equity: b0.JDec("totalEq"), Available: okxAvailable(b0, true), Ts: util.NowMs(), Positions: []model.Position{}, Orders: []model.OpenOrder{}}
	pos, err := o.get(ctx, "/api/v5/account/positions", []kv{{"instType", "SWAP"}}, true)
	if err != nil {
		return nil, err
	}
	for _, p := range pos.Get("data").Arr() {
		inst := p.JStr("instId")
		spec := m.Symbol(inst)
		if spec == nil {
			continue
		}
		contracts := p.JDec("pos")
		if p.JStr("posSide") == "short" {
			contracts = contracts.Abs().Neg()
		}
		if contracts.IsZero() {
			continue
		}
		snap.Positions = append(snap.Positions, model.Position{
			Base: spec.Base, Symbol: inst, Size: spec.UnitsToCoins(contracts),
			EntryPx: spec.CoinPx(p.JDec("avgPx")), MarkPx: spec.CoinPx(p.JDec("markPx")),
			Leverage: decPtr(p.JDec("lever")), Upnl: p.JDec("upl"),
		})
	}
	if withOrders {
		oo, err := o.get(ctx, "/api/v5/trade/orders-pending", []kv{{"instType", "SWAP"}}, true)
		if err != nil {
			return nil, err
		}
		for _, x := range oo.Get("data").Arr() {
			inst := x.JStr("instId")
			spec := m.Symbol(inst)
			if spec == nil {
				continue
			}
			sz := x.JDec("sz")
			filled := x.JDec("accFillSz")
			snap.Orders = append(snap.Orders, model.OpenOrder{
				ID: x.JStr("ordId"), ClientID: strPtr(x.JStr("clOrdId")), Base: spec.Base, Symbol: inst,
				Buy: x.JStr("side") == "buy", Qty: spec.UnitsToCoins(sz.Sub(filled)), OrigQty: spec.UnitsToCoins(sz),
				Price: spec.CoinPx(x.JDec("px")), Kind: okxKind(x.JStr("ordType")), ReduceOnly: x.JStr("reduceOnly") == "true",
			})
		}
		algo, err := o.get(ctx, "/api/v5/trade/orders-algo-pending", []kv{{"ordType", "conditional"}, {"instType", "SWAP"}}, true)
		if err != nil {
			return nil, err
		}
		for _, x := range algo.Get("data").Arr() {
			inst := x.JStr("instId")
			spec := m.Symbol(inst)
			if spec == nil {
				continue
			}
			tp, sl := x.JDec("tpTriggerPx"), x.JDec("slTriggerPx")
			trigger, kind := sl, model.KindStopMarket
			if !tp.IsZero() {
				trigger, kind = tp, model.KindTakeProfitMarket
			}
			sz := x.JDec("sz")
			snap.Orders = append(snap.Orders, model.OpenOrder{
				ID: x.JStr("algoId"), ClientID: strPtr(x.JStr("algoClOrdId")), Base: spec.Base, Symbol: inst,
				Buy: x.JStr("side") == "buy", Qty: spec.UnitsToCoins(sz), OrigQty: spec.UnitsToCoins(sz),
				Price: decimal.Zero, TriggerPx: decPtr(spec.CoinPx(trigger)), Kind: kind, ReduceOnly: x.JStr("reduceOnly") == "true",
			})
		}
	}
	return snap, nil
}

func (o *Okx) BBO(ctx context.Context, spec *model.ContractSpec) (decimal.Decimal, decimal.Decimal, error) {
	v, err := o.get(ctx, "/api/v5/market/ticker", []kv{{"instId", spec.Symbol}}, false)
	if err != nil {
		return decimal.Zero, decimal.Zero, err
	}
	t := v.Get("data").At(0)
	return spec.CoinPx(t.JDec("bidPx")), spec.CoinPx(t.JDec("askPx")), nil
}

func (o *Okx) Place(ctx context.Context, spec *model.ContractSpec, req *model.OrderRequest) (*model.OrderResult, error) {
	units := spec.ToUnits(req.Qty)
	if units.LessThan(spec.MinQty) || units.IsZero() {
		return nil, errs.Msg("数量低于最小下单量")
	}
	side := "sell"
	if req.Buy {
		side = "buy"
	}
	if req.Type.Kind == model.OrderTrigger {
		tp := util.Fmt(util.FloorStep(spec.VenuePx(req.Type.TriggerPx), spec.Tick))
		body := map[string]any{
			"instId": spec.Symbol, "tdMode": "cross", "side": side, "ordType": "conditional",
			"sz": util.Fmt(units), "reduceOnly": req.ReduceOnly, "algoClOrdId": req.ClientID,
		}
		if req.Type.TakeProfit {
			body["tpTriggerPx"], body["tpOrdPx"] = tp, "-1"
		} else {
			body["slTriggerPx"], body["slOrdPx"] = tp, "-1"
		}
		v, err := o.request(ctx, http.MethodPost, "/api/v5/trade/order-algo", nil, body, true, true)
		if err != nil {
			return nil, err
		}
		return &model.OrderResult{OrderID: v.Get("data").At(0).JStr("algoId"), Status: model.Open}, nil
	}
	body := map[string]any{
		"instId": spec.Symbol, "tdMode": "cross", "side": side,
		"sz": util.Fmt(units), "clOrdId": req.ClientID, "reduceOnly": req.ReduceOnly,
	}
	switch req.Type.Kind {
	case model.OrderMarket:
		body["ordType"] = "market"
	case model.OrderLimitIoc:
		body["ordType"] = "ioc"
		body["px"] = util.Fmt(roundTick(spec, req.Type.Price, req.Buy))
	case model.OrderLimit:
		body["ordType"] = "limit"
		body["px"] = util.Fmt(roundTick(spec, req.Type.Price, !req.Buy))
	}
	v, err := o.request(ctx, http.MethodPost, "/api/v5/trade/order", nil, body, true, req.ReduceOnly)
	if err != nil {
		return nil, err
	}
	ordID := v.Get("data").At(0).JStr("ordId")
	if req.Type.Kind == model.OrderLimit {
		return &model.OrderResult{OrderID: ordID, Status: model.Open}, nil
	}
	// Market / IOC results need a follow-up query for fill details.
	for range 5 {
		r, err := o.Query(ctx, spec, req.ClientID)
		if err != nil {
			return nil, err
		}
		if r != nil && r.Status != model.Open {
			return r, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(150 * time.Millisecond):
		}
	}
	return &model.OrderResult{OrderID: ordID, Status: model.Open}, nil
}

func (o *Okx) Cancel(ctx context.Context, spec *model.ContractSpec, clientID string) error {
	_, err := o.request(ctx, http.MethodPost, "/api/v5/trade/cancel-order", nil, map[string]any{"instId": spec.Symbol, "clOrdId": clientID}, true, true)
	if err == nil {
		return nil
	}
	if e, ok := errs.AsExchange(err); ok && (e.Code == "1" || strings.Contains(e.Msg, "51400") || strings.Contains(e.Msg, "51401") || strings.Contains(e.Msg, "51402")) {
		return nil
	}
	// It might be an algo order.
	if _, err2 := o.request(ctx, http.MethodPost, "/api/v5/trade/cancel-algos", nil, []any{map[string]any{"instId": spec.Symbol, "algoClOrdId": clientID}}, true, true); err2 == nil {
		return nil
	}
	return err
}

func (o *Okx) Query(ctx context.Context, spec *model.ContractSpec, clientID string) (*model.OrderResult, error) {
	v, err := o.get(ctx, "/api/v5/trade/order", []kv{{"instId", spec.Symbol}, {"clOrdId", clientID}}, true)
	if err != nil {
		if e, ok := errs.AsExchange(err); ok && (strings.Contains(e.Msg, "51603") || strings.Contains(e.Msg, "does not exist")) {
			return nil, nil
		}
		return nil, err
	}
	x := v.Get("data").At(0)
	if x.IsNull() {
		return nil, nil
	}
	filled := spec.UnitsToCoins(x.JDec("accFillSz"))
	avg := x.JDec("avgPx")
	r := &model.OrderResult{OrderID: x.JStr("ordId"), Filled: filled}
	switch x.JStr("state") {
	case "filled":
		r.Status = model.Filled
	case "live":
		r.Status = model.Open
	case "partially_filled":
		r.Status = model.Partial
	default:
		if !filled.IsZero() {
			r.Status = model.Partial
		} else {
			r.Status = model.Rejected
		}
	}
	if !avg.IsZero() {
		r.AvgPx = decPtr(spec.CoinPx(avg))
	}
	return r, nil
}

func (o *Okx) SetLeverage(ctx context.Context, spec *model.ContractSpec, leverage uint32) error {
	lev := min(max(leverage, 1), max(spec.MaxLeverage, 1))
	_, err := o.request(ctx, http.MethodPost, "/api/v5/account/set-leverage", nil, map[string]any{"instId": spec.Symbol, "lever": strconv.Itoa(int(lev)), "mgnMode": "cross"}, true, false)
	return err
}

func (o *Okx) Info(ctx context.Context) (*model.ConnectionInfo, error) {
	t0 := time.Now()
	cfg, err := o.get(ctx, "/api/v5/account/config", nil, true)
	if err != nil {
		return nil, err
	}
	latency := uint64(time.Since(t0).Milliseconds())
	c := cfg.Get("data").At(0)
	perm := c.JStr("perm")
	bal, err := o.get(ctx, "/api/v5/account/balance", nil, true)
	if err != nil {
		return nil, err
	}
	b0 := bal.Get("data").At(0)
	st, err := o.ServerTime(ctx)
	if err != nil {
		return nil, err
	}
	var skew int64
	if st != nil {
		skew = util.NowMs() - *st - int64(latency/2)
	}
	margin := "全仓"
	if c.JStr("acctLv") == "1" {
		margin = "现货模式（不支持合约）"
	}
	return &model.ConnectionInfo{
		Equity: b0.JDec("totalEq"), Available: okxAvailable(b0, false),
		OneWay: c.JStr("posMode") == "net_mode", MarginMode: margin,
		Perms: model.Permissions{
			Read:         strings.Contains(perm, "read_only") || strings.Contains(perm, "trade"),
			Trade:        strings.Contains(perm, "trade"),
			Withdraw:     util.Ptr(strings.Contains(perm, "withdraw")),
			IPRestricted: util.Ptr(c.JStr("ip") != ""),
		},
		LatencyMs: latency, ClockSkewMs: skew, MarginAsset: "USDT",
	}, nil
}

func (o *Okx) SetOneWay(ctx context.Context) error {
	_, err := o.request(ctx, http.MethodPost, "/api/v5/account/set-position-mode", nil, map[string]any{"posMode": "net_mode"}, true, false)
	return err
}

func (o *Okx) ServerTime(ctx context.Context) (*int64, error) {
	v, err := o.get(ctx, "/api/v5/public/time", nil, false)
	if err != nil {
		return nil, err
	}
	t, err := strconv.ParseInt(v.Get("data").At(0).JStr("ts"), 10, 64)
	if err != nil {
		return nil, nil
	}
	return &t, nil
}
