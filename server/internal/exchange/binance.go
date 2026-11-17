package exchange

// Binance USDⓈ-M futures. Quantities are coins of the symbol's base
// (1000PEPEUSDT counts in units of 1000 PEPE).

import (
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/util"
)

// signer: Binance issues HMAC keys ("system generated") and also accepts
// self-generated Ed25519 / RSA keys, where the "secret" field holds the
// private key (PEM or bare base64 PKCS#8).
type signer struct {
	hmac []byte
	ed   ed25519.PrivateKey
	rsa  *rsa.PrivateKey
}

func signerFromSecret(secret string) (*signer, error) {
	s := strings.TrimSpace(secret)
	looksPem := strings.Contains(s, "-----BEGIN")
	// HMAC secrets are 64 plain alphanumerics. A bare base64 PKCS#8 key
	// starts with the DER prefix of an Ed25519 ("MC4C") or RSA ("MII") key.
	looksB64Der := !looksPem && (strings.HasPrefix(s, "MC4C") || strings.HasPrefix(s, "MII")) && len(s) >= 64
	if !looksPem && !looksB64Der {
		return &signer{hmac: []byte(s)}, nil
	}
	label := "PRIVATE KEY"
	if strings.Contains(s, "RSA PRIVATE KEY") {
		label = "RSA PRIVATE KEY"
	} else if strings.Contains(s, "PUBLIC KEY") {
		label = "PUBLIC KEY"
	}
	if label == "PUBLIC KEY" {
		return nil, errs.Msg("Secret 一栏填的是公钥。自生成（Ed25519 / RSA）Key 需要填写私钥，公钥只需上传到币安")
	}
	// Drop the "-----BEGIN …-----" / "-----END …-----" markers wherever they
	// are, then all whitespace, leaving the base64 body.
	body := s
	for {
		i := strings.Index(body, "-----")
		if i < 0 {
			break
		}
		j := strings.Index(body[i+5:], "-----")
		if j < 0 {
			break
		}
		body = body[:i] + body[i+5+j+5:]
	}
	body = strings.Join(strings.Fields(body), "")
	der, err := base64.StdEncoding.DecodeString(body)
	if err != nil {
		if blk, _ := pem.Decode([]byte(s)); blk != nil {
			der = blk.Bytes
		} else {
			return nil, errs.Msg("无法识别的私钥格式：请填写 PKCS#8 PEM 格式的 Ed25519 或 RSA 私钥")
		}
	}
	if k, err := x509.ParsePKCS8PrivateKey(der); err == nil {
		switch kk := k.(type) {
		case ed25519.PrivateKey:
			return &signer{ed: kk}, nil
		case *rsa.PrivateKey:
			return &signer{rsa: kk}, nil
		}
	}
	if k, err := x509.ParsePKCS1PrivateKey(der); err == nil {
		return &signer{rsa: k}, nil
	}
	return nil, errs.Msg("无法识别的私钥格式：请填写 PKCS#8 PEM 格式的 Ed25519 或 RSA 私钥")
}

func (s *signer) sign(payload string) string {
	switch {
	case s.ed != nil:
		return enc(base64.StdEncoding.EncodeToString(ed25519.Sign(s.ed, []byte(payload))))
	case s.rsa != nil:
		h := sha256.Sum256([]byte(payload))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, s.rsa, crypto.SHA256, h[:])
		return enc(base64.StdEncoding.EncodeToString(sig))
	default:
		return hex.EncodeToString(HmacSHA256(s.hmac, []byte(payload)))
	}
}

func (s *signer) kind() string {
	switch {
	case s.ed != nil:
		return "Ed25519"
	case s.rsa != nil:
		return "RSA"
	}
	return "HMAC"
}

// Live futures host, then the two non-production environments: Binance's
// newer "Demo Trading" (keys made inside binance.com demo mode) and the
// legacy futures testnet (keys made at testnet.binancefuture.com).
var (
	bnLiveHosts = []string{"https://fapi.binance.com"}
	bnTestHosts = []string{"https://demo-fapi.binance.com", "https://testnet.binancefuture.com"}
)

