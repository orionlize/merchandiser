# syntax=docker/dockerfile:1
# One image: Go server (copy trading, tasks, persistence, monitoring) + the web UI it serves.

FROM node:24-alpine AS web
WORKDIR /web
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
RUN pnpm build

FROM golang:1.26-alpine AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/merchandiser-server ./cmd/merchandiser-server

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -H -u 10001 app \
    && mkdir -p /data && chown app /data
COPY --from=server /out/merchandiser-server /usr/local/bin/merchandiser-server
COPY --from=web /web/dist /app/web
USER app
ENV MERCHANDISER_DATA_DIR=/data \
    MERCHANDISER_ADDR=:8686 \
    MERCHANDISER_WEB_DIR=/app/web
VOLUME /data
EXPOSE 8686
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8686/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/merchandiser-server"]
