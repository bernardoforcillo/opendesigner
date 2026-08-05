package web

import (
	"io/fs"
	"testing"
)

// Dist must expose the CONTENTS of web/dist, not a directory called "dist".
// Forgetting the fs.Sub is silent: index.html would sit at "dist/index.html",
// the mount would find no index at the root, and the binary would serve the
// "built without the web UI" message while holding a perfectly good frontend.
//
// .gitkeep is the one file guaranteed to be there in every checkout, built or
// clean, which is what makes this assertion safe to run anywhere.
func TestDistIsRootedAtDistContents(t *testing.T) {
	if _, err := fs.Stat(Dist, ".gitkeep"); err != nil {
		t.Fatalf("fs.Stat(Dist, \".gitkeep\") = %v, want web/dist contents at the root of Dist", err)
	}
	if _, err := fs.Stat(Dist, "dist"); err == nil {
		t.Error("Dist still has a \"dist\" directory at its root: the fs.Sub prefix strip is missing")
	}
}