// Error codes Binance uses when it rejects the key itself.
func bnKeyError(code string) bool {
	switch code {
	case "-2014", "-2015", "-2008", "-1022", "401":
		return true
	}
	return false
}

type Binance struct {
	client  *http.Client
	creds   model.Credentials
	signer  *signer
	testnet bool
	// Index into the host list that accepted this key.
	host      atomic.Int32
	confirmed atomic.Bool
	// Request-weight budget (2400 / min; we keep well under).
	bucket *TokenBucket
}

func NewBinance(creds model.Credentials, testnet bool, proxy string) (*Binance, error) {
	sg := &signer{}
	if creds.Secret != "" {
		var err error
		if sg, err = signerFromSecret(creds.Secret); err != nil {
			return nil, err
		}
	}
	creds.APIKey = strings.TrimSpace(creds.APIKey)
	c, err := Client(proxy)
	if err != nil {
		return nil, err
	}
	return &Binance{client: c, creds: creds, signer: sg, testnet: testnet, bucket: NewBucket(1800, time.Minute)}, nil
}

func (b *Binance) hosts() []string {
	if b.testnet {
		return bnTestHosts
	}
	return bnLiveHosts
}

func (b *Binance) base() string {
	h := b.hosts()
	return h[min(int(b.host.Load()), len(h)-1)]
}

// discover: a signed call that, until a host has accepted this key, tries the
// other environments of the same kind on a key rejection (demo vs. legacy
// testnet) and then sticks with the one that works.
func (b *Binance) discover(ctx context.Context, method, path string, params []kv, weight float64, high bool) (util.J, error) {
	hosts := b.hosts()
	if b.confirmed.Load() || len(hosts) == 1 {
		return b.request(ctx, method, b.base(), path, params, true, weight, high)
	}
	start := int(b.host.Load())
	for i := range hosts {
		idx := (start + i) % len(hosts)
		v, err := b.request(ctx, method, hosts[idx], path, params, true, weight, high)
		if e, ok := errs.AsExchange(err); ok && bnKeyError(e.Code) && i+1 < len(hosts) {
			continue
		}
		if err == nil {
			b.host.Store(int32(idx))
			b.confirmed.Store(true)
		}
		return v, err
	}
	return util.J{}, errs.Msg("unreachable")
}

// explainKeyError turns a key rejection on the futures API into an
// actionable message: checks whether the key works at all (spot API) and
// what it allows.
func (b *Binance) explainKeyError(ctx context.Context, code, msg string) error {
	ipTxt := ""
	if _, after, ok := strings.Cut(msg, "request ip:"); ok {
		ip := strings.TrimSuffix(strings.TrimSpace(after), ".")
		ipTxt = fmt.Sprintf("（币安看到的请求 IP：%s）", ip)
	}
	envHint := "未勾选测试网：如果这是币安「模拟交易」(Demo) 或 testnet.binancefuture.com 创建的 Key，请勾选测试网。"
	if b.testnet {
		envHint = "已勾选测试网：币安「模拟交易」或 testnet.binancefuture.com 创建的 Key 才能用于测试网；正式站 Key 请取消勾选测试网。"
	}
	if code == "-1022" {
		return errs.Msg("签名无效（%s）：Secret 填写有误，或 Key 类型与私钥不匹配（当前按 %s 签名）。请重新复制 Secret / 私钥，注意不要带多余字符", code, b.signer.kind())
	}
	if code == "-2014" {
		return errs.Msg("API Key 格式无效（%s）：请确认 API Key 与 Secret 没有填反，且完整复制（币安 API Key 为 64 位字符）。%s", code, envHint)
	}
	// -2015 / -2008: the key is unknown here, or valid but lacks futures
	// access or the IP is not whitelisted. The spot-side restrictions
	// endpoint tells which (only for live keys).
	if !b.testnet {
		r, err := b.request(ctx, http.MethodGet, "https://api.binance.com", "/sapi/v1/account/apiRestrictions", nil, true, 1, false)
		if err == nil {
			var why []string
			if v, ok := r.Get("enableReading").Bool(); ok && !v {
				why = append(why, "该 Key 未开启「允许读取」")
			}
			if v, ok := r.Get("ipRestrict").Bool(); ok && v {
				why = append(why, fmt.Sprintf("该 Key 绑定了 IP 白名单，本机出口 IP 不在白名单内%s；使用代理时需把代理的出口 IP 加入白名单", ipTxt))
			}
			if len(why) == 0 {
				why = append(why, "该 Key 本身有效，但无法访问 U 本位合约：请确认账户已开通合约，并且该 Key 是在开通合约之后创建的（开通前创建的 Key 需要删除重建）")
			}
			return errs.Msg("币安拒绝访问合约接口（%s）：%s", code, strings.Join(why, "；"))
		}
	}
	return errs.Msg("币安不认可此 API Key（%s）%s。可能原因：① Key 复制不完整或与 Secret 填反；② %s ③ 绑定了 IP 白名单而本机 / 代理出口 IP 不在其中；④ Key 已被删除或过期（未绑定 IP 的 Key 长期不用会被币安自动停用）", code, ipTxt, envHint)
}

