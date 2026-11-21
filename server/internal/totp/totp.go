// Package totp implements RFC 6238 time-based one-time passwords (SHA-1,
// 6 digits, 30 s steps: what authenticator apps expect) and single-use
// recovery codes.
package totp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	digits = 6
	step   = 30
	// Codes from one step before or after are accepted (clock drift).
	window = 1
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewSecret returns a random 160-bit secret, base32 encoded.
func NewSecret() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return b32.EncodeToString(b), nil
}

// URI is the otpauth:// link authenticator apps scan.
func URI(secret, issuer, account string) string {
	label := url.PathEscape(issuer + ":" + account)
	q := url.Values{"secret": {secret}, "issuer": {issuer}, "digits": {fmt.Sprint(digits)}, "period": {fmt.Sprint(step)}, "algorithm": {"SHA1"}}
	return "otpauth://totp/" + label + "?" + q.Encode()
}

func decode(secret string) ([]byte, error) {
	s := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(secret), " ", ""))
	return b32.DecodeString(strings.TrimRight(s, "="))
}

// Code is the password for time step counter.
func code(key []byte, counter uint64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	m := hmac.New(sha1.New, key)
	m.Write(msg[:])
	sum := m.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	v := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%0*d", digits, v%1_000_000)
}

// At is the password at time t.
func At(secret string, t time.Time) (string, error) {
	key, err := decode(secret)
	if err != nil {
		return "", err
	}
	return code(key, uint64(t.Unix()/step)), nil
}

// Verify checks a password at time t; it returns the matching time step so
// the caller can refuse a code that was already used.
func Verify(secret, input string, t time.Time) (counter int64, ok bool) {
	in := strings.ReplaceAll(strings.TrimSpace(input), " ", "")
	if len(in) != digits {
		return 0, false
	}
	key, err := decode(secret)
	if err != nil {
		return 0, false
	}
	now := t.Unix() / step
	for d := int64(-window); d <= window; d++ {
		c := now + d
		if subtle.ConstantTimeCompare([]byte(code(key, uint64(c))), []byte(in)) == 1 {
			return c, true
		}
	}
	return 0, false
}

// Recovery codes look like "k7m2-9xqa": 8 characters from an alphabet
// without look-alikes.
const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"

// NewRecoveryCodes returns n fresh codes.
func NewRecoveryCodes(n int) ([]string, error) {
	out := make([]string, n)
	buf := make([]byte, 8)
	for i := range out {
		if _, err := rand.Read(buf); err != nil {
			return nil, err
		}
		var b strings.Builder
		for j, x := range buf {
			if j == 4 {
				b.WriteByte('-')
			}
			b.WriteByte(alphabet[int(x)%len(alphabet)])
		}
		out[i] = b.String()
	}
	return out, nil
}

// NormalizeRecovery lowercases a typed recovery code and drops separators.
func NormalizeRecovery(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	return strings.NewReplacer("-", "", " ", "").Replace(s)
}

// HashRecovery is the stored form of a recovery code.
func HashRecovery(code string) string {
	h := sha256.Sum256([]byte("merchandiser-recovery:" + NormalizeRecovery(code)))
	return hex.EncodeToString(h[:])
}

// LooksLikeRecovery tells a recovery code from a 6-digit password.
func LooksLikeRecovery(s string) bool { return len(NormalizeRecovery(s)) == 8 }
