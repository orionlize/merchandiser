package totp

import (
	"testing"
	"time"
)

// RFC 6238 appendix B, SHA-1 (8-digit vectors truncated to the last 6).
func TestRFCVectors(t *testing.T) {
	secret := b32.EncodeToString([]byte("12345678901234567890"))
	cases := map[int64]string{59: "287082", 1111111109: "081804", 1111111111: "050471", 1234567890: "005924", 2000000000: "279037"}
	for ts, want := range cases {
		got, err := At(secret, time.Unix(ts, 0))
		if err != nil || got != want {
			t.Fatalf("t=%d: got %s, want %s (%v)", ts, got, want, err)
		}
	}
}

func TestVerifyWindow(t *testing.T) {
	s, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	prev, _ := At(s, now.Add(-30*time.Second))
	if _, ok := Verify(s, prev, now); !ok {
		t.Fatal("previous step should verify")
	}
	old, _ := At(s, now.Add(-90*time.Second))
	if _, ok := Verify(s, old, now); ok {
		t.Fatal("three steps back should not verify")
	}
	if _, ok := Verify(s, "12345", now); ok {
		t.Fatal("short code verified")
	}
}

func TestRecovery(t *testing.T) {
	codes, err := NewRecoveryCodes(10)
	if err != nil || len(codes) != 10 {
		t.Fatal(err)
	}
	c := codes[0]
	if !LooksLikeRecovery(c) || LooksLikeRecovery("123456") {
		t.Fatal("recovery shape")
	}
	if HashRecovery(c) != HashRecovery(" "+string([]byte(c)[:4])+string([]byte(c)[5:])+" ") {
		t.Fatal("normalisation")
	}
}
