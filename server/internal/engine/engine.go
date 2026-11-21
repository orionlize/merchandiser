// Package engine owns adapters, contract maps and one runner per active task.
package engine

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/exchange"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/notify"
	"merchandiser/server/internal/secrets"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

// Event is pushed to connected clients: either "something changed, refetch"
// or an alert worth a system notification.
type Event struct {
	Kind   string  `json:"kind"` // changed | alert
	Scope  string  `json:"scope,omitempty"`
	Level  string  `json:"level,omitempty"`
	Title  string  `json:"title,omitempty"`
	Detail *string `json:"detail,omitempty"`
}

// Bus fans events out to subscribers (SSE clients). Slow subscribers drop events.
type Bus struct {
	mu   sync.Mutex
	subs map[chan Event]struct{}
}

func NewBus() *Bus { return &Bus{subs: map[chan Event]struct{}{}} }

func (b *Bus) Subscribe() (chan Event, func()) {
	ch := make(chan Event, 256)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		if _, ok := b.subs[ch]; ok {
			delete(b.subs, ch)
			close(ch)
		}
		b.mu.Unlock()
	}
}

func (b *Bus) Publish(e Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- e:
		default:
		}
	}
}

type mktKey struct {
	p       model.Platform
	testnet bool
}

type mktEntry struct {
	at int64
	m  *exchange.Markets
}

type runner struct {
	cmds chan taskCmd
	done chan struct{}
}

