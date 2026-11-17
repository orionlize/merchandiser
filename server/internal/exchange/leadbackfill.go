package exchange

// Rebuilding a `fills` source from the trader's whole public trade history.
//
// By default a `fills` source only counts fills after it was added, so a
// newly added trader shows no positions. Binance keeps roughly the last two
// months of fills public (pages of at most 200, newest first, at one request
// per 3 s), so the reconstruction can instead start from the oldest fill
// still listed. Positions opened before that are still invisible.
//
// Paging is by page number, so a fill arriving mid-backfill shifts every
// later page by one. The venue's `total` is checked on every page and the
// pass restarts when it changes.

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/util"
)

const (
	backfillPageSize = 200
	// 100k fills; beyond that the trader is far too active to follow anyway.
	backfillMaxPages = 500
	backfillAttempts = 3
)

// Backfill is the progress of one history rebuild.
type Backfill struct {
	Running bool `json:"running"`
	// Fills fetched so far in the current pass / fills the venue lists.
	Fetched int   `json:"fetched"`
	Total   int64 `json:"total"`
	// Set when finished.
	Error      *string `json:"error"`
	FinishedAt *int64  `json:"finished_at"`
	// Oldest fill counted (the new anchor) once finished.
	From *int64 `json:"from"`
}

func bookOf(sourceID string) *fillBook {
	lc.booksMu.Lock()
	defer lc.booksMu.Unlock()
	b, ok := lc.books[sourceID]
	if !ok {
		b = &fillBook{}
		lc.books[sourceID] = b
	}
	return b
}

// backfillOf returns a copy of the source's backfill job, or nil.
func backfillOf(sourceID string) *Backfill {
	lc.booksMu.Lock()
	defer lc.booksMu.Unlock()
	if b, ok := lc.backfills[sourceID]; ok {
		c := *b
		return &c
	}
	return nil
}

func BackfillStatus(sourceID string) *Backfill { return backfillOf(sourceID) }

func BackfillRunning(sourceID string) bool {
	b := backfillOf(sourceID)
	return b != nil && b.Running
}

func updateBackfill(sourceID string, f func(b *Backfill)) {
	lc.booksMu.Lock()
	defer lc.booksMu.Unlock()
	if b, ok := lc.backfills[sourceID]; ok {
		f(b)
	}
}

// StartBackfill rebuilds the source's reconstructed positions from the full
// public history in the background. `done` runs when it ends either way.
func (l *LeadTrader) StartBackfill(ctx context.Context, done func()) error {
	if l.fills == nil || l.venue != model.Binance {
		return errs.Msg("只有按成交记录推算的币安带单员可以重建历史")
	}
	id := l.fills.sourceID
	lc.booksMu.Lock()
	if b, ok := lc.backfills[id]; ok && b.Running {
		lc.booksMu.Unlock()
		return errs.Msg("正在重建，请稍候")
	}
	lc.backfills[id] = &Backfill{Running: true}
	lc.booksMu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		defer cancel()
		from, err := l.backfill(ctx)
		updateBackfill(id, func(b *Backfill) {
			b.Running = false
			b.FinishedAt = util.Ptr(util.NowMs())
			if err != nil {
				b.Error = util.Ptr(err.Error())
			} else {
				b.From = &from
			}
		})
		if done != nil {
			done()
		}
	}()
	return nil
}

func (l *LeadTrader) backfillPage(ctx context.Context, page int) ([]Fill, int64, error) {
	var err error
	for range 4 {
		var f []Fill
		var total int64
		f, total, err = l.bnFillsPageSized(ctx, page, backfillPageSize)
		if !errs.IsRateLimited(err) {
			return f, total, err
		}
	}
	return nil, 0, err
}

// fetchHistory returns the whole public trade history, newest first.
func (l *LeadTrader) fetchHistory(ctx context.Context) ([]Fill, error) {
	id := l.fills.sourceID
	for range backfillAttempts {
		var all []Fill
		var total int64
		shifted := false
		for page := 1; ; page++ {
			if page > backfillMaxPages {
				return nil, errs.Msg("该带单员历史成交过多，无法重建")
			}
			p, t, err := l.backfillPage(ctx, page)
			if err != nil {
				return nil, err
			}
			if page == 1 {
				total = t
			} else if t != total {
				shifted = true
				break
			}
			all = append(all, p...)
			n := len(all)
			updateBackfill(id, func(b *Backfill) { b.Fetched, b.Total = n, total })
			if len(p) < backfillPageSize {
				break
			}
		}
		if !shifted {
			return all, nil
		}
	}
	return nil, errs.Msg("带单员正在频繁成交，历史记录一直在变，请稍后再试")
}

func (l *LeadTrader) backfill(ctx context.Context) (int64, error) {
	fills, err := l.fetchHistory(ctx)
	if err != nil {
		return 0, err
	}
	if len(fills) == 0 {
		return 0, errs.Msg("币安带单员成交记录不可见")
	}
	from := fills[len(fills)-1].Time
	st := NewFillState(from)
	st.Ingest(fills)
	j, err := json.Marshal(st)
	if err != nil {
		return 0, err
	}
	b := bookOf(l.fills.sourceID)
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, err := l.fills.db.ExecContext(ctx, "INSERT INTO lead_fill_state (source_id, json) VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET json = excluded.json", l.fills.sourceID, string(j)); err != nil {
		return 0, err
	}
	// Later polls page back from the newest fill seen here.
	b.state = st
	b.cached = nil
	return from, nil
}

// LoadFillState reads a source's persisted fill state (nil when none).
func LoadFillState(ctx context.Context, db *sql.DB, sourceID string) (*FillState, error) {
	var j string
	err := db.QueryRowContext(ctx, "SELECT json FROM lead_fill_state WHERE source_id = ?", sourceID).Scan(&j)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	st := &FillState{}
	if err := json.Unmarshal([]byte(j), st); err != nil {
		return nil, err
	}
	return st, nil
}
