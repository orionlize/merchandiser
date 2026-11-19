# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Merchandiser is a self-hosted copy-trading app for **Hyperliquid perps only** (plus a simulated "paper" venue). A Go server runs the copy engine, persists to SQLite and serves a React web UI. UI strings are Chinese-first with inline English.

## Commands

Frontend (repo root, pnpm):
- `pnpm dev`: Vite dev server. It proxies `/api` to the Go server at `MERCHANDISER_API` (default `http://127.0.0.1:8686`).
- `pnpm typecheck`: `tsc -b --noEmit`. `noUnusedLocals` is on. Note that `pnpm -s typecheck` is not a valid invocation.
- `pnpm build`: builds into `dist/`.

There is no linter or JS test runner configured.

Backend (`cd server`, Go 1.26):
- `go build ./...`, `go vet ./...` and `go test ./...`.
- Run one test with `go test ./internal/engine -run TestName -v`.
- Run the server locally:
  ```
  MERCHANDISER_DATA_DIR=/tmp/mdata MERCHANDISER_ADDR=127.0.0.1:8686 \
  MERCHANDISER_TOKEN=devtoken MERCHANDISER_MASTER_PASSWORD=devpass12 \
  MERCHANDISER_WEB_DIR=../dist go run ./cmd/merchandiser-server
  ```
  - The UI asks for the server URL and token. They are stored in localStorage under `merchandiser.server`.
  - Smoke-test a command with `curl -X POST -H "Authorization: Bearer devtoken" 127.0.0.1:8686/api/list_sources`.

Deploy: one Docker image containing the Go binary and `dist`. Use `./deploy.sh` (blue-green) rather than `docker compose up`.
- Blue and green share the `/data` volume.
- The server takes an exclusive lock on `/data/engine.lock` (`internal/leader`). A second instance stays healthy but not ready (`/readyz`) until the lock frees.

## Architecture

**Transport.** There is no REST resource model.
- Every call is `POST /api/{command}` with a snake_case JSON body. These are the old Tauri command names.
- The command → handler map is in `server/internal/api/misc.go` (`handlers`).
- Handlers are `func(ctx, *Server, body []byte) (any, error)` and decode with `bind[T]`.
- Mutating handlers call `s.guard()`, which fails while the UI is locked.
- Errors are returned as `{error}`. User-facing messages are Chinese and built with `errs.Msg`.
- `GET /api/events` is an SSE stream from `engine.Bus`.
  - Handlers call `s.E.Changed("sources")` and similar.
  - The frontend (`subscribeEngine` in `src/lib/queries.ts`) invalidates the matching react-query keys.
  - So after a mutation, emit `Changed(<query key>)` rather than relying on polling.

**Engine** (`server/internal/engine`):
- `Engine` owns cached exchange adapters per connection, contract maps (`Markets`) and one `runner` per active task.
- `task.go` holds the runner loop. Each step:
  - snapshots the source;
  - `detectSignals` diffs net positions against the previous read;
  - computes each follower's target per coin (`targetFor`, with the sizing maths in `rules.go`: equity_ratio, fixed_multiple or fixed_notional);
  - runs risk checks and `execute`s the difference with slippage, leverage and retries;
  - optionally mirrors the source's resting orders (`syncMirrors`).
- Runtime state that must survive restarts is persisted as the task's `baseline_json`.
- Task `rules_json` and `risk_json` are free-form JSON with custom `UnmarshalJSON` defaults. Add new rule fields there, not as DB columns.

**Exchanges** (`server/internal/exchange`):
- There is one `Exchange` interface (`exchange.go`). Implementations:
  - `hyperliquid.go`: public `/info` reads, plus EIP-712 agent-wallet signing for trading. Agent wallets cannot withdraw. A main-wallet key is rejected.
  - `paper.go`: simulated fills priced from the HL feed.
- All HL calls share a per-IP weight `TokenBucket` (`hlBucket`).
  - Background crawlers must take their own smaller budget on top of it, e.g. via `PublicInfo(..., extra)`, so live trading is never starved.
  - Non-high-priority callers leave a 20% reserve.

**Sources vs connections:**
- A *connection* is a follower account: API credentials, stored encrypted in `secrets.enc` (Argon2id + XChaCha20, unlocked by the master password).
- A *source* is what gets followed. Its kind is either `hl_address` (any public address, read-only) or `api` (one of your own connections).
- `engine.SourceAdapter` and `BuildAdapter` map rows to adapters.

**Plaza** (`server/internal/plaza`, `api/plaza.go`, `src/pages/Plaza.tsx`): the "跟单员广场" leaderboard.
- It lazily starts a crawler on first use, pulls the HL stats leaderboard, picks about 60 candidates, and analyses each one from its portfolio curve and 7-day fills.
- It computes a 0–100 copy-fit score, with heavy penalties for HFT wallets.
- Results are in memory only. The crawler stops after 1 hour idle. Favourites are stored in the `settings` table under `plaza_favorites`.
- "Copy this wallet" creates an `hl_address` source, then calls `go("wizard", undefined, sourceId)`.

**Store** (`server/internal/store`):
- SQLite via `modernc.org/sqlite` (pure Go, `CGO_ENABLED=0`).
- Migrations are embedded SQL files. `migrate()` applies each one conditionally by probing for a column, so add new migrations the same way.
- Row structs pair with `*Cols` constants and `scan*` functions. Keep all three in sync.
- Simple key/value config goes in `settings` (`GetSetting`/`SetSetting`).

**Frontend** (`src/`, React 19, Tailwind v4, zustand, @tanstack/react-query, lightweight-charts):
- There is no router. `useUi().route` (`src/lib/store.ts`) holds `{page, id?, src?}`.
  - Navigate with `go(page, id?, src?)`.
  - Pages are switched in `App.tsx` (`Title` and `Page`).
  - Desktop sidebar and phone bottom tabs are configured in `components/Shell.tsx`.
- `src/lib/api.ts` holds every server type and the `api.*` wrappers around `invoke(cmd, body)`. The server's JSON is snake_case.
- `src/lib/queries.ts` has the react-query hooks, plus `useAction` for mutations with toast and invalidation.
- Strings are bilingual inline: `const tr = useTr(); tr("中文", "English")`. Use `trNow` outside components.
- Design tokens are CSS variables in `src/styles.css`, exposed as Tailwind colors such as `bg-primary-soft`, `text-muted-fg` and `text-success`.
  - Prefer the shared primitives in `components/ui.tsx`.
  - Numbers use the `num` class and the `lib/format.ts` helpers. These use a true minus sign "−".
- Responsive layout uses `md:` / `max-md:`. Phones use bottom sheets, desktops use side panels.

**Design references:**
- `design/*.html` and `design/v2/*.html` are exported static mockups, including `copytrade-ui-v2-plaza.html`.
- The v2 design system is dark-first, with yellow `#F0B90B` as primary.

## Gotchas

- Legacy rows from removed venues (OKX, Binance, Gate) or removed kinds (`lead_trader`) may still exist in user databases.
  - The UI lists them only so they can be deleted.
  - `importConfig` skips them via `supportedPlatform`.
  - Don't add destructive migrations for them without asking.
- Server-side money and size maths uses `shopspring/decimal`, read through the `util.J` JSON wrapper (`JDec`, `JStr`). `util.J.Int()` only works on `json.Number`, so parse JSON with `util.ParseJ`, including in tests.
