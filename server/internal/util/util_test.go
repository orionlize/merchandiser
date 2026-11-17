package util

import (
	"testing"

	"github.com/shopspring/decimal"
)

func d(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func TestBaseNormalization(t *testing.T) {
	cases := map[string]struct {
		base string
		mult int64
	}{"1000PEPE": {"PEPE", 1000}, "kPEPE": {"PEPE", 1000}, "BTC": {"BTC", 1}, "1INCH": {"1INCH", 1}, "1MBABYDOGE": {"BABYDOGE", 1000000}}
	for in, w := range cases {
		b, m := NormalizeBase(in)
		if b != w.base || !m.Equal(D(w.mult)) {
			t.Errorf("%s → %s %s", in, b, m)
		}
	}
}

func TestSteps(t *testing.T) {
	if !FloorStep(d("0.0567"), d("0.001")).Equal(d("0.056")) {
		t.Error("floor")
	}
	if !FloorStep(d("17"), d("1")).Equal(d("17")) {
		t.Error("floor int")
	}
	if got := RoundSig(d("91234.567"), 5, 5); !got.Equal(d("91235")) {
		t.Error("sig big", got)
	}
	if got := RoundSig(d("0.000123456"), 5, 6); !got.Equal(d("0.000123")) {
		t.Error("sig small", got)
	}
}

func TestJ(t *testing.T) {
	j, err := ParseJ([]byte(`{"a":[{"b":"1.50","n":12345678901234567890,"t":true}],"code":-2015}`))
	if err != nil {
		t.Fatal(err)
	}
	if j.Get("a").At(0).JStr("b") != "1.50" || !j.Get("a").At(0).JDec("n").Equal(d("12345678901234567890")) || j.Get("a").At(0).JStr("t") != "true" || j.JStr("code") != "-2015" {
		t.Fatal("accessors")
	}
	if !j.Get("missing").Get("x").At(3).IsNull() {
		t.Fatal("missing")
	}
}
