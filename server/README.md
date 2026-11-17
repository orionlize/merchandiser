# merchandiser-server

The Go backend for Merchandiser. It handles copy trading, tasks, mirrored orders, risk controls, persistence, equity sampling and alerts. It also serves the web UI (the React frontend at the repo root, built into `/app/web` in the image), so the browser opens a single address.

## Deploying (Docker)

Run from the repository root (the image builds the frontend and the server together):

```bash
docker compose up -d --build
docker compose logs merchandiser | grep token   # first start without MERCHANDISER_TOKEN: shows the generated token
```

Open `http://127.0.0.1:8686` in a browser and enter the access token.

| Variable | Default | Description |
| --- | --- | --- |
| `MERCHANDISER_DATA_DIR` | `/data` | SQLite database, `secrets.enc` and `api_token` |
| `MERCHANDISER_ADDR` | `:8686` | Listen address |
| `MERCHANDISER_TOKEN` | generated | API Bearer token. If unset, one is generated and written to `<data>/api_token` |
| `MERCHANDISER_MASTER_PASSWORD(_FILE)` | none | Unlocks the key file at startup so tasks resume automatically after a restart. Without it, unlock from the web UI |
| `TZ` | UTC | Timezone that "today" statistics and the daily loss limit use for midnight |
| `MERCHANDISER_WEB_DIR` | `/app/web` | Built frontend served at `/`. If it has no `index.html`, the server runs API only |
| `MERCHANDISER_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

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

All `/api/*` requests require `Authorization: Bearer <token>`.

## Development

```bash
# Terminal 1: server (API only in dev)
cd server && go test ./... && MERCHANDISER_DATA_DIR=./data MERCHANDISER_TOKEN=dev go run ./cmd/merchandiser-server
# Terminal 2: frontend with hot reload at http://localhost:1420 (/api is proxied to :8686)
pnpm install && pnpm dev
```
