package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ASSET STORE — a document's images, addressed by content.
//
// It lives in the `assets/` directory that the bundle already provided (see Open)
// and that nobody had ever written. It is deliberately SEPARATE from Bundle and
// not one of its methods: an asset is not an op, does not go through the op-log,
// does not enter the snapshots and does not need b.mu -- a file's name IS its
// content, so two concurrent writes of the same asset write the same bytes to
// the same place and there is nothing to serialize. Keeping it out of Bundle is
// also what makes it impossible, by mistake, to put image bytes on the verified
// op-log path.

// MaxAssetSize is the cap for a single asset (32 MiB).
//
// It lives HERE and not only in the HTTP handler: it is the guard that stops ANY
// caller from filling the disk, not only the one coming over the network. 32 MiB
// is generous for a photo and tight enough not to turn a typo into a space
// problem.
const MaxAssetSize = 32 << 20

// sniffLen is enough to recognize the four allowed raster containers
// (the longest prefix is WebP: 12 bytes). 512 like http.DetectContentType,
// so a file shorter than that is still read in full.
const sniffLen = 512

var (
	// ErrAssetNotFound: no asset with that hash in this document.
	ErrAssetNotFound = errors.New("store: asset not found")
	// ErrAssetHash: the string passed is not a hash (64 lowercase hex digits).
	// Rejected BEFORE any filepath.Join: it is the guard against path
	// traversal, not a shape check.
	ErrAssetHash = errors.New("store: malformed asset hash")
	// ErrAssetDocID: the document id is not a safe path segment.
	ErrAssetDocID = errors.New("store: unsafe document id")
	// ErrAssetType: the bytes are not an image of a type the editor draws.
	ErrAssetType = errors.New("store: unsupported asset type")
	// ErrAssetTooLarge: the asset exceeds MaxAssetSize.
	ErrAssetTooLarge = errors.New("store: asset too large")
)

// imageTypes is the ALLOWLIST, and the fact that it is closed is the point.
//
// http.DetectContentType is not used: that function has an answer for
// any bytes (text/html, application/pdf, text/plain...), and an endpoint that
// accepts arbitrary bytes and serves them back with the guessed type is a
// same-origin host for HTML and scripts -- i.e. a stored XSS, served from the
// same origin as the editor. Here the bytes must be one of the four raster
// containers the canvas can draw, and the Content-Type the handler
// writes comes out of this table, never from the client.
//
// SVG is excluded on purpose, and not out of laziness: an SVG is an XML document
// that can contain <script>, and served whole from this origin it would be
// executed as soon as someone opens its URL. A raster image has no such power.
var imageTypes = []struct {
	prefix []byte
	// mask, when not nil, zeroes the VARIABLE bytes of the prefix (the size
	// of WebP's RIFF chunk): without it, the comparison would depend on the
	// length of the file.
	mask        []byte
	contentType string
}{
	{prefix: []byte("\x89PNG\r\n\x1a\n"), contentType: "image/png"},
	{prefix: []byte("\xff\xd8\xff"), contentType: "image/jpeg"},
	{prefix: []byte("GIF87a"), contentType: "image/gif"},
	{prefix: []byte("GIF89a"), contentType: "image/gif"},
	{
		prefix:      []byte("RIFF\x00\x00\x00\x00WEBP"),
		mask:        []byte("\xff\xff\xff\xff\x00\x00\x00\x00\xff\xff\xff\xff"),
		contentType: "image/webp",
	},
}

// DetectImageType returns the Content-Type of an asset's initial bytes, or ""
// if they are not one of the allowed types. Exported because it is the same
// question asked by whoever writes (Put) and whoever reads (Open): a single
// place that decides what an image is.
func DetectImageType(head []byte) string {
	for _, t := range imageTypes {
		if len(head) < len(t.prefix) {
			continue
		}
		if t.mask == nil {
			if bytes.HasPrefix(head, t.prefix) {
				return t.contentType
			}
			continue
		}
		match := true
		for i := range t.prefix {
			if head[i]&t.mask[i] != t.prefix[i] {
				match = false
				break
			}
		}
		if match {
			return t.contentType
		}
	}
	return ""
}

// Ref is what is known about an asset without reading it: its name (= its
// content), how big it is and how it must be served.
type Ref struct {
	Hash        string
	Size        int64
	ContentType string
}

// Assets is the asset store of ONE document.
type Assets struct {
	workspace string
	docID     string
}

// NewAssets returns the asset store of document docID. It does not touch the
// disk: the directory is created on the first write (and a document without
// images does not need it).
func NewAssets(workspace, docID string) *Assets {
	return &Assets{workspace: workspace, docID: docID}
}

// safeSegment reports whether s can be used as ONE path segment.
//
// The caller (internal/server) already validates the doc id as a UUID; this is
// the check that CANNOT be skipped, because this is where the string meets
// filepath.Join. A ".." or a separator would leave the assets directory,
// and this store reads and writes files on behalf of a public route.
func safeSegment(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	if strings.ContainsAny(s, `/\:`) {
		return false
	}
	return true
}

func (a *Assets) dir() (string, error) {
	if !safeSegment(a.docID) {
		return "", fmt.Errorf("%w: %q", ErrAssetDocID, a.docID)
	}
	return filepath.Join(a.workspace, a.docID+bundleSuffix, "assets"), nil
}

