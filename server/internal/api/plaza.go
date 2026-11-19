package api

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"sync"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/exchange"
	"merchandiser/server/internal/plaza"
	"merchandiser/server/internal/store"
)

// 跟单员广场: ranked public Hyperliquid wallets.

const favKey = "plaza_favorites"

var (
	plazaOnce sync.Once
	plazaSvc  *plaza.Service
	plazaErr  error
)

func (s *Server) plaza() (*plaza.Service, error) {
	plazaOnce.Do(func() {
		ctx := s.Ctx
		if ctx == nil {
			ctx = context.Background()
		}
		plazaSvc, plazaErr = plaza.New(ctx, func(ctx context.Context) []string { return pinnedAddrs(ctx, s) })
	})
	return plazaSvc, plazaErr
}

func favorites(ctx context.Context, s *Server) map[string]bool {
	out := map[string]bool{}
	v, err := store.GetSetting(ctx, s.E.DB, favKey)
	if err != nil || v == nil {
		return out
	}
	var list []string
	_ = json.Unmarshal([]byte(*v), &list)
	for _, a := range list {
		out[a] = true
	}
	return out
}

type link struct {
	SourceID string
	TaskID   string
}

// links maps mainnet HL addresses to an existing address source and, if one
// is running, the task following it.
func links(ctx context.Context, s *Server) map[string]link {
	out := map[string]link{}
	srcs, err := store.Sources(ctx, s.E.DB)
	if err != nil {
		return out
	}
	tasks, err := store.Tasks(ctx, s.E.DB)
	if err != nil {
		return out
	}
	active := map[string]string{}
	for _, t := range tasks {
		if t.Status != "stopped" {
			active[t.SourceID] = t.ID
		}
	}
	for _, src := range srcs {
		if src.Kind != "hl_address" || src.Testnet || src.Address == nil {
			continue
		}
		a := strings.ToLower(*src.Address)
		l := out[a]
		if l.TaskID != "" {
			continue
		}
		l.SourceID = src.ID
		l.TaskID = active[src.ID]
		out[a] = l
	}
	return out
}

func pinnedAddrs(ctx context.Context, s *Server) []string {
	var out []string
	for a := range favorites(ctx, s) {
		out = append(out, a)
	}
	for a := range links(ctx, s) {
		out = append(out, a)
	}
	sort.Strings(out)
	return out
}

type ScoreDto struct {
	Score   int           `json:"score"`
	Factors plaza.Factors `json:"factors"`
}

type WalletDto struct {
	Address      string                  `json:"address"`
	Name         *string                 `json:"name"`
	Equity       float64                 `json:"equity"`
	Perf         map[string]plaza.Perf   `json:"perf"`
	Analyzed     bool                    `json:"analyzed"`
	Error        string                  `json:"error,omitempty"`
	Scores       map[string]ScoreDto     `json:"scores"`
	MaxDD        map[string]float64      `json:"max_dd"`
	WinRate      *float64                `json:"win_rate"`
	AvgHoldSec   *float64                `json:"avg_hold_sec"`
	TradesPerDay float64                 `json:"trades_per_day"`
	HFT          bool                    `json:"hft"`
	Coins        []string                `json:"coins"`
	Curves       map[string][][2]float64 `json:"curves"`
	Favorite     bool                    `json:"favorite"`
	SourceID     *string                 `json:"source_id"`
	TaskID       *string                 `json:"task_id"`
}

func walletDto(w *plaza.Wallet, fav map[string]bool, ln map[string]link, curvePts int) WalletDto {
	d := WalletDto{Address: w.Address, Name: w.DisplayName, Equity: w.LbEquity, Perf: w.Perf, Error: w.Err, Scores: map[string]ScoreDto{}, MaxDD: map[string]float64{}, Coins: []string{}, Curves: map[string][][2]float64{}, Favorite: fav[w.Address]}
	if l, ok := ln[w.Address]; ok {
		d.SourceID = &l.SourceID
		if l.TaskID != "" {
			d.TaskID = &l.TaskID
		}
	}
	if a := w.A; a != nil {
		d.Analyzed = true
		if a.Equity > 0 {
			d.Equity = a.Equity
		}
		d.MaxDD, d.WinRate, d.AvgHoldSec, d.TradesPerDay, d.HFT, d.Coins = a.MaxDD, a.WinRate, a.AvgHoldSec, a.TradesPerDay, a.HFT(), a.Coins
		for _, win := range plaza.Windows {
			sc, f := plaza.Score(w, win)
			d.Scores[win] = ScoreDto{Score: sc, Factors: f}
			d.Curves[win] = thin(a.Curve[win], curvePts)
		}
	}
	return d
}

func thin(p [][2]float64, n int) [][2]float64 {
	if len(p) <= n {
		return p
	}
	out := make([][2]float64, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, p[i*(len(p)-1)/(n-1)])
	}
	return out
}

type PlazaListDto struct {
	Status  plaza.Status `json:"status"`
	Wallets []WalletDto  `json:"wallets"`
}

func plazaList(ctx context.Context, s *Server, _ []byte) (any, error) {
	svc, err := s.plaza()
	if err != nil {
		return nil, err
	}
	ws, st := svc.List(ctx)
	fav, ln := favorites(ctx, s), links(ctx, s)
	out := PlazaListDto{Status: st, Wallets: make([]WalletDto, 0, len(ws))}
	for i := range ws {
		out.Wallets = append(out.Wallets, walletDto(&ws[i], fav, ln, 24))
	}
	return out, nil
}

type PlazaWalletDto struct {
	WalletDto
	Positions      []plaza.Position `json:"positions"`
	PositionsError string           `json:"positions_error,omitempty"`
}

func plazaWallet(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Address string `json:"address"`
	}](body)
	if err != nil {
		return nil, err
	}
	addr := strings.ToLower(strings.TrimSpace(a.Address))
	if !exchange.ValidAddress(addr) {
		return nil, errs.Msg("地址应为 0x 开头的 42 位十六进制")
	}
	svc, err := s.plaza()
	if err != nil {
		return nil, err
	}
	w, err := svc.Wallet(ctx, addr)
	if err != nil {
		return nil, err
	}
	out := PlazaWalletDto{WalletDto: walletDto(w, favorites(ctx, s), links(ctx, s), 60), Positions: []plaza.Position{}}
	if ps, err := svc.Positions(ctx, addr); err != nil {
		out.PositionsError = err.Error()
	} else {
		out.Positions = ps
	}
	return out, nil
}

func plazaFavorite(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Address string `json:"address"`
		On      bool   `json:"on"`
	}](body)
	if err != nil {
		return nil, err
	}
	addr := strings.ToLower(strings.TrimSpace(a.Address))
	if !exchange.ValidAddress(addr) {
		return nil, errs.Msg("地址应为 0x 开头的 42 位十六进制")
	}
	fav := favorites(ctx, s)
	if a.On {
		fav[addr] = true
	} else {
		delete(fav, addr)
	}
	list := make([]string, 0, len(fav))
	for k := range fav {
		list = append(list, k)
	}
	sort.Strings(list)
	b, _ := json.Marshal(list)
	if err := store.SetSetting(ctx, s.E.DB, favKey, string(b)); err != nil {
		return nil, err
	}
	return nil, nil
}
