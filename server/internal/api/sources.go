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
	var conn, addr *string
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
	default:
		return nil, errs.Msg("未知信号源类型")
	}
	id := util.NewUUID()
	if _, err := db.ExecContext(ctx, "INSERT INTO sources (id, kind, name, platform, connection_id, address, testnet, created_at) VALUES (?,?,?,?,?,?,?,?)",
		id, in.Kind, strings.TrimSpace(in.Name), platform, conn, addr, testnet, util.NowMs()); err != nil {
		return nil, err
	}
	s.E.Changed("sources")
	return id, nil
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
	if _, err := db.ExecContext(ctx, "DELETE FROM sources WHERE id = ?", a.ID); err != nil {
		return nil, err
	}
	s.E.Changed("sources")
	return nil, nil
}

type SourceDto struct {
	store.SourceRow
	ConnectionAlias *string `json:"connection_alias"`
	TaskCount       int64   `json:"task_count"`
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
		out = append(out, d)
	}
	return out, nil
}

type SourceOrderDto struct {
	model.OpenOrder
	MirroredTo int64 `json:"mirrored_to"`
}

type SourceDetailDto struct {
	Equity    string           `json:"equity"`
	Notional  string           `json:"notional"`
	Positions []model.Position `json:"positions"`
	Orders    []SourceOrderDto `json:"orders"`
	Ts        int64            `json:"ts"`
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
	if snap.Equity.IsPositive() {
		_, _ = db.ExecContext(ctx, "INSERT INTO source_equity (source_id, ts, equity) VALUES (?,?,?)", a.ID, util.NowMs(), snap.Equity.String())
	}
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
	out := SourceDetailDto{
		Equity: util.Fmt(snap.Equity.RoundBank(2)), Notional: util.Fmt(snap.Notional().RoundBank(2)),
		Positions: positions, Orders: orders, Ts: snap.Ts,
	}
	return out, nil
}
