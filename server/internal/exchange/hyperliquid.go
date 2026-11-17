package exchange

// Hyperliquid perps. Public info endpoints need no credentials (any address
// can be a signal source). Trading uses an API (agent) wallet that signs L1
// actions with EIP-712; that wallet cannot withdraw.

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	secpecdsa "github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/gorilla/websocket"
	"github.com/shopspring/decimal"
	"golang.org/x/crypto/sha3"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/util"
)

type Hyperliquid struct {
	client  *http.Client
	testnet bool
	// Account whose state we read (main address).
	address string
	// Agent wallet key; nil for read-only address sources.
	agent  *secp256k1.PrivateKey
	bucket *TokenBucket
}

func HLBaseURL(testnet bool) string {
	if testnet {
		return "https://api.hyperliquid-testnet.xyz"
	}
	return "https://api.hyperliquid.xyz"
}

func HLWsURL(testnet bool) string {
	if testnet {
		return "wss://api.hyperliquid-testnet.xyz/ws"
	}
	return "wss://api.hyperliquid.xyz/ws"
}

func ValidAddress(a string) bool {
	if len(a) != 42 || !strings.HasPrefix(a, "0x") {
		return false
	}
	_, err := hex.DecodeString(a[2:])
	return err == nil
}

func keccak(data ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, d := range data {
		h.Write(d)
	}
	return h.Sum(nil)
}

func AddressOf(key *secp256k1.PrivateKey) string {
	pk := key.PubKey().SerializeUncompressed()
	h := keccak(pk[1:])
	return "0x" + hex.EncodeToString(h[12:])
}

func ParseKey(s string) (*secp256k1.PrivateKey, error) {
	raw, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(s), "0x"))
	if err != nil || len(raw) != 32 {
		return nil, errs.Msg("私钥格式错误，应为 64 位十六进制")
	}
	var sc secp256k1.ModNScalar
	if overflow := sc.SetByteSlice(raw); overflow || sc.IsZero() {
		return nil, errs.Msg("私钥无效")
	}
	return secp256k1.NewPrivateKey(&sc), nil
}

func NewHyperliquidPublic(address string, testnet bool, proxy string) (*Hyperliquid, error) {
	if !ValidAddress(address) {
		return nil, errs.Msg("Hyperliquid 地址应为 0x 开头的 42 位十六进制")
	}
	c, err := Client(proxy)
	if err != nil {
		return nil, err
	}
	return &Hyperliquid{client: c, testnet: testnet, address: strings.ToLower(address), bucket: hlBucket(testnet)}, nil
}

// One weight budget per network, shared by every client (the venue limits by IP).
var hlBuckets = [2]*TokenBucket{NewBucket(900, time.Minute), NewBucket(900, time.Minute)}

func hlBucket(testnet bool) *TokenBucket {
	if testnet {
		return hlBuckets[1]
	}
	return hlBuckets[0]
}

func NewHyperliquidTrading(c model.Credentials, testnet bool, proxy string) (*Hyperliquid, error) {
	key, err := ParseKey(c.Secret)
	if err != nil {
		return nil, err
	}
	main := strings.ToLower(strings.TrimSpace(c.APIKey))
	if !ValidAddress(main) {
		return nil, errs.Msg("主账户地址应为 0x 开头的 42 位十六进制")
	}
	if AddressOf(key) == main {
		return nil, errs.Msg("这是主钱包私钥。请在 Hyperliquid 创建 API 钱包，只填写 API 钱包私钥")
	}
	h, err := NewHyperliquidPublic(main, testnet, proxy)
	if err != nil {
		return nil, err
	}
	h.agent = key
	return h, nil
}

