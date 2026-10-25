package core

import (
	"fmt"
	"strings"
)

// Fractional order keys: the Go twin of web/src/store/orderKey.ts. A key is a FRACTION in base 36
// over the ordered alphabet 0-9a-z, compared as a string; OrderKeyBetween returns a key strictly
// between two others so a node can be slotted between neighbours with a single write. The MCP
// tools that reorder nodes (arrange, group, ...) use it with the same rules as the editor.
//
// Invariant: no generated key ends with the lowest digit "0" (no key could ever be inserted
// right before it). Legacy keys that do are accepted as input.

const (
	orderDigits   = "0123456789abcdefghijklmnopqrstuvwxyz"
	orderBase     = len(orderDigits)
	orderMaxDigit = orderBase - 1
	// firstOrderKey is the key of the first node of an empty parent (the M0 format).
	firstOrderKey = "a000000"
)

func orderToDigits(key, label string) ([]int, error) {
	out := make([]int, 0, len(key))
	for _, ch := range key {
		d := strings.IndexRune(orderDigits, ch)
		if d < 0 {
			return nil, fmt.Errorf("order key: %s key %q has an invalid digit %q", label, key, ch)
		}
		out = append(out, d)
	}
	return out, nil
}

func orderToKey(d []int) string {
	var b strings.Builder
	for _, x := range d {
		b.WriteByte(orderDigits[x])
	}
	return b.String()
}

// orderKeyAfter is the key immediately following digits (open upper bound).
func orderKeyAfter(digits []int) []int {
	for i := len(digits) - 1; i >= 0; i-- {
		if digits[i] < orderMaxDigit {
			out := append(append([]int{}, digits[:i]...), digits[i]+1)
			if len(out) < len(digits) {
				for len(out) < len(digits)-1 {
					out = append(out, 0)
				}
				out = append(out, 1)
			}
			return out
		}
	}
	return append(append([]int{}, digits...), orderBase/2)
}

func orderMidpoint(a, b []int) ([]int, error) {
	var prefix []int
	n := max(len(a), len(b))
	at := func(s []int, i int) int {
		if i < len(s) {
			return s[i]
		}
		return 0
	}
	for i := 0; i < n; i++ {
		da, db := at(a, i), at(b, i)
		if da == db {
			prefix = append(prefix, da)
			continue
		}
		if db-da >= 2 {
			return append(prefix, (da+db)/2), nil
		}
		var tail []int
		if i+1 < len(a) {
			tail = a[i+1:]
		}
		return append(append(prefix, da), orderKeyAfter(tail)...), nil
	}
	return nil, fmt.Errorf("order key: no key exists between %q and %q", orderToKey(a), orderToKey(b))
}

// OrderKeyBetween returns a key strictly between a and b in lexicographic order; an empty string
// is an open bound ("" and "" give the first key). It errors, instead of emitting a key that would
// break the order, when a >= b.
func OrderKeyBetween(a, b string) (string, error) {
	if a != "" && b != "" && a >= b {
		return "", fmt.Errorf("order key: invalid range %q >= %q", a, b)
	}
	if a == "" && b == "" {
		return firstOrderKey, nil
	}
	if b == "" {
		d, err := orderToDigits(a, "lower")
		if err != nil {
			return "", err
		}
		return orderToKey(orderKeyAfter(d)), nil
	}
	hi, err := orderToDigits(b, "upper")
	if err != nil {
		return "", err
	}
	var lo []int
	if a != "" {
		if lo, err = orderToDigits(a, "lower"); err != nil {
			return "", err
		}
	}
	mid, err := orderMidpoint(lo, hi)
	if err != nil {
		return "", err
	}
	return orderToKey(mid), nil
}
