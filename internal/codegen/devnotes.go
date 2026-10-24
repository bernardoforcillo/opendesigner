package codegen

import (
	"fmt"
	"strings"
	"time"

	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// DEV MODE IN THE CODE. A developer reading the generated file should see what the designer
// wrote for them: the annotations attached to a node become comment lines above its element
// (`annotation [interaction] Opens the cart as a sheet (Ana)`), and a screen that is marked ready
// for dev says so in a line above its root (`ready for dev since 2026-10-24 by Ana: note`). The
// lines are plain text without comment delimiters; each renderer wraps them in its own comment
// syntax (`//`, `<!-- -->`), and oneLine keeps `--` out of HTML comments.

// notes: the annotation lines of a node (oldest first).
func (b *builder) notes(nodeID string) []string {
	var out []string
	for _, a := range core.AnnotationsOf(b.doc, nodeID) {
		line := fmt.Sprintf("annotation [%s] %s", a.GetCategory(), oneLine(a.GetText()))
		if a.GetAuthor() != "" {
			line += " (" + oneLine(a.GetAuthor()) + ")"
		}
		out = append(out, safeComment(line))
	}
	return out
}

// readyNote: the ready-for-dev line of a screen ("" slice when it is not marked).
func (b *builder) readyNote(nodeID string) []string {
	r := b.doc.GetReadyForDev()[nodeID]
	if r == nil {
		return nil
	}
	line := "ready for dev"
	if r.GetMarkedAt() > 0 {
		line += " since " + time.Unix(r.GetMarkedAt(), 0).UTC().Format("2006-01-02")
	}
	if r.GetMarkedBy() != "" {
		line += " by " + oneLine(r.GetMarkedBy())
	}
	if r.GetNote() != "" {
		line += ": " + oneLine(r.GetNote())
	}
	return []string{safeComment(line)}
}

// safeComment keeps a line from closing the comment it sits in (`*/`, `-->`, and `--` which HTML comments forbid).
func safeComment(s string) string {
	return strings.NewReplacer("*/", "* /", "-->", "- ->", "--", "- -").Replace(s)
}