func (b *Binance) request(ctx context.Context, method, base, path string, params []kv, signed bool, weight float64, high bool) (util.J, error) {
	if err := b.bucket.Acquire(ctx, weight, high); err != nil {
		return util.J{}, err
	}
	qs := buildQS(params)
	if signed {
		if qs != "" {
			qs += "&"
		}
		qs += fmt.Sprintf("timestamp=%d&recvWindow=5000", util.NowMs())
		qs += "&signature=" + b.signer.sign(qs)
	}
	u := base + path
	if qs != "" {
		u += "?" + qs
	}
	req, err := newReq(ctx, method, u, "")
	if err != nil {
		return util.J{}, err
	}
	if b.creds.APIKey != "" {
		req.Header.Set("X-MBX-APIKEY", b.creds.APIKey)
	}
	v, err := SendJSON(b.client, model.Binance, req)
	if e, ok := errs.AsExchange(err); ok {
		// Geo-block: Binance refuses the network's location. Not a key
		// problem and not worth retrying.
		if e.Code == "451" {
			return v, errs.Msg("币安拒绝了当前网络所在地区的访问（HTTP 451：受限地区，见币安用户协议 Eligibility 条款）。这与 API Key 无关，重试也不会成功。请确认你所在地区可以合规使用币安；若服务器部署在受限地区（如部分海外云服务器），请更换部署地区或为该连接配置代理。")
		}
		// Binance puts its own code in the JSON body.
		bcode, bmsg := e.Code, e.Msg
		if j, perr := util.ParseJ([]byte(e.Msg)); perr == nil {
			if j.Has("code") {
				bcode = j.JStr("code")
			}
			if m, ok := j.Get("msg").AsStr(); ok {
				bmsg = m
			}
		}
		if bcode == "-1003" {
			return v, &errs.RateLimited{Msg: bmsg}
		}
		retry := e.Retryable || bcode == "-1001" || bcode == "-1007" || bcode == "-1021"
		return v, &errs.Exchange{Code: bcode, Msg: bmsg, Retryable: retry}
	}
	return v, err
}

func (b *Binance) fapi(ctx context.Context, method, path string, params []kv, signed bool, weight float64) (util.J, error) {
	if signed {
		return b.discover(ctx, method, path, params, weight, false)
	}
	return b.request(ctx, method, b.base(), path, params, false, weight, false)
}

func bnFilter(s util.J, ty string) (util.J, bool) {
	for _, f := range s.Get("filters").Arr() {
		if f.JStr("filterType") == ty {
			return f, true
		}
	}
	return util.J{}, false
}