func (r *runner) finished() bool {
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

type Engine struct {
	DB      *sql.DB
	Secrets *secrets.Store
	Bus     *Bus
	// Root context of the process; runners stop when it is cancelled.
	ctx context.Context

	adMu     sync.RWMutex
	adapters map[string]exchange.Exchange

	mktMu   sync.Mutex
	markets map[mktKey]mktEntry

	// Serialises task lifecycle changes (start / stop / pause).
	runMu   sync.Mutex
	runners map[string]*runner

	liveMu sync.RWMutex
	live   map[string]*TaskLive

	// Freshest snapshot per account (positions for the overview).
	snapMu sync.RWMutex
	snaps  map[string]*model.AccountSnapshot

	// Per-task virtual positions on shared follower accounts (ledger.go).
	ledgerMu sync.Mutex
	ledger   map[ledgerKey]*ledgerPos
	short    map[string]shortfall

	estopped atomic.Bool
	// UI lock (tasks keep running while locked).
	locked atomic.Bool

	// Pushes to Telegram / webhooks (nil = off, e.g. in tests).
	Notify *notify.Service
	// Set while RestoreOnBoot runs: one summary instead of a message per task.
	restoring atomic.Bool
}

func New(ctx context.Context, db *sql.DB, sec *secrets.Store, bus *Bus) *Engine {
	e := &Engine{DB: db, Secrets: sec, Bus: bus, ctx: ctx, adapters: map[string]exchange.Exchange{}, markets: map[mktKey]mktEntry{}, runners: map[string]*runner{}, live: map[string]*TaskLive{}, snaps: map[string]*model.AccountSnapshot{}, ledger: map[ledgerKey]*ledgerPos{}, short: map[string]shortfall{}}
	e.locked.Store(store.SettingsCache().AppLock)
	e.loadLedger(ctx)
	return e
}

func (e *Engine) Estopped() bool       { return e.estopped.Load() }
func (e *Engine) Locked() bool         { return e.locked.Load() }
func (e *Engine) SetLocked(v bool)     { e.locked.Store(v) }
func (e *Engine) Changed(scope string) { e.Bus.Publish(Event{Kind: "changed", Scope: scope}) }

func (e *Engine) Live(taskID string) *TaskLive {
	e.liveMu.RLock()
	defer e.liveMu.RUnlock()
	if l, ok := e.live[taskID]; ok {
		cp := *l
		return &cp
	}
	return nil
}

func (e *Engine) updateLive(taskID string, f func(*TaskLive)) {
	e.liveMu.Lock()
	defer e.liveMu.Unlock()
	if l, ok := e.live[taskID]; ok {
		f(l)
	}
}

// Alert records an alert and pushes it: errors as "error", the rest as
// "risk". Use AlertAs for another category.
func (e *Engine) Alert(level string, taskID, connID *string, title string, detail *string) {
	cat := notify.CatRisk
	if level == "error" {
		cat = notify.CatError
	}
	e.AlertAs(cat, level, taskID, connID, title, detail)
}

func (e *Engine) AlertAs(cat, level string, taskID, connID *string, title string, detail *string) {
	e.Notify.Notify(cat, level, title, detail)
	if _, err := store.InsertAlert(context.Background(), e.DB, level, taskID, connID, title, detail); err != nil {
		slog.Error("alert insert failed", "err", err)
	}
	d := ""
	if detail != nil {
		d = *detail
	}
	slog.Info("alert", "level", level, "title", title, "detail", d)
	if level == "error" || level == "warn" {
		e.Bus.Publish(Event{Kind: "alert", Level: level, Title: title, Detail: detail})
	}
	e.Changed("alerts")
}

// ---------- adapters ----------

// BuildAdapter makes an adapter for a connection row; creds nil = stored ones.
func (e *Engine) BuildAdapter(ctx context.Context, row *store.ConnectionRow, creds *model.Credentials) (exchange.Exchange, error) {
	p, ok := model.ParsePlatform(row.Platform)
	if !ok {
		return nil, errs.Msg("未知平台")
	}
	proxy := ""
	if row.Proxy != nil {
		proxy = *row.Proxy
	}
	var c model.Credentials
	if p != model.Paper {
		if creds != nil {
			c = *creds
		} else {
			var err error
			if c, err = e.Secrets.Get(row.ID); err != nil {
				return nil, err
			}
		}
	}
	switch p {
	case model.Hyperliquid:
		return exchange.NewHyperliquidTrading(c, row.Testnet, proxy)
	default:
		initial := util.D(10_000)
		if row.PaperInitial != nil {
			initial = util.Dec(*row.PaperInitial)
		}
		return exchange.LoadPaper(ctx, row.ID, e.DB, initial)
	}
}

func (e *Engine) Adapter(ctx context.Context, connID string) (exchange.Exchange, error) {
	e.adMu.RLock()
	a, ok := e.adapters[connID]
	e.adMu.RUnlock()
	if ok {
		return a, nil
	}
	row, err := store.Connection(ctx, e.DB, connID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, errs.Msg("连接不存在")
	}
	a, err = e.BuildAdapter(ctx, row, nil)
	if err != nil {
		return nil, err
	}
	e.adMu.Lock()
	// Keep the first one built (paper accounts hold state).
	if existing, ok := e.adapters[connID]; ok {
		a = existing
	} else {
		e.adapters[connID] = a
	}
	e.adMu.Unlock()
	return a, nil
}

func (e *Engine) ForgetAdapter(connID string) {
	e.forgetSnapshot(connID)
	e.adMu.Lock()
	delete(e.adapters, connID)
	e.adMu.Unlock()
}

func (e *Engine) SourceAdapter(ctx context.Context, s *store.SourceRow) (exchange.Exchange, error) {
	switch s.Kind {
	case "api":
		if s.ConnectionID == nil {
			return nil, errs.Msg("信号源缺少连接")
		}
		return e.Adapter(ctx, *s.ConnectionID)
	case "hl_address":
		return exchange.NewHyperliquidPublic(s.Addr(), s.Testnet, "")
	}
	return nil, errs.Msg("未知信号源类型")
}

// ---------- markets ----------

func (e *Engine) Markets(ctx context.Context, ex exchange.Exchange) (*exchange.Markets, error) {
	if !ex.NeedsContracts() {
		return exchange.EmptyMarkets(), nil
	}
	key := mktKey{ex.Platform(), ex.Testnet()}
	e.mktMu.Lock()
	if ent, ok := e.markets[key]; ok && util.NowMs()-ent.at < 3_600_000 {
		e.mktMu.Unlock()
		return ent.m, nil
	}
	e.mktMu.Unlock()
	specs, err := ex.Contracts(ctx)
	if err != nil {
		return nil, err
	}
	m := exchange.MarketsFromSpecs(specs)
	if err := e.applyOverrides(ctx, key.p, m); err != nil {
		return nil, err
	}
	e.mktMu.Lock()
	e.markets[key] = mktEntry{util.NowMs(), m}
	e.mktMu.Unlock()
	return m, nil
}

func (e *Engine) applyOverrides(ctx context.Context, p model.Platform, m *exchange.Markets) error {
	rows, err := e.DB.QueryContext(ctx, "SELECT base, symbol, disabled FROM symbol_map WHERE platform = ?", string(p))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var base string
		var symbol *string
		var disabled bool
		if err := rows.Scan(&base, &symbol, &disabled); err != nil {
			return err
		}
		if disabled {
			delete(m.ByBase, base)
			continue
		}
		if symbol != nil {
			if spec, ok := m.BySymbol[*symbol]; ok {
				s := *spec
				s.Base = base
				m.BySymbol[*symbol] = &s
				s2 := s
				m.ByBase[base] = &s2
			}
		}
	}
	return rows.Err()
}

