// merchandiser-server runs the copy-trading engine (tasks, persistence,
// monitoring) and serves the desktop client over HTTP.
//
// Environment:
//
//	MERCHANDISER_DATA_DIR             data directory (default /data)
//	MERCHANDISER_ADDR                 listen address (default :8686)
//	MERCHANDISER_TOKEN                API bearer token (generated and stored in the data dir when unset)
//	MERCHANDISER_MASTER_PASSWORD      unlocks secrets.enc at boot (optional)
//	MERCHANDISER_MASTER_PASSWORD_FILE same, read from a file (Docker secrets)
//	MERCHANDISER_WEB_DIR              built frontend to serve at / (default /app/web when present)
//	MERCHANDISER_LOG_LEVEL            debug | info | warn | error (default info)
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata"

	"merchandiser/server/internal/api"
	"merchandiser/server/internal/engine"
	"merchandiser/server/internal/secrets"
	"merchandiser/server/internal/store"
)

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	level := slog.LevelInfo
	_ = level.UnmarshalText([]byte(env("MERCHANDISER_LOG_LEVEL", "info")))
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func loadToken(dir string) (string, error) {
	if t := env("MERCHANDISER_TOKEN", ""); t != "" {
		return t, nil
	}
	p := filepath.Join(dir, "api_token")
	if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) > 0 {
		return strings.TrimSpace(string(b)), nil
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	t := hex.EncodeToString(buf)
	if err := os.WriteFile(p, []byte(t+"\n"), 0o600); err != nil {
		return "", err
	}
	slog.Info("generated API token (stored in data dir)", "file", p, "token", t)
	return t, nil
}

func masterPassword() string {
	if p := os.Getenv("MERCHANDISER_MASTER_PASSWORD"); p != "" {
		return p
	}
	if f := env("MERCHANDISER_MASTER_PASSWORD_FILE", ""); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			slog.Warn("read master password file", "err", err)
			return ""
		}
		return strings.TrimRight(string(b), "\r\n")
	}
	return ""
}

func run() error {
	dir := env("MERCHANDISER_DATA_DIR", "/data")
	addr := env("MERCHANDISER_ADDR", ":8686")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := store.Open(dir)
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err := store.LoadSettings(ctx, db); err != nil {
		slog.Warn("load settings", "err", err)
	}
	token, err := loadToken(dir)
	if err != nil {
		return err
	}

	sec := secrets.New(dir)
	if pw := masterPassword(); pw != "" {
		if err := sec.Unlock(pw); err != nil {
			slog.Error("unlock secrets with the configured master password failed; waiting for the client to unlock", "err", err)
		} else {
			slog.Info("secrets unlocked")
		}
	} else {
		slog.Info("secrets locked; unlock from the client")
	}

	eng := engine.New(ctx, db, sec, engine.NewBus())
	if !sec.Locked() {
		go func() {
			eng.RestoreOnBoot(ctx)
			eng.SampleEquity(ctx)
		}()
	}
	eng.SpawnBackground()

	web := env("MERCHANDISER_WEB_DIR", "/app/web")
	if _, err := os.Stat(filepath.Join(web, "index.html")); err != nil {
		slog.Info("no frontend to serve; API only", "web_dir", web)
		web = ""
	}
	srv := &http.Server{
		Addr:              addr,
		Handler:           (&api.Server{E: eng, Token: token, Ctx: ctx, WebDir: web}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errc := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", addr, "data", dir)
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(sctx)
	// Runners stop with ctx; positions are left as they are and tasks resume on next boot.
	time.Sleep(500 * time.Millisecond)
	return nil
}
