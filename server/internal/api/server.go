// Package api exposes the engine over HTTP: POST /api/{command} with a JSON
// body (the old Tauri command arguments, snake_case) and an SSE stream of
// engine events at GET /api/events.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"merchandiser/server/internal/engine"
	"merchandiser/server/internal/errs"
)

type Server struct {
	E     *engine.Engine
	Token string
	// ctx of the process, for work that must outlive a request.
	Ctx context.Context
	// WebDir holds the built frontend (index.html + assets); empty = API only.
	WebDir string
}

type handler func(ctx context.Context, s *Server, body []byte) (any, error)

// errLocked is returned by guarded commands while the UI lock is on.
var errLocked = errs.Msg("界面已锁定")

func (s *Server) guard() error {
	if s.E.Locked() {
		return errLocked
	}
	return nil
}

// bind decodes the request body into T (an empty body yields the zero value).
func bind[T any](body []byte) (T, error) {
	var v T
	if len(strings.TrimSpace(string(body))) == 0 {
		return v, nil
	}
	if err := json.Unmarshal(body, &v); err != nil {
		return v, errs.Msg("参数错误: %v", err)
	}
	return v, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})
	// Ready = this instance owns the data directory and serves the API.
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ready"))
	})
	mux.HandleFunc("GET /api/events", s.auth(s.events))
	mux.HandleFunc("POST /api/{cmd}", s.auth(s.command))
	if s.WebDir != "" {
		mux.Handle("GET /", spa(s.WebDir))
	}
	return cors(mux)
}

// spa serves the built frontend; unknown paths fall back to index.html.
func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.FromSlash(path.Clean("/"+r.URL.Path)))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			// Vite asset names are content-hashed.
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		files.ServeHTTP(w, r)
	})
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	want := []byte("Bearer " + s.Token)
	return func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get("Authorization"))
		if subtle.ConstantTimeCompare(got, want) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "未授权：访问令牌错误"})
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) command(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("cmd")
	h, ok := handlers[name]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "未知命令 " + name})
		return
	}
	body, err := readBody(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	t0 := time.Now()
	out, err := h(r.Context(), s, body)
	if err != nil {
		status := http.StatusBadRequest
		var ex *errs.Exchange
		if errors.As(err, &ex) || errs.IsRateLimited(err) {
			status = http.StatusBadGateway
		}
		slog.Debug("command failed", "cmd", name, "err", err, "ms", time.Since(t0).Milliseconds())
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func readBody(r *http.Request) ([]byte, error) {
	b, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, 16<<20))
	if err != nil {
		return nil, fmt.Errorf("读取请求失败: %w", err)
	}
	return b, nil
}

// events streams engine events as SSE. Heartbeats keep proxies from closing
// idle connections and let the client notice a dead server.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	ch, unsub := s.E.Bus.Subscribe()
	defer unsub()
	_, _ = fmt.Fprint(w, "retry: 3000\n: hello\n\n")
	fl.Flush()
	hb := time.NewTicker(15 * time.Second)
	defer hb.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-hb.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			fl.Flush()
		case ev, ok := <-ch:
			if !ok {
				return
			}
			b, _ := json.Marshal(ev)
			if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
				return
			}
			fl.Flush()
		}
	}
}