func (h *Hyperliquid) info(ctx context.Context, body map[string]any, weight float64) (util.J, error) {
	if err := h.bucket.Acquire(ctx, weight, false); err != nil {
		return util.J{}, err
	}
	b, _ := json.Marshal(body)
	req, err := newReq(ctx, http.MethodPost, HLBaseURL(h.testnet)+"/info", string(b))
	if err != nil {
		return util.J{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	return SendJSON(h.client, model.Hyperliquid, req)
}

func (h *Hyperliquid) exchange(ctx context.Context, action OMap, high bool) (util.J, error) {
	if h.agent == nil {
		return util.J{}, errs.Msg("该信号源为只读地址，不能下单")
	}
	nonce := uint64(util.NowMs())
	sig, err := SignL1Action(h.agent, action, nonce, !h.testnet)
	if err != nil {
		return util.J{}, err
	}
	body := OMap{{"action", action}, {"nonce", nonce}, {"signature", sig}, {"vaultAddress", nil}}
	b, err := json.Marshal(body)
	if err != nil {
		return util.J{}, err
	}
	if err := h.bucket.Acquire(ctx, 1, high); err != nil {
		return util.J{}, err
	}
	req, err := newReq(ctx, http.MethodPost, HLBaseURL(h.testnet)+"/exchange", string(b))
	if err != nil {
		return util.J{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	v, err := SendJSON(h.client, model.Hyperliquid, req)
	if err != nil {
		return v, err
	}
	if v.JStr("status") != "ok" {
		msg := v.String()
		if v.Has("response") {
			msg = v.Get("response").String()
		}
		retry := strings.Contains(msg, "rate") || strings.Contains(msg, "Too many")
		return v, &errs.Exchange{Code: "hl", Msg: msg, Retryable: retry}
	}
	return v, nil
}

// hlCloid: HL cloid is 16 bytes hex; our ids are 12 bytes → left-pad.
func hlCloid(clientID string) string { return fmt.Sprintf("0x%032s", clientID) }

func (h *Hyperliquid) AllMids(ctx context.Context) (map[string]decimal.Decimal, error) {
	v, err := h.info(ctx, map[string]any{"type": "allMids"}, 2)
	if err != nil {
		return nil, err
	}
	out := map[string]decimal.Decimal{}
	for k, px := range v.Obj() {
		if strings.HasPrefix(k, "@") {
			continue
		}
		out[k] = px.Dec()
	}
	return out, nil
}

// ToWire formats numbers for the wire: at most 8 decimals, no trailing zeros.
func ToWire(d decimal.Decimal) string {
	s := util.Fmt(d.RoundBank(8))
	if s == "-0" {
		return "0"
	}
	return s
}

// SignL1Action signs an L1 action via the EIP-712 "phantom agent" scheme.
func SignL1Action(key *secp256k1.PrivateKey, action OMap, nonce uint64, mainnet bool) (OMap, error) {
	data, err := msgpack(action)
	if err != nil {
		return nil, err
	}
	var n [8]byte
	binary.BigEndian.PutUint64(n[:], nonce)
	data = append(data, n[:]...)
	data = append(data, 0) // no vault
	connectionID := keccak(data)

	domainType := keccak([]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))
	var chain [32]byte
	binary.BigEndian.PutUint64(chain[24:], 1337)
	domainSep := keccak(domainType, keccak([]byte("Exchange")), keccak([]byte("1")), chain[:], make([]byte, 32))

	agentType := keccak([]byte("Agent(string source,bytes32 connectionId)"))
	src := []byte("b")
	if mainnet {
		src = []byte("a")
	}
	structHash := keccak(agentType, keccak(src), connectionID)
	digest := keccak([]byte{0x19, 0x01}, domainSep, structHash)

	// [27 + recid][R][S] for an uncompressed key.
	sig := secpecdsa.SignCompact(key, digest, false)
	return OMap{
		{"r", "0x" + hex.EncodeToString(sig[1:33])},
		{"s", "0x" + hex.EncodeToString(sig[33:65])},
		{"v", uint64(sig[0])},
	}, nil
}

func hlRoundPx(spec *model.ContractSpec, pxCoin decimal.Decimal) decimal.Decimal {
	venue := spec.VenuePx(pxCoin)
	maxDp := int32(6) - int32(spec.SzDecimals)
	if maxDp < 0 {
		maxDp = 0
	}
	if venue.Equal(venue.Truncate(0)) && venue.GreaterThanOrEqual(decimal.NewFromInt(100000)) {
		return venue
	}
	return util.RoundSig(venue, 5, maxDp)
}

func hlStatus(st util.J, spec *model.ContractSpec) (*model.OrderResult, error) {
	if f := st.Get("filled"); !f.IsNull() {
		return &model.OrderResult{OrderID: f.JStr("oid"), Status: model.Filled, Filled: spec.UnitsToCoins(f.JDec("totalSz")), AvgPx: decPtr(spec.CoinPx(f.JDec("avgPx")))}, nil
	}
	if r := st.Get("resting"); !r.IsNull() {
		return &model.OrderResult{OrderID: r.JStr("oid"), Status: model.Open}, nil
	}
	if e := st.Get("error"); !e.IsNull() {
		msg := e.Str()
		// IOC with no liquidity at the bound is a soft failure.
		return nil, &errs.Exchange{Code: "hl", Msg: msg, Retryable: strings.Contains(msg, "could not immediately match")}
	}
	if s, ok := st.AsStr(); ok && (s == "waitingForTrigger" || s == "success") {
		return &model.OrderResult{Status: model.Open}, nil
	}
	return nil, errs.Msg("未知下单结果: %s", st.String())
}

func (h *Hyperliquid) Platform() model.Platform { return model.Hyperliquid }
func (h *Hyperliquid) Testnet() bool            { return h.testnet }
func (h *Hyperliquid) CanTrade() bool           { return h.agent != nil }
func (h *Hyperliquid) NeedsContracts() bool     { return true }

func (h *Hyperliquid) Contracts(ctx context.Context) ([]model.ContractSpec, error) {
	v, err := h.info(ctx, map[string]any{"type": "meta"}, 20)
	if err != nil {
		return nil, err
	}
	var out []model.ContractSpec
	for i, a := range v.Get("universe").Arr() {
		if a.Get("isDelisted").BoolOr(false) {
			continue
		}
		name := a.JStr("name")
		base, mult := util.NormalizeBase(name)
		szd, _ := a.Get("szDecimals").Uint()
		step := decimal.New(1, -int32(szd))
		ml, _ := a.Get("maxLeverage").Uint()
		if ml == 0 {
			ml = 1
		}
		out = append(out, model.ContractSpec{
			Platform: model.Hyperliquid, Base: base, Symbol: name, CoinPerUnit: mult, PxUnit: mult,
			QtyStep: step, MinQty: step, Tick: decimal.Zero, MinNotional: decimal.NewFromInt(10),
			MaxLeverage: uint32(ml), Quote: "USDC", AssetIndex: uint32(i), SzDecimals: uint32(szd),
		})
	}
	return out, nil
}

func (h *Hyperliquid) resolve(m *Markets, coin string) (string, decimal.Decimal) {
	if s := m.Symbol(coin); s != nil {
		return s.Base, s.CoinPerUnit
	}
	return util.NormalizeBase(coin)
}

func (h *Hyperliquid) Snapshot(ctx context.Context, m *Markets, withOrders bool) (*model.AccountSnapshot, error) {
	st, err := h.info(ctx, map[string]any{"type": "clearinghouseState", "user": h.address}, 2)
	if err != nil {
		return nil, err
	}
	snap := &model.AccountSnapshot{Equity: st.Get("marginSummary").JDec("accountValue"), Available: st.JDec("withdrawable"), Ts: util.NowMs(), Positions: []model.Position{}, Orders: []model.OpenOrder{}}
	for _, ap := range st.Get("assetPositions").Arr() {
		p := ap.Get("position")
		coin := p.JStr("coin")
		base, mult := h.resolve(m, coin)
		szi := p.JDec("szi")
		if szi.IsZero() {
			continue
		}
		size := szi.Mul(mult)
		value := p.JDec("positionValue")
		snap.Positions = append(snap.Positions, model.Position{
			Base: base, Symbol: coin, Size: size, EntryPx: p.JDec("entryPx").Div(mult),
			MarkPx: value.Div(size).Abs(), Leverage: decPtr(p.Get("leverage").JDec("value")), Upnl: p.JDec("unrealizedPnl"),
		})
	}
	if withOrders {
		oo, err := h.info(ctx, map[string]any{"type": "frontendOpenOrders", "user": h.address}, 20)
		if err != nil {
			return nil, err
		}
		for _, o := range oo.Arr() {
			coin := o.JStr("coin")
			if strings.Contains(coin, ":") || strings.HasPrefix(coin, "@") {
				continue
			}
			base, mult := h.resolve(m, coin)
			isTrigger := o.Get("isTrigger").BoolOr(false)
			ot := o.JStr("orderType")
			kind := model.KindOther
			switch {
			case !isTrigger:
				kind = model.KindLimit
			case strings.Contains(ot, "Take Profit"):
				kind = model.KindTakeProfitMarket
			case strings.Contains(ot, "Stop"):
				kind = model.KindStopMarket
			}
			var cid *string
			if cl := o.JStr("cloid"); cl != "" {
				// Our 12-byte ids are left-padded to 16 bytes: strip exactly the
				// padding (an id may itself start with zeros).
				c := strings.TrimPrefix(cl, "0x")
				if len(c) == 32 && strings.HasPrefix(c, "00000000") {
					c = c[8:]
				}
				cid = &c
			}
			var trig *decimal.Decimal
			if isTrigger {
				trig = decPtr(o.JDec("triggerPx").Div(mult))
			}
			snap.Orders = append(snap.Orders, model.OpenOrder{
				ID: o.JStr("oid"), ClientID: cid, Base: base, Symbol: coin, Buy: o.JStr("side") == "B",
				Qty: o.JDec("sz").Mul(mult), OrigQty: o.JDec("origSz").Mul(mult), Price: o.JDec("limitPx").Div(mult),
				TriggerPx: trig, Kind: kind, ReduceOnly: o.Get("reduceOnly").BoolOr(false),
			})
		}
	}
	return snap, nil
}

func (h *Hyperliquid) BBO(ctx context.Context, spec *model.ContractSpec) (decimal.Decimal, decimal.Decimal, error) {
	v, err := h.info(ctx, map[string]any{"type": "l2Book", "coin": spec.Symbol}, 2)
	if err != nil {
		return decimal.Zero, decimal.Zero, err
	}
	lv := v.Get("levels")
	bid, ask := lv.At(0).At(0).JDec("px"), lv.At(1).At(0).JDec("px")
	if bid.IsZero() || ask.IsZero() {
		return decimal.Zero, decimal.Zero, errs.Msg("%s 盘口为空", spec.Symbol)
	}
	return spec.CoinPx(bid), spec.CoinPx(ask), nil
}

func (h *Hyperliquid) Place(ctx context.Context, spec *model.ContractSpec, req *model.OrderRequest) (*model.OrderResult, error) {
	units := spec.ToUnits(req.Qty)
	if units.IsZero() {
		return nil, errs.Msg("数量低于最小步长")
	}
	var px decimal.Decimal
	var t OMap
	switch req.Type.Kind {
	case model.OrderMarket:
		// No native market order: aggressive IOC 5% through the reference.
		r := req.RefPx
		if r.IsZero() {
			b, a, err := h.BBO(ctx, spec)
			if err != nil {
				return nil, err
			}
			r = b.Add(a).Div(decimal.NewFromInt(2))
		}
		px = hlRoundPx(spec, AggressivePx(r, req.Buy, decimal.RequireFromString("0.05")))
		t = OMap{{"limit", OMap{{"tif", "Ioc"}}}}
	case model.OrderLimitIoc:
		px = hlRoundPx(spec, req.Type.Price)
		t = OMap{{"limit", OMap{{"tif", "Ioc"}}}}
	case model.OrderLimit:
		px = hlRoundPx(spec, req.Type.Price)
		t = OMap{{"limit", OMap{{"tif", "Gtc"}}}}
	case model.OrderTrigger:
		tp := hlRoundPx(spec, req.Type.TriggerPx)
		// A market trigger still needs a limit bound.
		px = hlRoundPx(spec, AggressivePx(req.Type.TriggerPx, req.Buy, decimal.RequireFromString("0.1")))
		tpsl := "sl"
		if req.Type.TakeProfit {
			tpsl = "tp"
		}
		t = OMap{{"trigger", OMap{{"isMarket", true}, {"triggerPx", ToWire(tp)}, {"tpsl", tpsl}}}}
	}
	wire := OMap{{"a", spec.AssetIndex}, {"b", req.Buy}, {"p", ToWire(px)}, {"s", ToWire(units)}, {"r", req.ReduceOnly}, {"t", t}, {"c", hlCloid(req.ClientID)}}
	action := OMap{{"type", "order"}, {"orders", []any{wire}}, {"grouping", "na"}}
	v, err := h.exchange(ctx, action, req.ReduceOnly)
	if err != nil {
		return nil, err
	}
	return hlStatus(v.Get("response").Get("data").Get("statuses").At(0), spec)
}

func (h *Hyperliquid) Cancel(ctx context.Context, spec *model.ContractSpec, clientID string) error {
	action := OMap{{"type", "cancelByCloid"}, {"cancels", []any{OMap{{"asset", spec.AssetIndex}, {"cloid", hlCloid(clientID)}}}}}
	v, err := h.exchange(ctx, action, true)
	if err != nil {
		return err
	}
	st := v.Get("response").Get("data").Get("statuses").At(0)
	if e := st.Get("error"); !e.IsNull() {
		m := e.Str()
		if !strings.Contains(m, "already canceled") && !strings.Contains(m, "never placed") && !strings.Contains(m, "filled") {
			return &errs.Exchange{Code: "hl", Msg: m}
		}
	}
	return nil
}

func (h *Hyperliquid) Query(ctx context.Context, spec *model.ContractSpec, clientID string) (*model.OrderResult, error) {
	v, err := h.info(ctx, map[string]any{"type": "orderStatus", "user": h.address, "oid": hlCloid(clientID)}, 2)
	if err != nil {
		return nil, err
	}
	if v.JStr("status") != "order" {
		return nil, nil
	}
	o := v.Get("order").Get("order")
	filled := spec.UnitsToCoins(o.JDec("origSz").Sub(o.JDec("sz")))
	r := &model.OrderResult{OrderID: o.JStr("oid"), Filled: filled}
	switch v.Get("order").JStr("status") {
	case "filled":
		r.Status = model.Filled
	case "open":
		r.Status = model.Open
	default:
		if !filled.IsZero() {
			r.Status = model.Partial
		} else {
			r.Status = model.Rejected
		}
	}
	return r, nil
}

func (h *Hyperliquid) SetLeverage(ctx context.Context, spec *model.ContractSpec, leverage uint32) error {
	lev := min(max(leverage, 1), max(spec.MaxLeverage, 1))
	_, err := h.exchange(ctx, OMap{{"type", "updateLeverage"}, {"asset", spec.AssetIndex}, {"isCross", true}, {"leverage", lev}}, false)
	return err
}

func (h *Hyperliquid) Info(ctx context.Context) (*model.ConnectionInfo, error) {
	t0 := time.Now()
	st, err := h.info(ctx, map[string]any{"type": "clearinghouseState", "user": h.address}, 2)
	if err != nil {
		return nil, err
	}
	latency := uint64(time.Since(t0).Milliseconds())
	perms := model.Permissions{Read: true, Withdraw: util.Ptr(false), Transfer: util.Ptr(false)}
	if h.agent != nil {
		agent := AddressOf(h.agent)
		role, err := h.info(ctx, map[string]any{"type": "userRole", "user": agent}, 2)
		if err != nil {
			return nil, err
		}
		r := role.JStr("role")
		owner := strings.ToLower(role.Get("data").JStr("user"))
		if r != "agent" || owner != h.address {
			return nil, errs.Msg("API 钱包 %s 未被主账户 %s 授权（role=%s）", agent, h.address, r)
		}
		perms.Trade = true
		perms.Note = util.Ptr(fmt.Sprintf("API 钱包 %s…%s 已授权，不可提款", agent[:6], agent[len(agent)-4:]))
	}
	return &model.ConnectionInfo{
		Equity: st.Get("marginSummary").JDec("accountValue"), Available: st.JDec("withdrawable"),
		OneWay: true, MarginMode: "cross", Perms: perms, LatencyMs: latency, MarginAsset: "USDC",
	}, nil
}

func (h *Hyperliquid) SetOneWay(ctx context.Context) error            { return nil }
func (h *Hyperliquid) ServerTime(ctx context.Context) (*int64, error) { return nil, nil }

// WatchUser subscribes to an address's order and fill events; `notify`
// fires on every event so the engine re-reads the account at once.
// `connected` reflects the socket state. Reconnects with exponential
// backoff, first retry within 5 s. Returns when ctx is done.
func WatchUser(ctx context.Context, address string, testnet bool, notify chan<- struct{}, connected *atomic.Bool) {
	poke := func() {
		select {
		case notify <- struct{}{}:
		default:
		}
	}
	backoff := time.Second
	for ctx.Err() == nil {
		dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		ws, _, err := websocket.DefaultDialer.DialContext(dctx, HLWsURL(testnet), nil)
		cancel()
		if err != nil {
			slog.Warn("hl ws connect failed", "err", err)
			connected.Store(false)
		} else {
			backoff = time.Second
			for _, ty := range []string{"orderUpdates", "userFills", "userEvents"} {
				_ = ws.WriteJSON(map[string]any{"method": "subscribe", "subscription": map[string]any{"type": ty, "user": address}})
			}
			connected.Store(true)
			poke()
			done := make(chan struct{})
			go func() {
				defer close(done)
				for {
					_, msg, err := ws.ReadMessage()
					if err != nil {
						return
					}
					t := string(msg)
					if strings.Contains(t, `"channel":"pong"`) || strings.Contains(t, "subscriptionResponse") {
						continue
					}
					poke()
				}
			}()
			ping := time.NewTicker(30 * time.Second)
		loop:
			for {
				select {
				case <-ctx.Done():
					_ = ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
					ws.Close()
					ping.Stop()
					<-done
					return
				case <-ping.C:
					if err := ws.WriteMessage(websocket.TextMessage, []byte(`{"method":"ping"}`)); err != nil {
						break loop
					}
				case <-done:
					break loop
				}
			}
			ping.Stop()
			ws.Close()
			<-done
			connected.Store(false)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// Candle is one OHLCV bar; T is the open time in ms.
type Candle struct {
	T int64   `json:"t"`
	O float64 `json:"o"`
	H float64 `json:"h"`
	L float64 `json:"l"`
	C float64 `json:"c"`
	V float64 `json:"v"`
}

// Candles returns bars for an HL coin (the venue's own name, e.g. "kPEPE")
// between start and end (ms). Public data; the venue caps one call at 5000 bars.
func (h *Hyperliquid) Candles(ctx context.Context, coin, interval string, start, end int64) ([]Candle, error) {
	v, err := h.info(ctx, map[string]any{"type": "candleSnapshot", "req": map[string]any{"coin": coin, "interval": interval, "startTime": start, "endTime": end}}, 20)
	if err != nil {
		return nil, err
	}
	f := func(j util.J) float64 { x, _ := j.Dec().Float64(); return x }
	out := []Candle{}
	for _, c := range v.Arr() {
		t, _ := c.Get("t").Int()
		out = append(out, Candle{T: t, O: f(c.Get("o")), H: f(c.Get("h")), L: f(c.Get("l")), C: f(c.Get("c")), V: f(c.Get("v"))})
	}
	return out, nil
}
