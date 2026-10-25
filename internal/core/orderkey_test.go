package core

import "testing"

// Golden values produced by web/src/store/orderKey.ts::orderKeyBetween, so the two stay in step.
func TestOrderKeyBetweenMatchesTheEditor(t *testing.T) {
	for _, c := range []struct{ a, b, want string }{
		{"", "", "a000000"},
		{"a000001", "a000002", "a000001i"},
		{"a000001", "", "a000002"},
		{"", "a000001", "5"},
		{"a000001", "a000003", "a000002"},
		{"zzz", "", "zzzi"},
		{"a00000z", "", "a000011"},
		{"a000000", "a000001", "a000000i"},
		{"a", "b", "ai"},
		{"a", "a1", "a0i"},
		{"a000001", "a0000011", "a0000010i"},
		{"a000000001", "a000000002", "a000000001i"},
		{"a000000001", "", "a000000002"},
	} {
		got, err := OrderKeyBetween(c.a, c.b)
		if err != nil || got != c.want {
			t.Errorf("OrderKeyBetween(%q, %q) = %q, %v; want %q", c.a, c.b, got, err, c.want)
		}
	}
}

func TestOrderKeyBetweenRefusesABadRange(t *testing.T) {
	for _, c := range [][2]string{{"b", "a"}, {"a", "a"}, {"x", "x0"}, {"A", ""}} {
		if got, err := OrderKeyBetween(c[0], c[1]); err == nil {
			t.Errorf("OrderKeyBetween(%q, %q) = %q, want an error", c[0], c[1], got)
		}
	}
}

func TestOrderKeyBetweenKeepsInserting(t *testing.T) {
	lo, hi := "a000001", "a000002"
	for i := 0; i < 40; i++ {
		k, err := OrderKeyBetween(lo, hi)
		if err != nil || !(lo < k && k < hi) {
			t.Fatalf("step %d: %q, %v not strictly between %q and %q", i, k, err, lo, hi)
		}
		hi = k
	}
}
