//go:build unix

package leader

import (
	"context"
	"testing"
	"time"
)

func TestSecondWaitsForFirst(t *testing.T) {
	dir := t.TempDir()
	first, err := Acquire(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan error, 1)
	go func() {
		f, err := Acquire(context.Background(), dir)
		if err == nil {
			f.Close()
		}
		got <- err
	}()
	select {
	case <-got:
		t.Fatal("second instance acquired the lock while the first held it")
	case <-time.After(1200 * time.Millisecond):
	}
	first.Close()
	select {
	case err := <-got:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("second instance never acquired the lock")
	}
}

func TestStandbyStopsOnCancel(t *testing.T) {
	dir := t.TempDir()
	first, err := Acquire(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	if _, err := Acquire(ctx, dir); err == nil {
		t.Fatal("expected cancellation")
	}
}
