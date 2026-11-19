package api

import (
	"context"
	"sort"
	"strings"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/exchange"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

type SourceInput struct {
	Kind         string  `json:"kind"`
	Name         string  `json:"name"`
	ConnectionID *string `json:"connection_id"`
	Address      *string `json:"address"`
	Testnet      bool    `json:"testnet"`
	Platform     *string `json:"platform"`
	LeadMode     *string `json:"lead_mode"`
	LeadPoll     *string `json:"lead_poll"`
}

func probeLeadTrader(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Platform string `json:"platform"`
		ID       string `json:"id"`
	}](body)
	if err != nil {
		return nil, err
	}
	p, ok := model.ParsePlatform(a.Platform)
	if !ok {
		return nil, errs.Msg("未知平台")
	}
	lt, err := exchange.NewLeadTrader(p, a.ID, "")
	if err != nil {
		return nil, err
	}
	return lt.Probe(ctx)
}

func searchLeadTraders(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Platform string `json:"platform"`
		Query    string `json:"query"`
		Page     *int   `json:"page"`
	}](body)
	if err != nil {
		return nil, err
	}
	p, ok := model.ParsePlatform(a.Platform)
	if !ok {
		return nil, errs.Msg("未知平台")
	}
	page := 1
	if a.Page != nil {
		page = *a.Page
	}
	out, err := exchange.SearchLeadTraders(ctx, p, a.Query, page, "")
	if out == nil && err == nil {
		out = []exchange.LeadSummary{}
	}
	return out, err
}

func addSource(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Input SourceInput `json:"input"`
	}](body)
	if err != nil {
		return nil, err
	}
	in := a.Input
	db := s.E.DB
	if strings.TrimSpace(in.Name) == "" {
		return nil, errs.Msg("请填写名称")
	}
	var leadMode, leadPoll, conn, addr *string
	var platform string
	var testnet bool
	switch in.Kind {
	case "hl_address":
		ad := ""
		if in.Address != nil {
			ad = strings.ToLower(strings.TrimSpace(*in.Address))
		}
		if !exchange.ValidAddress(ad) {
			return nil, errs.Msg("地址应为 0x 开头的 42 位十六进制")
		}
		platform, addr, testnet = "hyperliquid", &ad, in.Testnet
	case "api":
		if in.ConnectionID == nil {
			return nil, errs.Msg("请选择连接")
		}
		c, err := store.Connection(ctx, db, *in.ConnectionID)
		if err != nil {
			return nil, err
		}
		if c == nil {
			return nil, errs.Msg("连接不存在")
		}
		if c.Platform == "hyperliquid" {
			if cr, err := s.E.Secrets.Get(c.ID); err == nil {
				addr = util.Ptr(strings.ToLower(cr.APIKey))
			}
		}
		platform, conn, testnet = c.Platform, &c.ID, c.Testnet
	case "lead_trader":
		var p model.Platform
		ok := false
		if in.Platform != nil {
			p, ok = model.ParsePlatform(*in.Platform)
		}
		if !ok {
			return nil, errs.Msg("请选择交易所")
		}
		raw := ""
		if in.Address != nil {
			raw = *in.Address
		}
		lt, err := exchange.NewLeadTrader(p, raw, "")
		if err != nil {
			return nil, err
		}
		probe, err := lt.Probe(ctx)
		if err != nil {
			return nil, err
		}
		if !probe.PositionsPublic {
			// Hidden positions: only with the user's explicit consent to
			// follow reconstructed positions.
			if in.LeadMode == nil || *in.LeadMode != "fills" {
				return nil, errs.Msg("该带单员未公开持仓，需确认改用成交记录推算后才能添加")
			}
			if !probe.FillsPublic {
				return nil, errs.Msg("该带单员未公开持仓，成交记录也不可见，无法跟随")
			}
			leadMode = util.Ptr("fills")
			leadPoll = util.Ptr("interval")
			if in.LeadPoll != nil {
				if !store.ValidLeadPoll(*in.LeadPoll) {
					return nil, errs.Msg("未知的成交记录读取方式")
				}
				leadPoll = in.LeadPoll
			}
		} else {
			// Must be readable now.
			m, err := s.E.Markets(ctx, lt)
			if err != nil {
				return nil, err
			}
			if _, err := lt.Snapshot(ctx, m, false); err != nil {
				return nil, err
			}
		}
		n, err := store.Count(ctx, db, "SELECT COUNT(*) FROM sources WHERE kind = 'lead_trader' AND platform = ? AND address = ?", string(p), probe.ID)
		if err != nil {
			return nil, err
		}
		if n > 0 {
			return nil, errs.Msg("该带单员已添加")
		}
		platform, addr = string(p), &probe.ID
	default:
		return nil, errs.Msg("未知信号源类型")
	}
	id := util.NewUUID()
	// created_at is the fill-reconstruction anchor until a history backfill
	// moves it back.
	if _, err := db.ExecContext(ctx, "INSERT INTO sources (id, kind, name, platform, connection_id, address, testnet, created_at, lead_mode, lead_poll) VALUES (?,?,?,?,?,?,?,?,?,?)",
		id, in.Kind, strings.TrimSpace(in.Name), platform, conn, addr, testnet, util.NowMs(), leadMode, leadPoll); err != nil {
		return nil, err
	}
	s.E.Changed("sources")
	// No task uses a new source yet, so rebuilding from history is safe.
	if leadMode != nil {
		if src, err := store.Source(ctx, db, id); err == nil && src != nil {
			_ = s.E.BackfillSource(ctx, src)
		}
	}
	return id, nil
}

