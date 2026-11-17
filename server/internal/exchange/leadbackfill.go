package exchange

// Rebuilding a `fills` source from the trader's whole public trade history.
//
// By default a `fills` source only counts fills after it was added, so a
// newly added trader shows no positions. Binance keeps roughly the last two
// months of fills public (pages of at most 200, newest first, at one request
// per 3 s), so the reconstruction can instead start from the oldest fill
// still listed. Positions opened before that are still invisible.
//
// Measured venue quirks:
//   - Very active traders are capped at their newest ~6000 fills: `total`
//     says 6000 on every page, and the first page past the end comes back
//     empty with the real count (e.g. 69974). So `total` is only a progress
//     hint; the history ends at the first empty or short page.
//   - Paging is by page number, so k fills arriving mid-pass shift later
//     pages by k and repeat k fills at a page boundary. Identical fills are
//     common (one key 19× in a page), so duplicates cannot be told apart by
//     content. Instead page 1 is fetched again after the pass: how far its
//     old head moved is the exact number of fills that arrived. Zero means
//     the pass is clean; otherwise it is retried, and on the last attempt
//     boundary repeats are dropped within that budget.

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
	backfillAttempts = 4
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
	for attempt := 1; ; attempt++ {
		var pages [][]Fill
		var total int64
		n := 0
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
			}
			if len(p) == 0 {
				break
			}
			pages = append(pages, p)
			n += len(p)
			updateBackfill(id, func(b *Backfill) { b.Fetched, b.Total = n, max(total, int64(n)) })
			if len(p) < backfillPageSize {
				break
			}
		}
		if len(pages) <= 1 {
			// One request sees one consistent list.
			return flatten(pages), nil
		}
		head, _, err := l.backfillPage(ctx, 1)
		if err != nil {
			return nil, err
		}
		arrived := headShift(pages[0], head)
		if arrived == 0 {
			return flatten(pages), nil
		}
		if arrived >= len(head) {
			// Too many to measure from one page.
			if attempt >= backfillAttempts {
				return nil, errs.Msg("带单员成交过于频繁，历史记录无法稳定读取，请稍后再试")
			}
			continue
		}
		if attempt >= backfillAttempts {
			return dropBoundaryRepeats(pages, arrived), nil
		}
	}
}

func flatten(pages [][]Fill) []Fill {
	var out []Fill
	for _, p := range pages {
		out = append(out, p...)
	}
	return out
}

// headShift returns how many fills were added in front of `old` (an earlier
// copy of page 1) to give `now`; len(now) when it cannot be found.
func headShift(old, now []Fill) int {
	for k := 0; k < len(now); k++ {
		m := min(len(now)-k, len(old))
		same := true
		for i := 0; i < m; i++ {
			if now[k+i].Key != old[i].Key {
				same = false
				break
			}
		}
		if same {
			return k
		}
	}
	return len(now)
}

// dropBoundaryRepeats removes, at each page boundary, a leading run of the
// next page that repeats the tail of the previous one, spending at most
// `budget` removals in total (fills that arrived during the pass).
func dropBoundaryRepeats(pages [][]Fill, budget int) []Fill {
	out := append([]Fill{}, pages[0]...)
	for _, p := range pages[1:] {
		d := 0
		for k := min(budget, len(p), len(out)); k > 0; k-- {
			same := true
			for i := 0; i < k; i++ {
				if p[i].Key != out[len(out)-k+i].Key {
					same = false
					break
				}
			}
			if same {
				d = k
				break
			}
		}
		budget -= d
		out = append(out, p[d:]...)
	}
	return out
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