func (e *Engine) InvalidateMarkets() {
	e.mktMu.Lock()
	e.markets = map[mktKey]mktEntry{}
	e.mktMu.Unlock()
}

// AllMarkets returns contract maps for every live platform (public endpoints only).
func (e *Engine) AllMarkets(ctx context.Context) map[model.Platform]*exchange.Markets {
	var exs []exchange.Exchange
	if x, err := exchange.NewHyperliquidPublic("0x0000000000000000000000000000000000000000", false, ""); err == nil {
		exs = append(exs, x)
	}
	out := map[model.Platform]*exchange.Markets{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, x := range exs {
		wg.Add(1)
		go func(x exchange.Exchange) {
			defer wg.Done()
			m, err := e.Markets(ctx, x)
			if err != nil {
				slog.Warn("markets", "platform", x.Platform(), "err", err)
				return
			}
			mu.Lock()
			out[x.Platform()] = m
			mu.Unlock()
		}(x)
	}
	wg.Wait()
	return out
}

// ---------- task lifecycle ----------

func (e *Engine) StartTask(ctx context.Context, taskID string, freshStart bool) error {
	if e.estopped.Load() {
		return errs.Msg("全局急停中，请先解除急停")
	}
	e.runMu.Lock()
	defer e.runMu.Unlock()
	if r, ok := e.runners[taskID]; ok && !r.finished() {
		r.send(taskCmd{kind: cmdResume})
		if err := store.SetTaskStatus(ctx, e.DB, taskID, "running", nil); err != nil {
			return err
		}
		e.notifyLifecycle(ctx, taskID, "已恢复跟单", nil)
		e.Changed("tasks")
		return nil
	}
	tr, err := prepareRunner(ctx, e, taskID, freshStart)
	if err != nil {
		return err
	}
	if err := store.SetTaskStatus(ctx, e.DB, taskID, "running", nil); err != nil {
		return err
	}
	r := &runner{cmds: make(chan taskCmd, 64), done: make(chan struct{})}
	e.runners[taskID] = r
	go func() {
		defer close(r.done)
		tr.run(e.ctx, r.cmds)
	}()
	e.notifyLifecycle(ctx, taskID, "已启动", nil)
	e.Changed("tasks")
	return nil
}

// notifyLifecycle pushes a task start / pause / stop (no alert row).
func (e *Engine) notifyLifecycle(ctx context.Context, taskID, what string, detail *string) {
	if e.Notify == nil || e.restoring.Load() {
		return
	}
	name := taskID
	if t, err := store.Task(ctx, e.DB, taskID); err == nil && t != nil {
		name = t.Name
	}
	e.Notify.Notify(notify.CatLifecycle, "ok", name+" "+what, detail)
}

func (r *runner) send(c taskCmd) {
	select {
	case r.cmds <- c:
	case <-r.done:
	}
}

func (e *Engine) PauseTask(ctx context.Context, taskID string, reason *string) error {
	if err := store.SetTaskStatus(ctx, e.DB, taskID, "paused", reason); err != nil {
		return err
	}
	e.runMu.Lock()
	if r, ok := e.runners[taskID]; ok {
		r.send(taskCmd{kind: cmdPause})
	}
	e.runMu.Unlock()
	// The e-stop sends its own alert; one message per task would be noise.
	if reason == nil || *reason != "全局急停" {
		e.notifyLifecycle(ctx, taskID, "已暂停", reason)
	}
	e.Changed("tasks")
	return nil
}

func (e *Engine) StopTask(ctx context.Context, taskID string, closePositions *bool) error {
	e.runMu.Lock()
	r, ok := e.runners[taskID]
	if ok {
		delete(e.runners, taskID)
	}
	e.runMu.Unlock()
	if ok {
		done := make(chan struct{})
		r.send(taskCmd{kind: cmdStop, close: closePositions, done: done})
		select {
		case <-done:
		case <-r.done:
		case <-time.After(60 * time.Second):
		}
	} else if closePositions != nil && *closePositions {
		// Not running: spin up a runner just to flatten, then drop it.
		tr, err := prepareRunner(ctx, e, taskID, false)
		if err != nil {
			return err
		}
		tr.closeAllPositions(ctx, "停止任务时平仓")
	}
	if err := store.SetTaskStatus(ctx, e.DB, taskID, "stopped", nil); err != nil {
		return err
	}
	// Whatever is left on the accounts no longer belongs to this task.
	if pnl, ok := e.TaskPnl(taskID); ok {
		e.releaseLedger(taskID)
		_ = store.InsertTaskPnl(ctx, e.DB, taskID, pnl)
	}
	e.liveMu.Lock()
	delete(e.live, taskID)
	e.liveMu.Unlock()
	what := "已停止"
	if closePositions != nil && *closePositions {
		what = "已停止并平仓"
	}
	e.notifyLifecycle(ctx, taskID, what, nil)
	e.Changed("tasks")
	return nil
}

func (e *Engine) ReconcileNow(taskID string) error {
	e.runMu.Lock()
	defer e.runMu.Unlock()
	r, ok := e.runners[taskID]
	if !ok {
		return errs.Msg("任务未在运行")
	}
	r.send(taskCmd{kind: cmdReconcile})
	return nil
}

func (e *Engine) ReloadTask(taskID string) {
	e.runMu.Lock()
	defer e.runMu.Unlock()
	if r, ok := e.runners[taskID]; ok {
		r.send(taskCmd{kind: cmdReload})
	}
}

// RestartTask reloads a task and drops its runtime state, so it starts over
// from the source's current positions (a watch-only task turned into copy
// trading). A task that is not running starts fresh on its next start.
func (e *Engine) RestartTask(ctx context.Context, taskID string) error {
	if _, err := e.DB.ExecContext(ctx, "UPDATE tasks SET baseline_json = NULL WHERE id = ?", taskID); err != nil {
		return err
	}
	e.runMu.Lock()
	defer e.runMu.Unlock()
	if r, ok := e.runners[taskID]; ok {
		r.send(taskCmd{kind: cmdReload, fresh: true})
	}
	return nil
}

func (e *Engine) broadcast(c taskCmd) {
	e.runMu.Lock()
	defer e.runMu.Unlock()
	for _, r := range e.runners {
		r.send(c)
	}
}

// EmergencyStop pauses every running task and cancels all mirrored orders. Positions stay.
func (e *Engine) EmergencyStop(ctx context.Context) error {
	e.estopped.Store(true)
	tasks, err := store.Tasks(ctx, e.DB)
	if err != nil {
		return err
	}
	for _, t := range tasks {
		if t.Status == "running" {
			if err := e.PauseTask(ctx, t.ID, util.Ptr("全局急停")); err != nil {
				return err
			}
		}
	}
	e.broadcast(taskCmd{kind: cmdCancelMirrors})
	e.Alert("error", nil, nil, "已触发全局急停", util.Ptr("所有任务已暂停，镜像挂单已撤销，仓位保持不变"))
	e.Changed("estop")
	return nil
}

// ReleaseEstop lifts the e-stop and resumes the tasks it paused (each reconciles first).
func (e *Engine) ReleaseEstop(ctx context.Context) error {
	e.estopped.Store(false)
	tasks, err := store.Tasks(ctx, e.DB)
	if err != nil {
		return err
	}
	// One task failing to start (locked secrets, broken connection, deleted
	// source…) must not block the release or the other tasks: it stays paused
	// with its reason and an alert, and can be resumed by hand later.
	failed := 0
	for _, t := range tasks {
		if t.Status == "paused" && t.PauseReason != nil && *t.PauseReason == "全局急停" {
			if err := e.StartTask(ctx, t.ID, false); err != nil {
				failed++
				e.AlertAs(notify.CatError, "warn", util.Ptr(t.ID), nil, "解除急停后任务未能恢复", util.Ptr(err.Error()))
				continue
			}
			_ = e.ReconcileNow(t.ID)
		}
	}
	if failed > 0 {
		e.AlertAs(notify.CatLifecycle, "warn", nil, nil, "已解除全局急停", util.Ptr(fmt.Sprintf("%d 个任务未能自动恢复，请到任务页手动启动", failed)))
	} else {
		e.AlertAs(notify.CatLifecycle, "ok", nil, nil, "已解除全局急停", util.Ptr("被急停暂停的任务已对账后恢复"))
	}
	e.Changed("estop")
	e.Changed("tasks")
	return nil
}

// CloseEverything market-closes every position on every follower account of
// every non-stopped task.
func (e *Engine) CloseEverything(ctx context.Context) error {
	if err := e.EmergencyStop(ctx); err != nil {
		return err
	}
	tasks, err := store.Tasks(ctx, e.DB)
	if err != nil {
		return err
	}
	done := map[string]bool{}
	for _, t := range tasks {
		if t.Status == "stopped" {
			continue
		}
		tr, err := prepareRunner(ctx, e, t.ID, false)
		if err != nil {
			return err
		}
		for _, f := range tr.followers {
			if !done[f.connID] {
				done[f.connID] = true
				tr.closeFollower(ctx, f, "全部平仓", true)
			}
		}
	}
	e.Alert("warn", nil, nil, "已执行全部平仓", nil)
	return nil
}

func (e *Engine) RestoreOnBoot(ctx context.Context) {
	tasks, err := store.Tasks(ctx, e.DB)
	if err != nil {
		slog.Error("restore", "err", err)
		return
	}
	e.restoring.Store(true)
	restored := 0
	defer func() {
		e.restoring.Store(false)
		e.Notify.Notify(notify.CatLifecycle, "ok", "服务已启动", util.Ptr(fmt.Sprintf("已恢复 %d 个运行中的任务", restored)))
	}()
	for _, t := range tasks {
		if t.Status != "running" {
			continue
		}
		if err := e.StartTask(ctx, t.ID, false); err != nil {
			_ = store.SetTaskStatus(ctx, e.DB, t.ID, "paused", util.Ptr("启动恢复失败: "+err.Error()))
			e.Alert("error", &t.ID, nil, t.Name+" 恢复失败", util.Ptr(err.Error()))
		} else {
			restored++
			slog.Info("restored task", "name", t.Name)
		}
	}
}

func (e *Engine) RunningCount() int {
	e.runMu.Lock()
	defer e.runMu.Unlock()
	n := 0
	for _, r := range e.runners {
		if !r.finished() {
			n++
		}
	}
	return n
}

// SpawnBackground starts equity sampling, cost sync, retention and sleep-gap
// detection.
func (e *Engine) SpawnBackground() {
	go e.costLoop()
	go func() {
		t := time.NewTicker(60 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-e.ctx.Done():
				return
			case <-t.C:
				e.SampleEquity(e.ctx)
			}
		}
	}()
	go func() {
		t := time.NewTicker(6 * time.Hour)
		defer t.Stop()
		for {
			st := store.SettingsCache()
			if err := store.Prune(e.ctx, e.DB, int64(st.LogRetentionDays), int64(st.TripRetentionDays), int64(st.AuditRetentionDays)); err != nil {
				slog.Warn("prune", "err", err)
			}
			select {
			case <-e.ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	go func() {
		last := util.NowMs()
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-e.ctx.Done():
				return
			case <-t.C:
			}
			now := util.NowMs()
			gap := now - last
			last = now
			if gap > 30_000 && e.RunningCount() > 0 {
				e.AlertAs(notify.CatError, "warn", nil, nil, "检测到服务器挂起 "+decimal.NewFromInt(gap/1000).String()+" 秒", util.Ptr("期间未跟单，已对所有运行中的任务重新对账"))
				e.broadcast(taskCmd{kind: cmdReconcile})
			}
		}
	}()
}

func (e *Engine) SampleEquity(ctx context.Context) {
	conns, err := store.Connections(ctx, e.DB)
	if err != nil {
		return
	}
	for _, c := range conns {
		ex, err := e.Adapter(ctx, c.ID)
		if err != nil {
			continue
		}
		m, err := e.Markets(ctx, ex)
		if err != nil {
			continue
		}
		s, err := ex.Snapshot(ctx, m, false)
		if err != nil {
			slog.Debug("equity", "alias", c.Alias, "err", err)
			continue
		}
		e.RememberSnapshot(c.ID, s)
		_ = store.InsertEquity(ctx, e.DB, c.ID, s.Equity, s.Available, s.Upnl(), s.Notional())
	}
	e.RecordTaskPnl(ctx)
	e.Changed("equity")
}