func backfillSource(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[idArg](body)
	if err != nil {
		return nil, err
	}
	src, err := store.Source(ctx, s.E.DB, a.ID)
	if err != nil {
		return nil, err
	}
	if src == nil {
		return nil, errs.Msg("信号源不存在")
	}
	// Positions appearing at once would be mirrored by a running task.
	n, err := store.Count(ctx, s.E.DB, "SELECT COUNT(*) FROM tasks WHERE source_id = ? AND status != 'stopped'", a.ID)
	if err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, errs.Msg("有 %d 个任务正在使用该信号源，请先停止再重建", n)
	}
	return nil, s.E.BackfillSource(ctx, src)
}

// setSourceLeadPoll switches how a 'fills' lead source reads the trade
// history. Safe while tasks run: it changes only the polling cadence, not the
// reconstruction, and running tasks pick it up on their next snapshot.
func setSourceLeadPoll(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		ID       string `json:"id"`
		LeadPoll string `json:"lead_poll"`
	}](body)
	if err != nil {
		return nil, err
	}
	if !store.ValidLeadPoll(a.LeadPoll) {
		return nil, errs.Msg("未知的成交记录读取方式")
	}
	src, err := store.Source(ctx, s.E.DB, a.ID)
	if err != nil {
		return nil, err
	}
	if src == nil {
		return nil, errs.Msg("信号源不存在")
	}
	if src.Kind != "lead_trader" || !src.IsFills() {
		return nil, errs.Msg("只有按成交记录推算的带单员信号源可以切换读取方式")
	}
	if _, err := s.E.DB.ExecContext(ctx, "UPDATE sources SET lead_poll = ? WHERE id = ?", a.LeadPoll, a.ID); err != nil {
		return nil, err
	}
	exchange.SetFillsTrigger(a.ID, a.LeadPoll == "trigger")
	s.E.Changed("sources")
	return nil, nil
}

func deleteSource(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[idArg](body)
	if err != nil {
		return nil, err
	}
	db := s.E.DB
	n, err := store.Count(ctx, db, "SELECT COUNT(*) FROM tasks WHERE source_id = ?", a.ID)
	if err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, errs.Msg("该信号源被任务使用，请先删除相关任务")
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM lead_fill_state WHERE source_id = ?", a.ID); err != nil {
		return nil, err
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM sources WHERE id = ?", a.ID); err != nil {
		return nil, err
	}
	exchange.ForgetFills(a.ID)
	s.E.Changed("sources")
	return nil, nil
}

type SourceDto struct {
	store.SourceRow
	ConnectionAlias *string `json:"connection_alias"`
	TaskCount       int64   `json:"task_count"`
	URL             *string `json:"url"`
}

func listSources(ctx context.Context, s *Server, _ []byte) (any, error) {
	db := s.E.DB
	rows, err := store.Sources(ctx, db)
	if err != nil {
		return nil, err
	}
	out := []SourceDto{}
	for _, src := range rows {
		n, err := store.Count(ctx, db, "SELECT COUNT(*) FROM tasks WHERE source_id = ? AND status != 'stopped'", src.ID)
		if err != nil {
			return nil, err
		}
		d := SourceDto{SourceRow: src, TaskCount: n}
		if src.ConnectionID != nil {
			if c, err := store.Connection(ctx, db, *src.ConnectionID); err != nil {
				return nil, err
			} else if c != nil {
				d.ConnectionAlias = &c.Alias
			}
		}
		if src.Kind == "lead_trader" {
			if p, ok := model.ParsePlatform(src.Platform); ok {
				d.URL = exchange.LeadProfileURL(p, src.Addr())
			}
		}
		out = append(out, d)
	}
	return out, nil
}

