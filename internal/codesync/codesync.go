// Package codesync maps design components (and screens) to the files that implement them in a
// code project, and reports DRIFT between the document and that code, in the manner of Figma's Code
// Connect. Pure: the caller supplies the exported files (internal/codegen) and a way to read the
// project; this package decides what is in sync.
//
// The mapping lives in the node's meta, so it travels with the document and needs no schema change:
//
//	code.file  path of the implementing file, relative to the project root ("src/components/Button.tsx")
//	code.hash  baseline: hash of the exported file the last time the two were reconciled (accept)
//
// A node is resolved to its exported file by the `data-node-id` the generators write on every
// element, so a variant set, a screen or a single master all work by mapping any node inside them.
package codesync

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
)

// Meta keys.
const (
	MetaFile = "code.file"
	MetaHash = "code.hash"
)

// Status of one mapping.
type Status string

const (
	InSync        Status = "in-sync"        // the file equals what the document exports now
	DesignChanged Status = "design-changed" // the document moved since the baseline; the code did not
	CodeChanged   Status = "code-changed"   // the code was edited since the baseline; the document did not
	Diverged      Status = "diverged"       // both moved
	Drifted       Status = "drifted"        // they differ and there is no baseline to say which side moved
	Missing       Status = "missing"        // the mapped file does not exist (or the path is invalid)
	NotExported   Status = "not-exported"   // the node produces no file (hidden, deleted, not in a screen or component)
)

// Entry is the verdict on one mapped node.
type Entry struct {
	NodeID       string `json:"nodeId"`
	Name         string `json:"name"`
	File         string `json:"file"`
	ExportedPath string `json:"exportedPath,omitempty"`
	Status       Status `json:"status"`
	DesignHash   string `json:"designHash,omitempty"`
	CodeHash     string `json:"codeHash,omitempty"`
	Baseline     string `json:"baseline,omitempty"`
	// Detail: the first line where document and code differ, or the reason for an error.
	Detail string `json:"detail,omitempty"`
}

// Unmapped is a component the export produces a file for that nothing maps to.
type Unmapped struct {
	NodeID       string `json:"nodeId"`
	Name         string `json:"name"`
	ExportedPath string `json:"exportedPath"`
}

// Report is the outcome of Check.
type Report struct {
	Entries  []Entry    `json:"entries"`
	Unmapped []Unmapped `json:"unmapped"`
}

// Drift: how many entries are not in sync.
func (r *Report) Drift() int {
	n := 0
	for _, e := range r.Entries {
		if e.Status != InSync {
			n++
		}
	}
	return n
}

// Reader reads a project file by its relative path.
type Reader func(rel string) ([]byte, error)

// DirReader reads files under root and refuses any path that leaves it.
func DirReader(root string) Reader {
	return func(rel string) ([]byte, error) {
		p, err := Clean(rel)
		if err != nil {
			return nil, err
		}
		return os.ReadFile(filepath.Join(root, filepath.FromSlash(p)))
	}
}

// Clean validates a mapped path: relative, inside the project, slash-separated.
func Clean(rel string) (string, error) {
	rel = strings.ReplaceAll(strings.TrimSpace(rel), "\\", "/")
	if rel == "" {
		return "", errors.New("empty file path")
	}
	if strings.HasPrefix(rel, "/") || (len(rel) > 1 && rel[1] == ':') {
		return "", fmt.Errorf("%q: the path must be relative to the project root", rel)
	}
	c := path.Clean(rel)
	if c == ".." || strings.HasPrefix(c, "../") || c == "." {
		return "", fmt.Errorf("%q: the path leaves the project", rel)
	}
	return c, nil
}

// Hash of a file's content, insensitive to line endings and trailing blank space at the end.
func Hash(b []byte) string {
	sum := sha256.Sum256(normalize(b))
	return hex.EncodeToString(sum[:8])
}

func normalize(b []byte) []byte {
	b = bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n"))
	return bytes.TrimRight(b, " \t\n")
}

// Mapped lists the nodes that have a code.file, sorted by id.
func Mapped(doc *opendesignerv1.Document) []*opendesignerv1.Node {
	var out []*opendesignerv1.Node
	for _, n := range doc.GetNodes() {
		if n.GetMeta()[MetaFile] != "" {
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetId() < out[j].GetId() })
	return out
}

func isUnit(p string) bool {
	return strings.HasPrefix(p, "src/components/") || strings.HasPrefix(p, "src/screens/") ||
		(strings.HasSuffix(p, ".html") && !strings.Contains(p, "/"))
}