func bnSpec(s util.J) *model.ContractSpec {
	if s.JStr("contractType") != "PERPETUAL" || s.JStr("status") != "TRADING" {
		return nil
	}
	quote := s.JStr("quoteAsset")
	if quote != "USDT" && quote != "USDC" {
		return nil
	}
	base, mult := util.NormalizeBase(s.JStr("baseAsset"))
	lot, ok := bnFilter(s, "LOT_SIZE")
	if !ok {
		return nil
	}
	step := lot.JDec("stepSize")
	if mkt, ok := bnFilter(s, "MARKET_LOT_SIZE"); ok {
		step = util.MaxD(step, mkt.JDec("stepSize"))
	}
	spec := &model.ContractSpec{
		Platform: model.Binance, Base: base, Symbol: s.JStr("symbol"),
		CoinPerUnit: mult, PxUnit: mult, QtyStep: step, MinQty: lot.JDec("minQty"),
		MaxLeverage: 125, Quote: quote,
	}
	if f, ok := bnFilter(s, "PRICE_FILTER"); ok {
		spec.Tick = f.JDec("tickSize")
	}
	if f, ok := bnFilter(s, "MIN_NOTIONAL"); ok {
		spec.MinNotional = f.JDec("notional")
	}
	return spec
}

func bnKind(t string) model.OrderKind {
	switch t {
	case "LIMIT":
		return model.KindLimit
	case "STOP_MARKET", "STOP":
		return model.KindStopMarket
	case "TAKE_PROFIT_MARKET", "TAKE_PROFIT":
		return model.KindTakeProfitMarket
	}
	return model.KindOther
}

