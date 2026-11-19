package exchange

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/util"
)

var (
	clientsMu sync.Mutex
	clients   = map[string]*http.Client{}
)

// Client returns a shared HTTP client for the given proxy ("" = environment
// proxy settings). http, https and socks5 proxies are supported.
func Client(proxy string) (*http.Client, error) {
	proxy = strings.TrimSpace(proxy)
	clientsMu.Lock()
	defer clientsMu.Unlock()
	if c, ok := clients[proxy]; ok {
		return c, nil
	}
	tr := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:   true,
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 5 * time.Second,
	}
	if proxy != "" {
		u, err := url.Parse(proxy)
		if err != nil || u.Scheme == "" || u.Host == "" {
			if err == nil {
				err = errs.Msg("缺少协议或主机")
			}
			return nil, errs.Msg("代理地址无效: %v", err)
		}
		tr.Proxy = http.ProxyURL(u)
	}
	c := &http.Client{Transport: tr, Timeout: 10 * time.Second}
	clients[proxy] = c
	return c, nil
}

// TokenBucket: `capacity` requests refilled continuously over `per`.
type TokenBucket struct {
	mu       sync.Mutex
	capacity float64
	refill   float64 // tokens per second
	tokens   float64
	last     time.Time
}

func NewBucket(capacity int, per time.Duration) *TokenBucket {
	return &TokenBucket{capacity: float64(capacity), refill: float64(capacity) / per.Seconds(), tokens: float64(capacity), last: time.Now()}
}

// Acquire waits until `cost` tokens are available. High-priority callers
// (closing positions) may dip into a 20% reserve that others leave alone.
func (b *TokenBucket) Acquire(ctx context.Context, cost float64, high bool) error {
	for {
		b.mu.Lock()
		now := time.Now()
		b.tokens = min(b.tokens+now.Sub(b.last).Seconds()*b.refill, b.capacity)
		b.last = now
		floor := b.capacity * 0.2
		if high {
			floor = 0
		}
		if b.tokens-cost >= floor {
			b.tokens -= cost
			b.mu.Unlock()
			return nil
		}
		wait := (cost + floor - b.tokens) / b.refill
		b.mu.Unlock()
		if wait < 0.01 {
			wait = 0.01
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(wait * float64(time.Second))):
		}
	}
}

// ---------- health registry (top-bar latency dots) ----------

type HealthEntry struct {
	Platform    model.Platform `json:"platform"`
	LatencyMs   *uint64        `json:"latency_ms"`
	LastOk      *int64         `json:"last_ok"`
	LastError   *string        `json:"last_error"`
	LastErrorAt *int64         `json:"last_error_at"`
}

type healthReg struct {
	mu      sync.Mutex
	samples map[model.Platform][]uint64
	entries map[model.Platform]*HealthEntry
}

var health = &healthReg{samples: map[model.Platform][]uint64{}, entries: map[model.Platform]*HealthEntry{}}

func (h *healthReg) entry(p model.Platform) *HealthEntry {
	e, ok := h.entries[p]
	if !ok {
		e = &HealthEntry{Platform: p}
		h.entries[p] = e
	}
	return e
}

func (h *healthReg) recordOk(p model.Platform, d time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	q := append(h.samples[p], uint64(d.Milliseconds()))
	if len(q) > 20 {
		q = q[len(q)-20:]
	}
	h.samples[p] = q
	v := append([]uint64(nil), q...)
	sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
	med := v[len(v)/2]
	e := h.entry(p)
	e.LatencyMs = &med
	now := util.NowMs()
	e.LastOk = &now
}

func (h *healthReg) recordErr(p model.Platform, err string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	e := h.entry(p)
	s := util.Truncate(err, 200)
	now := util.NowMs()
	e.LastError, e.LastErrorAt = &s, &now
}

// HealthSnapshot lists the live venues in a fixed order.
func HealthSnapshot() []HealthEntry {
	health.mu.Lock()
	defer health.mu.Unlock()
	out := make([]HealthEntry, 0, len(model.LivePlatforms))
	for _, p := range model.LivePlatforms {
		if e, ok := health.entries[p]; ok {
			out = append(out, *e)
		} else {
			out = append(out, HealthEntry{Platform: p})
		}
	}
	return out
}

// HealthLatency returns the median latency of a venue, if known.
func HealthLatency(p model.Platform) *uint64 {
	health.mu.Lock()
	defer health.mu.Unlock()
	if e, ok := health.entries[p]; ok {
		return e.LatencyMs
	}
	return nil
}

// SendJSON sends a request, times it, records health and maps HTTP 429/418
// to RateLimited and other HTTP errors to errs.Exchange (body as message).
func SendJSON(c *http.Client, p model.Platform, req *http.Request) (util.J, error) {
	t0 := time.Now()
	resp, err := c.Do(req)
	if err != nil {
		health.recordErr(p, err.Error())
		return util.J{}, &errs.Net{Err: err}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		health.recordErr(p, err.Error())
		return util.J{}, &errs.Net{Err: err}
	}
	text := string(body)
	if resp.StatusCode == 429 || resp.StatusCode == 418 {
		health.recordErr(p, "429 rate limited")
		return util.J{}, &errs.RateLimited{Msg: p.Label() + " HTTP " + strconv.Itoa(resp.StatusCode)}
	}
	v, perr := util.ParseJ(body)
	if perr != nil {
		v = util.JOf(text)
	}
	if resp.StatusCode >= 500 {
		health.recordErr(p, text)
		return util.J{}, &errs.Exchange{Code: strconv.Itoa(resp.StatusCode), Msg: util.Truncate(text, 300), Retryable: true}
	}
	health.recordOk(p, time.Since(t0))
	if resp.StatusCode >= 400 {
		return util.J{}, &errs.Exchange{Code: strconv.Itoa(resp.StatusCode), Msg: util.Truncate(text, 300), Retryable: false}
	}
	return v, nil
}

func newReq(ctx context.Context, method, u, body string) (*http.Request, error) {
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "merchandiser/0.1")
	return req, nil
}
