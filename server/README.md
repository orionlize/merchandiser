# merchandiser-server

The Go backend for Merchandiser. It handles copy trading, tasks, mirrored orders, risk controls, persistence, equity sampling and alerts. It also serves the web UI (the React frontend at the repo root, built into `/app/web` in the image), so the browser opens a single address.

## Deploying (Docker, blue-green)

Run from the repository root (the image builds the frontend and the server together):

```bash
./deploy.sh                                     # first start, and every release
docker compose logs blue | grep token           # first start without MERCHANDISER_TOKEN: shows the generated token
```

Open `http://127.0.0.1:8686` in a browser and enter the access token.

Compose runs two copies of the server, `blue` and `green`, on one data volume, behind a Caddy `gateway` (the only service with a published port). `./deploy.sh`:

1. builds the idle color from the current checkout and starts it; it **stands by** (`/healthz` 200, `/readyz` 503) because the live color holds `/data/engine.lock`
2. stops the live color (it reports not-ready for 2 s so the gateway drains it, then exits and releases the lock)
3. the new color takes the lock, backs the database up to `/data/backups`, migrates, restores tasks and turns ready; the gateway sends traffic to it

Copy trading pauses for the few seconds of steps 2–3. Web requests wait at the gateway in the meantime instead of failing. If the new color does not become ready within `READY_TIMEOUT` (180 s), the old one is started again. The old container stays stopped so you can switch back:

```bash
./deploy.sh status      # which color is live / standby / stopped
./deploy.sh rollback    # start the previous color, stop the current one
```

Only one process ever runs the engine on a data directory: a second instance waits for the lock, so blue and green never trade at the same time or write the database together. A rollback runs the old build against the database as the new build left it; if a release changed the schema, restore the pre-start copy from `/data/backups` while both colors are stopped.

Set `MERCHANDISER_MASTER_PASSWORD_FILE` (see `docker-compose.yml`). Otherwise secrets are locked after every switch and tasks wait for an unlock from the web UI.

**Upgrading from the single-service compose file:** the first `./deploy.sh` stops and removes the old `merchandiser` container before starting `blue`, because older builds don't take the lock. The data volume is kept. Expect a short outage that one time.

| Variable | Default | Description |
| --- | --- | --- |
| `MERCHANDISER_DATA_DIR` | `/data` | SQLite database, `secrets.enc` and `api_token` |
| `MERCHANDISER_ADDR` | `:8686` | Listen address |
| `MERCHANDISER_TOKEN` | generated | API Bearer token. If unset, one is generated and written to `<data>/api_token` |
| `MERCHANDISER_MASTER_PASSWORD(_FILE)` | none | Unlocks the key file at startup so tasks resume automatically after a restart. Without it, unlock from the web UI |
| `TZ` | UTC | Timezone that "today" statistics and the daily loss limit use for midnight |
| `MERCHANDISER_WEB_DIR` | `/app/web` | Built frontend served at `/`. If it has no `index.html`, the server runs API only |
| `MERCHANDISER_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `MERCHANDISER_BACKUP_ON_START` | off (`1` in compose) | Copy the database to `<data>/backups` (newest 5 kept) before opening it |
| `MERCHANDISER_DRAIN` | `2s` | On shutdown, how long to report not-ready before closing the listener |

**Security**
- The compose file binds only to `127.0.0.1` by default.
- For remote access, put an HTTPS reverse proxy (Caddy / Nginx) in front.
- Don't expose the plain HTTP port to the public internet.
- API keys are encrypted at rest with the master password (Argon2id + XChaCha20-Poly1305) and are never returned to the browser.
- Browser notifications only work over HTTPS or on localhost.

## Migrating from the old desktop build

The database schema is unchanged. To migrate, stop the old desktop app, then copy these files from its data directory into the volume:
- `merchandiser.db`
- `secrets.enc`, only if the desktop build used the encrypted-file mode

If keys were stored in the system keychain, re-enter them on the Connections page.

## API

- `POST /api/{command}`
  - The JSON body holds the command arguments, in snake_case.
  - On success, the response is the JSON result.
  - On failure, the response is `{"error": "..."}`.
- `GET /api/events` is an SSE stream. Events look like `{"kind":"changed","scope":"tasks"}` or `{"kind":"alert","level":"error","title":"...","detail":"..."}`.
- `GET /healthz` is the liveness probe. It needs no authentication.
- `GET /readyz` returns 200 only on the instance that holds the data directory and serves the API (503 in standby or while draining). No authentication.

All `/api/*` requests require `Authorization: Bearer <token>`.

## Development

```bash
# Terminal 1: server (API only in dev)
cd server && go test ./... && MERCHANDISER_DATA_DIR=./data MERCHANDISER_TOKEN=dev go run ./cmd/merchandiser-server
# Terminal 2: frontend with hot reload at http://localhost:1420 (/api is proxied to :8686)
pnpm install && pnpm dev
```