func bnResult(spec *model.ContractSpec, o util.J) *model.OrderResult {
	filled := spec.UnitsToCoins(o.JDec("executedQty"))
	avg := o.JDec("avgPrice")
	r := &model.OrderResult{OrderID: o.JStr("orderId"), Filled: filled}
	switch o.JStr("status") {
	case "FILLED":
		r.Status = model.Filled
	case "NEW":
		r.Status = model.Open
	case "PARTIALLY_FILLED":
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
	return r
}

func (b *Binance) Platform() model.Platform { return model.Binance }
func (b *Binance) Testnet() bool            { return b.testnet }
func (b *Binance) CanTrade() bool           { return true }
func (b *Binance) NeedsContracts() bool     { return true }

func (b *Binance) Contracts(ctx context.Context) ([]model.ContractSpec, error) {
	v, err := b.fapi(ctx, http.MethodGet, "/fapi/v1/exchangeInfo", nil, false, 1)
	if err != nil {
		return nil, err
	}
	var out []model.ContractSpec
	for _, s := range v.Get("symbols").Arr() {
		if sp := bnSpec(s); sp != nil {
			out = append(out, *sp)
		}
	}
	return out, nil
}

func (b *Binance) Snapshot(ctx context.Context, m *Markets, withOrders bool) (*model.AccountSnapshot, error) {
	acct, err := b.fapi(ctx, http.MethodGet, "/fapi/v2/account", nil, true, 5)
	if err != nil {
		return nil, err
	}
	snap := &model.AccountSnapshot{Equity: acct.JDec("totalMarginBalance"), Available: acct.JDec("availableBalance"), Ts: util.NowMs(), Positions: []model.Position{}, Orders: []model.OpenOrder{}}
	pr, err := b.fapi(ctx, http.MethodGet, "/fapi/v2/positionRisk", nil, true, 5)
	if err != nil {
		return nil, err
	}
	for _, p := range pr.Arr() {
		amt := p.JDec("positionAmt")
		if amt.IsZero() {
			continue
		}
		sym := p.JStr("symbol")
		spec := m.Symbol(sym)
		if spec == nil {
			continue
		}
		snap.Positions = append(snap.Positions, model.Position{
			Base: spec.Base, Symbol: sym, Size: spec.UnitsToCoins(amt),
			EntryPx: spec.CoinPx(p.JDec("entryPrice")), MarkPx: spec.CoinPx(p.JDec("markPrice")),
			Leverage: decPtr(p.JDec("leverage")), Upnl: p.JDec("unRealizedProfit"),
		})
	}
	if withOrders {
		oo, err := b.fapi(ctx, http.MethodGet, "/fapi/v1/openOrders", nil, true, 40)
		if err != nil {
			return nil, err
		}
		for _, o := range oo.Arr() {
			sym := o.JStr("symbol")
			spec := m.Symbol(sym)
			if spec == nil {
				continue
			}
			orig, filled, stop := o.JDec("origQty"), o.JDec("executedQty"), o.JDec("stopPrice")
			var trig *decimal.Decimal
			if !stop.IsZero() {
				trig = decPtr(spec.CoinPx(stop))
			}
			cid := o.JStr("clientOrderId")
			snap.Orders = append(snap.Orders, model.OpenOrder{
				ID: o.JStr("orderId"), ClientID: &cid, Base: spec.Base, Symbol: sym,
				Buy: o.JStr("side") == "BUY", Qty: spec.UnitsToCoins(orig.Sub(filled)), OrigQty: spec.UnitsToCoins(orig),
				Price: spec.CoinPx(o.JDec("price")), TriggerPx: trig, Kind: bnKind(o.JStr("type")),
				ReduceOnly: o.Get("reduceOnly").BoolOr(false) || o.Get("closePosition").BoolOr(false),
			})
		}
	}
	return snap, nil
}

func (b *Binance) BBO(ctx context.Context, spec *model.ContractSpec) (decimal.Decimal, decimal.Decimal, error) {
	v, err := b.fapi(ctx, http.MethodGet, "/fapi/v1/ticker/bookTicker", []kv{{"symbol", spec.Symbol}}, false, 2)
	if err != nil {
		return decimal.Zero, decimal.Zero, err
	}
	return spec.CoinPx(v.JDec("bidPrice")), spec.CoinPx(v.JDec("askPrice")), nil
}

func (b *Binance) Place(ctx context.Context, spec *model.ContractSpec, req *model.OrderRequest) (*model.OrderResult, error) {
	units := spec.ToUnits(req.Qty)
	if units.IsZero() || units.LessThan(spec.MinQty) {
		return nil, errs.Msg("数量低于最小下单量")
	}
	side := "SELL"
	if req.Buy {
		side = "BUY"
	}
	p := []kv{{"symbol", spec.Symbol}, {"side", side}, {"quantity", util.Fmt(units)}, {"newClientOrderId", req.ClientID}, {"newOrderRespType", "RESULT"}}
	if req.ReduceOnly {
		p = append(p, kv{"reduceOnly", "true"})
	}
	switch req.Type.Kind {
	case model.OrderMarket:
		p = append(p, kv{"type", "MARKET"})
	case model.OrderLimitIoc:
		p = append(p, kv{"type", "LIMIT"}, kv{"timeInForce", "IOC"}, kv{"price", util.Fmt(roundTick(spec, req.Type.Price, req.Buy))})
	case model.OrderLimit:
		p = append(p, kv{"type", "LIMIT"}, kv{"timeInForce", "GTC"}, kv{"price", util.Fmt(roundTick(spec, req.Type.Price, !req.Buy))})
	case model.OrderTrigger:
		t := "STOP_MARKET"
		if req.Type.TakeProfit {
			t = "TAKE_PROFIT_MARKET"
		}
		p = append(p, kv{"type", t}, kv{"stopPrice", util.Fmt(roundTick(spec, req.Type.TriggerPx, false))}, kv{"workingType", "MARK_PRICE"})
	}
	v, err := b.discover(ctx, http.MethodPost, "/fapi/v1/order", p, 1, req.ReduceOnly)
	if err != nil {
		return nil, err
	}
	return bnResult(spec, v), nil
}

func (b *Binance) Cancel(ctx context.Context, spec *model.ContractSpec, clientID string) error {
	_, err := b.discover(ctx, http.MethodDelete, "/fapi/v1/order", []kv{{"symbol", spec.Symbol}, {"origClientOrderId", clientID}}, 1, true)
	if e, ok := errs.AsExchange(err); ok && e.Code == "-2011" {
		return nil
	}
	return err
}

func (b *Binance) Query(ctx context.Context, spec *model.ContractSpec, clientID string) (*model.OrderResult, error) {
	v, err := b.fapi(ctx, http.MethodGet, "/fapi/v1/order", []kv{{"symbol", spec.Symbol}, {"origClientOrderId", clientID}}, true, 1)
	if e, ok := errs.AsExchange(err); ok && e.Code == "-2013" {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return bnResult(spec, v), nil
}

func (b *Binance) SetLeverage(ctx context.Context, spec *model.ContractSpec, leverage uint32) error {
	_, err := b.fapi(ctx, http.MethodPost, "/fapi/v1/leverage", []kv{{"symbol", spec.Symbol}, {"leverage", strconv.Itoa(int(min(max(leverage, 1), 125)))}}, true, 1)
	return err
}

func (b *Binance) Info(ctx context.Context) (*model.ConnectionInfo, error) {
	t0 := time.Now()
	acct, err := b.fapi(ctx, http.MethodGet, "/fapi/v2/account", nil, true, 5)
	if err != nil {
		if e, ok := errs.AsExchange(err); ok && bnKeyError(e.Code) {
			return nil, b.explainKeyError(ctx, e.Code, e.Msg)
		}
		return nil, err
	}
	latency := uint64(time.Since(t0).Milliseconds())
	dual, err := b.fapi(ctx, http.MethodGet, "/fapi/v1/positionSide/dual", nil, true, 30)
	if err != nil {
		return nil, err
	}
	perms := model.Permissions{Read: true, Trade: acct.Get("canTrade").BoolOr(false)}
	if !b.testnet {
		// API key restrictions live on the spot domain.
		r, err := b.request(ctx, http.MethodGet, "https://api.binance.com", "/sapi/v1/account/apiRestrictions", nil, true, 1, false)
		if err != nil {
			perms.Note = util.Ptr(fmt.Sprintf("无法读取 Key 权限: %v", err))
		} else {
			if v, ok := r.Get("enableFutures").Bool(); ok {
				perms.Trade = v
			}
			if v, ok := r.Get("enableWithdrawals").Bool(); ok {
				perms.Withdraw = &v
			}
			if v, ok := r.Get("enableInternalTransfer").Bool(); ok {
				perms.Transfer = &v
			} else if v, ok := r.Get("permitsUniversalTransfer").Bool(); ok {
				perms.Transfer = &v
			}
			if v, ok := r.Get("ipRestrict").Bool(); ok {
				perms.IPRestricted = &v
			}
		}
	}
	st, err := b.ServerTime(ctx)
	if err != nil {
		return nil, err
	}
	var skew int64
	if st != nil {
		skew = util.NowMs() - *st - int64(latency/2)
	}
	margin := "单币保证金"
	if acct.Get("multiAssetsMargin").BoolOr(false) {
		margin = "联合保证金"
	}
	return &model.ConnectionInfo{
		Equity: acct.JDec("totalMarginBalance"), Available: acct.JDec("availableBalance"),
		OneWay: !dual.Get("dualSidePosition").BoolOr(false), MarginMode: margin, Perms: perms,
		LatencyMs: latency, ClockSkewMs: skew, MarginAsset: "USDT",
	}, nil
}

func (b *Binance) SetOneWay(ctx context.Context) error {
	_, err := b.fapi(ctx, http.MethodPost, "/fapi/v1/positionSide/dual", []kv{{"dualSidePosition", "false"}}, true, 1)
	if e, ok := errs.AsExchange(err); ok && e.Code == "-4059" {
		return nil
	}
	return err
}

func (b *Binance) ServerTime(ctx context.Context) (*int64, error) {
	v, err := b.fapi(ctx, http.MethodGet, "/fapi/v1/time", nil, false, 1)
	if err != nil {
		return nil, err
	}
	if t, ok := v.Get("serverTime").Int(); ok {
		return &t, nil
	}
	return nil, nil
}
