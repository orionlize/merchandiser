package exchange

import "testing"

func fl(keys ...string) []Fill {
	out := make([]Fill, len(keys))
	for i, k := range keys {
		out[i] = Fill{Key: k}
	}
	return out
}

func keys(fs []Fill) string {
	s := ""
	for _, f := range fs {
		s += f.Key
	}
	return s
}

func TestHeadShift(t *testing.T) {
	old := fl("a", "a", "b", "c")
	cases := []struct {
		now  []Fill
		want int
	}{
		{fl("a", "a", "b", "c"), 0},
		// Identical fills: one new "a" in front is a shift of 1, not 0.
		{fl("a", "a", "a", "b"), 1},
		{fl("x", "y", "a", "a"), 2},
		{fl("x", "y", "z", "w"), 4},
	}
	for _, c := range cases {
		if got := headShift(old, c.now); got != c.want {
			t.Errorf("headShift(%s) = %d, want %d", keys(c.now), got, c.want)
		}
	}
}

func TestDropBoundaryRepeats(t *testing.T) {
	// True history: a b c d e f; one fill arrived after page 1, so page 2
	// starts with page 1's last fill again.
	got := keys(dropBoundaryRepeats([][]Fill{fl("a", "b", "c"), fl("c", "d", "e"), fl("f")}, 1))
	if got != "abcdef" {
		t.Errorf("got %s", got)
	}
	// Budget spent: a later legitimate repeat at a boundary is kept.
	got = keys(dropBoundaryRepeats([][]Fill{fl("a", "b"), fl("b", "c"), fl("c", "d")}, 1))
	if got != "abccd" {
		t.Errorf("got %s", got)
	}
	// No budget: nothing dropped.
	got = keys(dropBoundaryRepeats([][]Fill{fl("a", "a"), fl("a", "b")}, 0))
	if got != "aaab" {
		t.Errorf("got %s", got)
	}
}
