// Package leader makes sure only one server process runs the engine on a data
// directory. Blue-green deploys start the new instance while the old one is
// still up; the new one waits here (standby) until the old one exits, so two
// processes never trade the same tasks or write the same database.
package leader

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// Acquire blocks until it holds the exclusive lock on dir/engine.lock or ctx
// ends. The lock is released when the returned file is closed or the process
// exits (so a crashed holder never blocks a successor).
func Acquire(ctx context.Context, dir string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "engine.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	logged := false
	for {
		ok, err := tryLock(f)
		if err != nil {
			f.Close()
			return nil, err
		}
		if ok {
			return f, nil
		}
		if !logged {
			slog.Info("another instance holds the data directory; standing by until it exits")
			logged = true
		}
		select {
		case <-ctx.Done():
			f.Close()
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}
