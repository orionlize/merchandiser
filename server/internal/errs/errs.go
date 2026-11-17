// Package errs holds the error kinds the engine distinguishes: plain
// messages, venue rejections (optionally retryable), rate limits and
// transport failures.
package errs

import (
	"errors"
	"fmt"
)

// Msg is a user-facing message.
func Msg(format string, a ...any) error {
	if len(a) == 0 {
		return errors.New(format)
	}
	return fmt.Errorf(format, a...)
}

// Exchange is an error reported by a venue.
type Exchange struct {
	Code      string
	Msg       string
	Retryable bool
}

func (e *Exchange) Error() string {
	return fmt.Sprintf("交易所返回错误 [%s]: %s", e.Code, e.Msg)
}

// RateLimited means the venue (or our own budget) refused for now.
type RateLimited struct{ Msg string }

func (e *RateLimited) Error() string { return "限频: " + e.Msg }

// Net wraps a transport failure (timeout, connect, TLS …).
type Net struct{ Err error }

func (e *Net) Error() string { return "网络错误: " + e.Err.Error() }
func (e *Net) Unwrap() error { return e.Err }

// AsExchange returns the venue error, if err is one.
func AsExchange(err error) (*Exchange, bool) {
	var e *Exchange
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// IsRateLimited reports whether err is a rate limit.
func IsRateLimited(err error) bool {
	var r *RateLimited
	return errors.As(err, &r)
}

// Retryable reports whether a retry with the same client order id is worthwhile.
func Retryable(err error) bool {
	if err == nil {
		return false
	}
	var n *Net
	if errors.As(err, &n) {
		return true
	}
	if IsRateLimited(err) {
		return true
	}
	if e, ok := AsExchange(err); ok {
		return e.Retryable
	}
	return false
}
