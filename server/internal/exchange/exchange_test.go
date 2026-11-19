package exchange

import (
	"testing"

	"github.com/shopspring/decimal"
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

func TestMsgpackCompactInts(t *testing.T) {
	b, _ := msgpack(OMap{{"a", uint32(200)}, {"b", uint32(70000)}})
	want := []byte{0x82, 0xa1, 'a', 0xcc, 200, 0xa1, 'b', 0xce, 0, 1, 0x11, 0x70}
	if string(b) != string(want) {
		t.Fatalf("%x", b)
	}
}
