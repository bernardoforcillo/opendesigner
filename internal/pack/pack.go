// Package pack turns a document into a folder of small, stable, readable files -- one
// JSON file per node plus one for everything else -- and back, so a design can live in git
// with diffs a person can read: moving one rectangle changes ONE line of ONE file, and two
// people editing different nodes never touch the same file.
//
//	<dir>/document.json     id, name, pages, flows, transitions, clips, variables, fonts,
//	                        text styles, components, comments (everything but the nodes)
//	<dir>/nodes/<id>.json   one node
//	<dir>/assets/<hash>     the asset files, as they are (content-addressed, so a rename is free)
//
// The JSON is protojson re-encoded with sorted keys and two-space indentation, one trailing
// newline, so the same document always gives the same bytes.
package pack

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

const (
	documentFile = "document.json"
	nodesDir     = "nodes"
	assetsDir    = "assets"
)

// stable re-encodes a protojson document with sorted keys, indentation and a trailing newline.
// protojson's own output deliberately varies between runs and versions; this does not.
func stable(m proto.Message) ([]byte, error) {
	raw, err := protojson.MarshalOptions{UseProtoNames: false}.Marshal(m)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // keep numbers exactly as protojson wrote them
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil { // map keys are sorted by encoding/json
		return nil, err
	}
	return buf.Bytes(), nil
}

// fileName makes a node id safe as one file name: anything outside [A-Za-z0-9._-] is
// percent-encoded, and a leading dot is too.
func fileName(id string) string {
	var b strings.Builder
	for i := 0; i < len(id); i++ {
		c := id[i]
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.' && i > 0
		if ok {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func unFileName(name string) (string, error) {
	var b strings.Builder
	for i := 0; i < len(name); i++ {
		if name[i] != '%' {
			b.WriteByte(name[i])
			continue
		}
		if i+3 > len(name) {
			return "", fmt.Errorf("bad escape in %q", name)
		}
		var c byte
		if _, err := fmt.Sscanf(name[i+1:i+3], "%02X", &c); err != nil {
			return "", fmt.Errorf("bad escape in %q", name)
		}
		b.WriteByte(c)
		i += 2
	}
	return b.String(), nil
}

// Pack writes doc into dir (created if missing). `assets`, when non-empty, is a directory of
// the document's asset files (named by hash); they are copied under dir/assets. Files of a
// previous pack that no longer have a node are removed, so a pack of the same document
// always leaves exactly its files.
func Pack(doc *opendesignerv1.Document, assets, dir string) error {
	rest := proto.Clone(doc).(*opendesignerv1.Document)
	rest.Nodes = nil
	if err := os.MkdirAll(filepath.Join(dir, nodesDir), 0o755); err != nil {
		return err
	}
	b, err := stable(rest)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, documentFile), b, 0o644); err != nil {
		return err
	}
	want := map[string]bool{}
	ids := make([]string, 0, len(doc.GetNodes()))
	for id := range doc.GetNodes() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		name := fileName(id) + ".json"
		want[name] = true
		nb, err := stable(doc.GetNodes()[id])
		if err != nil {
			return err
		}
		path := filepath.Join(dir, nodesDir, name)
		// Rewrite only what changed: git then sees (and the file system touches) only that.
		if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, nb) {
			continue
		}
		if err := os.WriteFile(path, nb, 0o644); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(filepath.Join(dir, nodesDir))
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() && !want[e.Name()] && strings.HasSuffix(e.Name(), ".json") {
			if err := os.Remove(filepath.Join(dir, nodesDir, e.Name())); err != nil {
				return err
			}
		}
	}
	if assets == "" {
		return nil
	}
	return copyAssets(assets, filepath.Join(dir, assetsDir))
}

func copyAssets(src, dst string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		in, err := os.Open(filepath.Join(src, e.Name()))
		if err != nil {
			return err
		}
		out, err := os.OpenFile(filepath.Join(dst, e.Name()), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			in.Close()
			return err
		}
		_, cerr := io.Copy(out, in)
		in.Close()
		if err := errors.Join(cerr, out.Close()); err != nil {
			return err
		}
	}
	return nil
}

// Unpack reads a packed folder back into a document. The folder holding the asset files
// (dir/assets) is returned too; it may not exist.
func Unpack(dir string) (doc *opendesignerv1.Document, assets string, err error) {
	b, err := os.ReadFile(filepath.Join(dir, documentFile))
	if err != nil {
		return nil, "", fmt.Errorf("%s: %w", dir, err)
	}
	doc = &opendesignerv1.Document{}
	if err := (protojson.UnmarshalOptions{}).Unmarshal(b, doc); err != nil {
		return nil, "", fmt.Errorf("%s: %w", documentFile, err)
	}
	entries, err := os.ReadDir(filepath.Join(dir, nodesDir))
	if err != nil && !os.IsNotExist(err) {
		return nil, "", err
	}
	doc.Nodes = map[string]*opendesignerv1.Node{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id, err := unFileName(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil {
			return nil, "", err
		}
		nb, err := os.ReadFile(filepath.Join(dir, nodesDir, e.Name()))
		if err != nil {
			return nil, "", err
		}
		n := &opendesignerv1.Node{}
		if err := (protojson.UnmarshalOptions{}).Unmarshal(nb, n); err != nil {
			return nil, "", fmt.Errorf("%s/%s: %w", nodesDir, e.Name(), err)
		}
		if n.GetId() != id {
			return nil, "", fmt.Errorf("%s/%s: the file holds node %q", nodesDir, e.Name(), n.GetId())
		}
		doc.Nodes[id] = n
	}
	return doc, filepath.Join(dir, assetsDir), nil
}