// index maps design node ids to the exported file that holds them. A component master appears in
// its component file as "cmp-<component id>/<node id>"; that file wins over a screen that happens to
// hold a node of the same id, because the master is what a person maps.
type index struct{ comp, exact map[string]string }

func buildIndex(files []codegen.File) *index {
	ix := &index{comp: map[string]string{}, exact: map[string]string{}}
	marker := []byte(`data-node-id="`)
	for _, f := range files {
		if !isUnit(f.Path) {
			continue
		}
		rest := f.Content
		for {
			i := bytes.Index(rest, marker)
			if i < 0 {
				break
			}
			rest = rest[i+len(marker):]
			j := bytes.IndexByte(rest, '"')
			if j < 0 {
				break
			}
			id := string(rest[:j])
			rest = rest[j:]
			if strings.HasPrefix(id, "cmp-") {
				if k := strings.LastIndex(id, "/"); k > 0 {
					if _, ok := ix.comp[id[k+1:]]; !ok {
						ix.comp[id[k+1:]] = f.Path
					}
				}
			}
			if _, ok := ix.exact[id]; !ok {
				ix.exact[id] = f.Path
			}
		}
	}
	return ix
}

func (ix *index) owner(nodeID string) string {
	if p, ok := ix.comp[nodeID]; ok {
		return p
	}
	return ix.exact[nodeID]
}

// Check compares every mapped node's file with what the document exports (`files`, from
// codegen.Generate) and lists the components that nothing maps to.
func Check(doc *opendesignerv1.Document, files []codegen.File, read Reader) *Report {
	rep := &Report{Entries: []Entry{}, Unmapped: []Unmapped{}}
	byPath := map[string][]byte{}
	for _, f := range files {
		byPath[f.Path] = f.Content
	}
	ix := buildIndex(files)
	covered := map[string]bool{}
	for _, n := range Mapped(doc) {
		e := Entry{NodeID: n.GetId(), Name: n.GetName(), File: n.GetMeta()[MetaFile], Baseline: n.GetMeta()[MetaHash]}
		ex := ix.owner(n.GetId())
		if ex != "" {
			covered[ex] = true
		}
		e.ExportedPath = ex
		if _, err := Clean(e.File); err != nil {
			e.Status, e.Detail = Missing, err.Error()
		} else if ex == "" {
			e.Status = NotExported
		} else {
			design := byPath[ex]
			e.DesignHash = Hash(design)
			code, err := read(e.File)
			switch {
			case err != nil && errors.Is(err, fs.ErrNotExist):
				e.Status = Missing
			case err != nil:
				e.Status, e.Detail = Missing, err.Error()
			default:
				e.CodeHash = Hash(code)
				e.Status = classify(e.DesignHash, e.CodeHash, e.Baseline)
				if e.Status != InSync {
					e.Detail = firstDiff(design, code)
				}
			}
		}
		rep.Entries = append(rep.Entries, e)
	}
	// Components the export writes a file for, with no mapping on any node of that file.
	seen := map[string]bool{}
	ids := make([]string, 0, len(doc.GetComponents()))
	for id := range doc.GetComponents() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		c := doc.GetComponents()[id]
		ex := ix.owner(c.GetRootNodeId())
		if ex == "" || covered[ex] || seen[ex] || !strings.HasPrefix(ex, "src/components/") {
			continue
		}
		seen[ex] = true
		name := c.GetName()
		if s := doc.GetComponentSets()[c.GetSetId()]; s != nil {
			name = s.GetName()
		}
		rep.Unmapped = append(rep.Unmapped, Unmapped{NodeID: c.GetRootNodeId(), Name: name, ExportedPath: ex})
	}
	return rep
}

func classify(design, code, baseline string) Status {
	switch {
	case design == code:
		return InSync
	case baseline == "":
		return Drifted
	case baseline == design:
		return CodeChanged
	case baseline == code:
		return DesignChanged
	}
	return Diverged
}

// firstDiff: "line 12: design `a` / code `b`".
func firstDiff(design, code []byte) string {
	d := strings.Split(string(normalize(design)), "\n")
	c := strings.Split(string(normalize(code)), "\n")
	for i := 0; i < len(d) || i < len(c); i++ {
		var a, b string
		if i < len(d) {
			a = strings.TrimSpace(d[i])
		}
		if i < len(c) {
			b = strings.TrimSpace(c[i])
		}
		if a != b {
			return fmt.Sprintf("line %d: design %s / code %s", i+1, quote(a), quote(b))
		}
	}
	return ""
}

func quote(s string) string {
	if s == "" {
		return "(nothing)"
	}
	if len(s) > 80 {
		s = s[:80] + "..."
	}
	return "`" + s + "`"
}