// HasBundle reports whether the document already exists on disk.
//
// It serves the upload route: a POST to an invented id must not make a
// document consisting only of assets COME INTO BEING. Bundles are created by CreateDocument, and
// this store is not another entry point for creating them.
func (a *Assets) HasBundle() bool {
	dir, err := a.dir()
	if err != nil {
		return false
	}
	fi, err := os.Stat(filepath.Dir(dir))
	return err == nil && fi.IsDir()
}

// validHash accepts exactly 64 LOWERCASE hex digits.
//
// Lowercase and not "case-insensitive" on purpose: the hash is the file name, and on
// a case-sensitive filesystem two spellings of the same hash would be two different
// files -- i.e. the same asset stored twice, which is precisely
// what content addressing exists to avoid. A single canonical spelling,
// the one hex.EncodeToString prints.
func validHash(hash string) bool {
	if len(hash) != sha256.Size*2 {
		return false
	}
	for i := 0; i < len(hash); i++ {
		c := hash[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Path is the path of an asset's file. Error (and no path) if the hash
// or the doc id are not safe.
func (a *Assets) Path(hash string) (string, error) {
	dir, err := a.dir()
	if err != nil {
		return "", err
	}
	if !validHash(hash) {
		return "", fmt.Errorf("%w: %q", ErrAssetHash, hash)
	}
	// The file name is the BARE hash, without extension, and the deviation from the
	// design (`assets/<sha256>.<ext>`) is intentional: the node carries only the hash,
	// so with an extension every read would have to guess it or scan the
	// directory, whereas the type is derived from the bytes themselves (DetectImageType) --
	// which is the only source that cannot diverge from the content. The path stays
	// a pure function of the hash: no lookup, no ambiguity.
	return filepath.Join(dir, hash), nil
}

// Put stores the bytes of r and returns the reference to them.
//
// Addressed by content: the same image put twice occupies ONE file.
// The write goes through a temporary file renamed into place, so a
// reader can never observe a half-written asset -- and an asset exists if and only
// if it is complete, which is what allows the name to be a promise about the bytes.
func (a *Assets) Put(r io.Reader) (Ref, error) {
	dir, err := a.dir()
	if err != nil {
		return Ref{}, err
	}

	// The type is decided BEFORE creating any file: a rejected upload
	// must not have touched the disk.
	head := make([]byte, sniffLen)
	n, err := io.ReadFull(r, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return Ref{}, err
	}
	head = head[:n]
	ct := DetectImageType(head)
	if ct == "" {
		return Ref{}, ErrAssetType
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Ref{}, err
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return Ref{}, err
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			// An interrupted upload leaves nothing behind: neither half bytes, nor a file
			// that takes up space without being reachable from any hash.
			tmp.Close()
			os.Remove(tmpName)
		}
	}()

	sum := sha256.New()
	// LimitReader at MaxAssetSize+1: the extra byte is how "exactly as large
	// as the cap" (allowed) is told apart from "larger than the cap" (rejected)
	// without having to read the rest of an upload that will not fit anyway.
	src := io.LimitReader(io.MultiReader(bytes.NewReader(head), r), MaxAssetSize+1)
	size, err := io.Copy(io.MultiWriter(tmp, sum), src)
	if err != nil {
		return Ref{}, err
	}
	if size > MaxAssetSize {
		return Ref{}, fmt.Errorf("%w: over %d bytes", ErrAssetTooLarge, MaxAssetSize)
	}
	if err := tmp.Sync(); err != nil {
		return Ref{}, err
	}
	if err := tmp.Close(); err != nil {
		return Ref{}, err
	}

	hash := hex.EncodeToString(sum.Sum(nil))
	path := filepath.Join(dir, hash)
	// Already present: the same image is already stored, and the bytes are by
	// construction the same (it is the same sha256). It is not rewritten -- renaming
	// over a file someone is serving fails on Windows, and there would be
	// nothing to change anyway.
	if _, err := os.Stat(path); err == nil {
		return Ref{Hash: hash, Size: size, ContentType: ct}, nil
	} else if !os.IsNotExist(err) {
		return Ref{}, err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return Ref{}, err
	}
	committed = true
	// The directory must be fsynced so that the newly created entry is durable, not
	// only its bytes (no-op on Windows, see syncDir).
	if err := syncDir(dir); err != nil {
		return Ref{}, err
	}
	return Ref{Hash: hash, Size: size, ContentType: ct}, nil
}

// Open opens the asset and returns its reference. The caller closes the file.
//
// The Content-Type is RECOMPUTED from the bytes on disk instead of trusting
// something written alongside: it is the same allowlist as the write, so a
// file that ended up there by other means (a manual copy) cannot get itself served as
// HTML.
func (a *Assets) Open(hash string) (*os.File, Ref, error) {
	path, err := a.Path(hash)
	if err != nil {
		return nil, Ref{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, Ref{}, fmt.Errorf("%w: %s", ErrAssetNotFound, hash)
		}
		return nil, Ref{}, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, Ref{}, err
	}
	head := make([]byte, sniffLen)
	n, err := io.ReadFull(f, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		f.Close()
		return nil, Ref{}, err
	}
	ct := DetectImageType(head[:n])
	if ct == "" {
		f.Close()
		return nil, Ref{}, ErrAssetType
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		f.Close()
		return nil, Ref{}, err
	}
	return f, Ref{Hash: hash, Size: fi.Size(), ContentType: ct}, nil
}