type SourceOrderDto struct {
	model.OpenOrder
	MirroredTo int64 `json:"mirrored_to"`
}

type FillInfoDto struct {
	Anchor     int64  `json:"anchor"`
	LastFillAt *int64 `json:"last_fill_at"`
	// The trader's own lastTradeTime, which trigger mode watches.
	LastTradeAt *int64             `json:"last_trade_at"`
	Applied     uint64             `json:"applied"`
	Backfill    *exchange.Backfill `json:"backfill"`
}

type SourceDetailDto struct {
	Equity    string           `json:"equity"`
	Notional  string           `json:"notional"`
	Positions []model.Position `json:"positions"`
	Orders    []SourceOrderDto `json:"orders"`
	Ts        int64            `json:"ts"`
	Fills     *FillInfoDto     `json:"fills"`
	// Binance lead traders: newest public orders (opens and closes).
	LeadOrders      []exchange.LeadOrder `json:"lead_orders"`
	LeadOrdersError *string              `json:"lead_orders_error"`
}

func sourceDetail(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[idArg](body)
	if err != nil {
		return nil, err
	}
	db := s.E.DB
	src, err := store.Source(ctx, db, a.ID)
	if err != nil {
		return nil, err
	}
	if src == nil {
		return nil, errs.Msg("信号源不存在")
	}
	var fills *FillInfoDto
	if src.IsFills() {
		fills = &FillInfoDto{Anchor: src.CreatedAt, Backfill: exchange.BackfillStatus(a.ID)}
		st, err := exchange.LoadFillState(ctx, db, a.ID)
		if err != nil {
			return nil, err
		}
		if st != nil {
			fills.Anchor, fills.LastFillAt, fills.Applied = st.Anchor, st.LastFillAt, st.Applied
		}
		if fills.Backfill != nil && fills.Backfill.Running {
			return SourceDetailDto{Equity: "0", Notional: "0", Positions: []model.Position{}, Orders: []SourceOrderDto{}, Ts: util.NowMs(), Fills: fills}, nil
		}
	}
	ex, err := s.E.SourceAdapter(ctx, src)
	if err != nil {
		return nil, err
	}
	m, err := s.E.Markets(ctx, ex)
	if err != nil {
		return nil, err
	}
	snap, err := ex.Snapshot(ctx, m, true)
	if err != nil {
		return nil, err
	}
	_, _ = db.ExecContext(ctx, "INSERT INTO source_equity (source_id, ts, equity) VALUES (?,?,?)", a.ID, util.NowMs(), snap.Equity.String())
	orders := []SourceOrderDto{}
	for _, o := range snap.Orders {
		n, err := store.Count(ctx, db, "SELECT COUNT(*) FROM mirrors m JOIN tasks t ON t.id = m.task_id WHERE t.source_id = ? AND m.source_order_id = ? AND m.status IN ('live','filled')", a.ID, o.ID)
		if err != nil {
			return nil, err
		}
		orders = append(orders, SourceOrderDto{OpenOrder: o, MirroredTo: n})
	}
	positions := append([]model.Position{}, snap.Positions...)
	sort.SliceStable(positions, func(i, j int) bool {
		return positions[i].Size.Mul(positions[i].MarkPx).Abs().GreaterThan(positions[j].Size.Mul(positions[j].MarkPx).Abs())
	})
	if fills != nil {
		// The snapshot may have advanced the state.
		if st, err := exchange.LoadFillState(ctx, db, a.ID); err == nil && st != nil {
			fills.Anchor, fills.LastFillAt, fills.Applied = st.Anchor, st.LastFillAt, st.Applied
		}
	}
	out := SourceDetailDto{
		Equity: util.Fmt(snap.Equity.RoundBank(2)), Notional: util.Fmt(snap.Notional().RoundBank(2)),
		Positions: positions, Orders: orders, Ts: snap.Ts, Fills: fills,
	}
	if lt, ok := ex.(*exchange.LeadTrader); ok && lt.Platform() == model.Binance {
		if fills != nil {
			fills.LastTradeAt = lt.LastTrade(ctx)
		}
		// Shown only; failing to read them must not hide the positions.
		if lo, err := lt.RecentOrders(ctx, a.ID); err != nil {
			out.LeadOrdersError = util.Ptr(err.Error())
		} else {
			out.LeadOrders = lo
		}
	}
	return out, nil
}
