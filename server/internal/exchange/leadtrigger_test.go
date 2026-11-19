package exchange

import (
	"testing"
	"time"
)

func TestTriggerNeedPoll(t *testing.T) {
	b := &fillBook{}
	if !b.needPoll(1000) {
		t.Fatal("first check must read the history")
	}
	b.polledAt, b.seenTrade = time.Now(), 1000
	if b.needPoll(1000) {
		t.Fatal("unchanged lastTradeTime must not read the history")
	}
	if !b.needPoll(2000) {
		t.Fatal("a new lastTradeTime must read the history")
	}
	b.polledAt = time.Now().Add(-triggerSafetyPoll)
	if !b.needPoll(1000) {
		t.Fatal("safety poll is due")
	}
	// No lastTradeTime: behave like interval mode.
	b.polledAt = time.Now()
	if b.needPoll(0) {
		t.Fatal("interval fallback polled too early")
	}
	b.polledAt = time.Now().Add(-fillsPollEvery)
	if !b.needPoll(0) {
		t.Fatal("interval fallback must poll after fillsPollEvery")
	}
}

func TestTriggerAfterPoll(t *testing.T) {
	st := NewFillState(0)
	b := &fillBook{state: st}

	// The fill is visible (lastTradeTime runs ~1 s after it): caught up.
	st.LastTs = 100_000
	b.afterPoll(st, 101_200)
	if b.seenTrade != 101_200 || !b.pendingSince.IsZero() {
		t.Fatalf("expected caught up, got seen=%d pending=%v", b.seenTrade, b.pendingSince)
	}

	// The history lags behind lastTradeTime: keep chasing it.
	b.afterPoll(st, 500_000)
	if b.seenTrade != 101_200 || b.pendingSince.IsZero() {
		t.Fatal("expected pending")
	}
	b.polledAt = time.Now()
	if !b.needPoll(500_000) {
		t.Fatal("pending trade must keep polling")
	}

	// Give up after triggerPendingMax.
	b.pendingSince = time.Now().Add(-triggerPendingMax)
	b.afterPoll(st, 500_000)
	if b.seenTrade != 500_000 || !b.pendingSince.IsZero() {
		t.Fatal("expected to give up chasing")
	}
	if b.needPoll(500_000) {
		t.Fatal("given-up trade must not keep polling")
	}
}
