// Package util holds decimal helpers and loose JSON accessors shared by the
// venue adapters and the engine.
package util

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"

	"github.com/shopspring/decimal"
)

func init() {
	// rust_decimal keeps 28 significant digits; stay close to it.
	decimal.DivisionPrecision = 24
}

var (
	Zero    = decimal.Zero
	One     = decimal.NewFromInt(1)
	Hundred = decimal.NewFromInt(100)
)

func NowMs() int64 { return time.Now().UnixMilli() }

// D builds a decimal from an int.
func D(i int64) decimal.Decimal { return decimal.NewFromInt(i) }

// Dec parses a decimal, returning zero on failure.
func Dec(s string) decimal.Decimal {
	d, err := decimal.NewFromString(strings.TrimSpace(s))
	if err != nil {
		return decimal.Zero
	}
	return d
}

// DecP parses an optional decimal string.
func DecP(s *string) decimal.Decimal {
	if s == nil {
		return decimal.Zero
	}
	return Dec(*s)
}

// RoundDp rounds to dp places, half to even (rust_decimal's default).
func RoundDp(v decimal.Decimal, dp int32) decimal.Decimal { return v.RoundBank(dp) }

func FloorStep(v, step decimal.Decimal) decimal.Decimal {
	if step.IsZero() {
		return v
	}
	return v.Div(step).Floor().Mul(step)
}

func RoundStep(v, step decimal.Decimal) decimal.Decimal {
	if step.IsZero() {
		return v
	}
	return v.Div(step).RoundBank(0).Mul(step)
}

// RoundSig rounds to `sig` significant figures and at most `maxDp` decimals.
func RoundSig(v decimal.Decimal, sig, maxDp int32) decimal.Decimal {
	if v.IsZero() {
		return v
	}
	intDigits := int32(v.NumDigits()) + v.Exponent()
	r := v.RoundBank(sig - intDigits)
	return r.RoundBank(maxDp)
}

// Fmt renders a decimal without trailing zeros.
func Fmt(d decimal.Decimal) string {
	if d.IsZero() {
		return "0"
	}
	return d.String()
}

// Pct returns a / b × 100, rounded to 4 places.
func Pct(a, b decimal.Decimal) decimal.Decimal {
	if b.IsZero() {
		return decimal.Zero
	}
	return a.Div(b).Mul(Hundred).RoundBank(4)
}

func Signum(d decimal.Decimal) decimal.Decimal { return decimal.NewFromInt(int64(d.Sign())) }

func MaxD(a, b decimal.Decimal) decimal.Decimal {
	if a.GreaterThan(b) {
		return a
	}
	return b
}

func MinD(a, b decimal.Decimal) decimal.Decimal {
	if a.LessThan(b) {
		return a
	}
	return b
}

// NormalizeBase normalises a venue base symbol to the plain coin and returns
// the coin multiplier. `1000PEPE` → ("PEPE", 1000), `kPEPE` → ("PEPE", 1000),
// `1MBABYDOGE` → ("BABYDOGE", 1_000_000).
func NormalizeBase(raw string) (string, decimal.Decimal) {
	prefixes := []struct {
		p string
		m int64
	}{{"1000000", 1_000_000}, {"100000", 100_000}, {"10000", 10_000}, {"1000", 1_000}, {"1M", 1_000_000}, {"k", 1_000}}
	for _, x := range prefixes {
		if rest, ok := strings.CutPrefix(raw, x.p); ok {
			// Only counts when followed by an upper-case ticker (kPEPE, 1MBABYDOGE).
			if len(rest) >= 2 && rest[0] >= 'A' && rest[0] <= 'Z' {
				return rest, decimal.NewFromInt(x.m)
			}
		}
	}
	return strings.ToUpper(raw), One
}

// NewClientID returns 24 lowercase hex chars.
func NewClientID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// NewUUID returns a random v4 UUID string.
func NewUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// StartOfTodayMs is local midnight in ms (set TZ in the container).
func StartOfTodayMs() int64 {
	n := time.Now()
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.Local).UnixMilli()
}

func Ptr[T any](v T) *T { return &v }

// Truncate keeps the first n runes.
func Truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
