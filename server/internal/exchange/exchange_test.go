package exchange

import (
	"testing"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/model"
	"merchandiser/server/internal/util"
)

func d(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func TestWireNumbers(t *testing.T) {
	for in, want := range map[string]string{"1891.4000": "1891.4", "0.000000001": "0", "100": "100"} {
		if got := ToWire(d(in)); got != want {
			t.Errorf("ToWire(%s) = %s, want %s", in, got, want)
		}
	}
}

func TestCloidPadding(t *testing.T) {
	if got := hlCloid("0abc"); got != "0x0000000000000000000000000000"+"0abc" {
		t.Fatalf("cloid %s", got)
	}
}

// Reference vector from the official Python SDK test suite
// (test_l1_action_signing_order_matches): private key 0x0123…cdef.
func TestSigningMatchesReference(t *testing.T) {
	key, err := ParseKey("0x0123456789012345678901234567890123456789012345678901234567890123")
	if err != nil {
		t.Fatal(err)
	}
	wire := OMap{{"a", uint32(1)}, {"b", true}, {"p", "100"}, {"s", "100"}, {"r", false}, {"t", OMap{{"limit", OMap{{"tif", "Gtc"}}}}}}
	action := OMap{{"type", "order"}, {"orders", []any{wire}}, {"grouping", "na"}}
	sig, err := SignL1Action(key, action, 0, true)
	if err != nil {
		t.Fatal(err)
	}
	if sig[0].V != "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e" {
		t.Errorf("r = %v", sig[0].V)
	}
	if sig[1].V != "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e" {
		t.Errorf("s = %v", sig[1].V)
	}
	if sig[2].V != uint64(28) {
		t.Errorf("v = %v", sig[2].V)
	}
}

func TestSignerDetection(t *testing.T) {
	hmac := ""
	for range 64 {
		hmac += "a"
	}
	if s, _ := signerFromSecret(hmac); s.kind() != "HMAC" {
		t.Fatal("hmac")
	}
	pem := "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n-----END PRIVATE KEY-----"
	s, err := signerFromSecret(pem)
	if err != nil || s.kind() != "Ed25519" {
		t.Fatalf("pem: %v", err)
	}
	// RFC 8032 signature of the empty message, base64 + URL-encoded.
	if got, want := s.sign(""), enc("5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc+bRr0lv18FlbviRlUUFDjnoQCw=="); got != want {
		t.Fatalf("sig %s != %s", got, want)
	}
	for _, in := range []string{
		"MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g",
		"-----BEGIN PRIVATE KEY-----MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g-----END PRIVATE KEY-----",
		"-----BEGIN PRIVATE KEY----- MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g -----END PRIVATE KEY-----",
	} {
		if s, err := signerFromSecret(in); err != nil || s.kind() != "Ed25519" {
			t.Fatalf("%q: %v", in, err)
		}
	}
	if _, err := signerFromSecret("-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----"); err == nil {
		t.Fatal("public key accepted")
	}
}

func TestPaperFillsAndPnl(t *testing.T) {
	s := &PaperState{Cash: d("1000"), Positions: map[string]*PaperPos{}}
	applyFill(s, "BTC", true, d("1"), d("100"), decimal.Zero)
	applyFill(s, "BTC", true, d("1"), d("110"), decimal.Zero)
	if !s.Positions["BTC"].Entry.Equal(d("105")) {
		t.Fatalf("entry %s", s.Positions["BTC"].Entry)
	}
	applyFill(s, "BTC", false, d("3"), d("120"), decimal.Zero)
	// Realised (120-105)*2 = 30, flipped short 1 @ 120.
	if !s.Cash.Equal(d("1030")) || !s.Positions["BTC"].Size.Equal(d("-1")) || !s.Positions["BTC"].Entry.Equal(d("120")) {
		t.Fatalf("cash %s pos %+v", s.Cash, s.Positions["BTC"])
	}
}

func TestLeadIDs(t *testing.T) {
	cases := []struct {
		p    model.Platform
		in   string
		want string
	}{
		{model.Okx, "https://www.okx.com/copy-trading/account/cb312175a85c9b68?tab=swap", "CB312175A85C9B68"},
		{model.Okx, "811846999954962957", "811846999954962957"},
		{model.Binance, "https://www.binance.com/zh-CN/copy-trading/lead-details/4708220152086930177?timeRange=30D", "4708220152086930177"},
		{model.Binance, "abc", ""},
	}
	for _, c := range cases {
		got, _ := ParseLeadID(c.p, c.in)
		if got != c.want {
			t.Errorf("%s %q = %q", c.p, c.in, got)
		}
	}
}

func TestAggregatesSubpositions(t *testing.T) {
	m := MarketsFromSpecs([]model.ContractSpec{{Platform: model.Okx, Base: "ETH", Symbol: "ETH-USDT-SWAP", CoinPerUnit: d("0.1"), PxUnit: util.One, QtyStep: d("0.01"), MinQty: d("0.01"), Tick: d("0.01"), MaxLeverage: 100, Quote: "USDT"}})
	p := func(u, e int64) rawPos {
		return rawPos{symbol: "ETH-USDT-SWAP", units: util.D(u), entry: util.D(e), mark: util.D(2000), leverage: decPtr(util.D(10)), upnl: util.One}
	}
	out := leadAggregate(&rawSnap{positions: []rawPos{p(10, 1800), p(30, 2200)}}, m)
	if len(out) != 1 || !out[0].Size.Equal(util.D(4)) || !out[0].EntryPx.Equal(util.D(2100)) || !out[0].Upnl.Equal(util.D(2)) {
		t.Fatalf("%+v", out)
	}
}

func TestBinanceSymbolsWithoutContractList(t *testing.T) {
	p := func(sym, u, px string) rawPos {
		return rawPos{symbol: sym, quote: "USDT", units: d(u), entry: d(px), mark: d(px), leverage: decPtr(util.D(5))}
	}
	out := leadAggregate(&rawSnap{equity: util.One, positions: []rawPos{p("1000PEPEUSDT", "-2", "0.01"), p("BTCUSDT", "0.5", "60000"), p("BTCUSDT_261226", "1", "61000")}}, EmptyMarkets())
	if len(out) != 2 {
		t.Fatalf("%+v", out)
	}
	byBase := map[string]model.Position{}
	for _, x := range out {
		byBase[x.Base] = x
	}
	if !byBase["BTC"].Size.Equal(d("0.5")) || !byBase["PEPE"].Size.Equal(util.D(-2000)) || !byBase["PEPE"].MarkPx.Equal(d("0.00001")) {
		t.Fatalf("%+v", byBase)
	}
}

// ---------- fills reconstruction ----------

func mkFill(t *testing.T, time int64, sym, side, ps, qty, px, realized string) Fill {
	v, _ := util.ParseJ([]byte(`{"time":` + decimal.NewFromInt(time).String() + `,"symbol":"` + sym + `","side":"` + side + `","positionSide":"` + ps + `","qty":"` + qty + `","price":"` + px + `","realizedProfit":"` + realized + `","fee":"-0.1"}`))
	f := ParseFill(v)
	if f == nil {
		t.Fatal("parse fill")
	}
	return *f
}

func page(v ...Fill) []Fill {
	// newest first, like the venue
	out := append([]Fill(nil), v...)
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j].Time > out[i].Time {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

func TestFillsAnchorAndDuplicates(t *testing.T) {
	s := NewFillState(1000)
	p := page(mkFill(t, 900, "ETHUSDT", "SELL", "SHORT", "5", "1800", "0"), mkFill(t, 1100, "ETHUSDT", "SELL", "SHORT", "2", "1810", "0"))
	if n := s.Ingest(p); n != 1 {
		t.Fatalf("applied %d", n)
	}
	if n := s.Ingest(p); n != 0 {
		t.Fatalf("reapplied %d", n)
	}
	pos := s.Positions()
	if len(pos) != 1 || !pos[0].Qty.Equal(d("-2")) || !pos[0].Entry.Equal(d("1810")) {
		t.Fatalf("%+v", pos)
	}
}

func TestIdenticalFillsCountSeparately(t *testing.T) {
	s := NewFillState(0)
	a := mkFill(t, 5, "AKEUSDT", "BUY", "LONG", "452", "0.011", "0")
	if n := s.Ingest(page(a, a)); n != 2 {
		t.Fatal(n)
	}
	if n := s.Ingest(page(a, a, a)); n != 1 {
		t.Fatal(n)
	}
	if !s.Positions()[0].Qty.Equal(d("1356")) {
		t.Fatal(s.Positions())
	}
}

func TestClosingInvisiblePositionNeverFlips(t *testing.T) {
	s := NewFillState(0)
	s.Ingest(page(mkFill(t, 1, "BTCUSDT", "SELL", "LONG", "3", "60000", "120"), mkFill(t, 2, "BTCUSDT", "SELL", "SHORT", "1", "60100", "0")))
	if p := s.Positions(); len(p) != 1 || !p[0].Qty.Equal(d("-1")) {
		t.Fatal(p)
	}
	s.Ingest(page(mkFill(t, 3, "BTCUSDT", "BUY", "SHORT", "0.4", "59900", "80"), mkFill(t, 4, "BTCUSDT", "BUY", "SHORT", "5", "59800", "200")))
	if p := s.Positions(); len(p) != 0 {
		t.Fatal(p)
	}
}

func TestOneWayMode(t *testing.T) {
	s := NewFillState(0)
	s.Ingest(page(mkFill(t, 1, "SOLUSDT", "SELL", "BOTH", "10", "70", "15")))
	if len(s.Positions()) != 0 {
		t.Fatal(s.Positions())
	}
	s.Ingest(page(mkFill(t, 2, "SOLUSDT", "BUY", "BOTH", "4", "71", "0"), mkFill(t, 3, "SOLUSDT", "SELL", "BOTH", "1", "72", "1"), mkFill(t, 4, "SOLUSDT", "SELL", "BOTH", "5", "72", "0")))
	if p := s.Positions(); len(p) != 1 || !p[0].Qty.Equal(d("-2")) {
		t.Fatal(p)
	}
}

func TestOldFillsNeverReapplied(t *testing.T) {
	s := NewFillState(0)
	old := mkFill(t, 1000, "BTCUSDT", "BUY", "LONG", "1", "60000", "0")
	s.Ingest([]Fill{old})
	nw := mkFill(t, 1000+3_600_000, "BTCUSDT", "BUY", "LONG", "2", "61000", "0")
	if n := s.Ingest(page(nw, old)); n != 1 {
		t.Fatal(n)
	}
	if n := s.Ingest(page(nw, old)); n != 0 {
		t.Fatal(n)
	}
	if !s.Positions()[0].Qty.Equal(d("3")) {
		t.Fatal(s.Positions())
	}
}

func TestMsgpackCompactInts(t *testing.T) {
	b, _ := msgpack(OMap{{"a", uint32(200)}, {"b", uint32(70000)}})
	want := []byte{0x82, 0xa1, 'a', 0xcc, 200, 0xa1, 'b', 0xce, 0, 1, 0x11, 0x70}
	if string(b) != string(want) {
		t.Fatalf("%x", b)
	}
}

func TestBinanceTradFiPerpsAreListed(t *testing.T) {
	mk := func(sym, base, ct string) util.J {
		v, err := util.ParseJ([]byte(`{"symbol":"` + sym + `","contractType":"` + ct + `","status":"TRADING","baseAsset":"` + base + `","quoteAsset":"USDT","filters":[{"filterType":"LOT_SIZE","stepSize":"0.01","minQty":"0.01"},{"filterType":"PRICE_FILTER","tickSize":"0.01"}]}`))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	for _, c := range []struct{ sym, base string }{{"NVDAUSDT", "NVDA"}, {"SKHYNIXUSDT", "SKHYNIX"}} {
		s := bnSpec(mk(c.sym, c.base, "TRADIFI_PERPETUAL"))
		if s == nil || s.Base != c.base || s.Symbol != c.sym {
			t.Fatalf("%s: %+v", c.sym, s)
		}
	}
	if bnSpec(mk("BTCUSDT_261226", "BTC", "CURRENT_QUARTER")) != nil {
		t.Fatal("delivery contract should be skipped")
	}
}
