// Package web carries the compiled editor INSIDE the binary.
//
// It makes `opendesigner` a single self-sufficient file: no frontend
// build, no -web flag, no directory to ship alongside. It is what
// lets the npm distribution be a single executable.
//
// The package lives in web/ and not under internal/ because //go:embed cannot
// look outside its own directory: the directive must sit next to the
// dist/ it embeds.
package web

import (
	"embed"
	"io/fs"
)

// The all: prefix matters: without it //go:embed skips names beginning with "."
// or "_", and dist/.gitkeep is exactly such a name -- the one file present in a
// clean checkout. Plain `//go:embed dist` would match nothing there and fail to
// compile.
//
//go:embed all:dist
var dist embed.FS

// Dist is the built frontend with the "dist" path prefix stripped, so
// index.html sits at its root and it can be handed straight to a file server.
// See internal/server.MountWeb, which serves it at "/".
//
// In a clean checkout this holds only the placeholder; the binary then serves
// an explanation instead of an editor, and stays buildable either way.
var Dist fs.FS = mustSub(dist, "dist")

// mustSub panics only when the embed above and the name here disagree, which is
// a build-time mistake in this file rather than anything a running server can
// provoke.
func mustSub(f embed.FS, dir string) fs.FS {
	sub, err := fs.Sub(f, dir)
	if err != nil {
		panic("web: embedded " + dir + " missing: " + err.Error())
	}
	return sub
}
