package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testDoc = "11111111-2222-3333-4444-555555555555"

// tinyPNG/tinyJPEG/tinyGIF are REAL encoded images, produced by the stdlib
// encoders rather than pasted as byte literals: the store's job is to accept
// what a browser can actually decode, so the fixtures have to be that.
func tinyImage(w, h int, c color.Color) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, c)
		}
	}
	return img
}

func tinyPNG(t *testing.T, c color.Color) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, tinyImage(2, 2, c)); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func tinyJPEG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, tinyImage(2, 2, color.RGBA{R: 200, A: 255}), nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func tinyGIF(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	pal := image.NewPaletted(image.Rect(0, 0, 2, 2), color.Palette{color.Black, color.White})
	if err := gif.Encode(&buf, pal, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// A WebP file has no stdlib encoder; the sniffer only reads the RIFF container
// header, which is what this reproduces.
func tinyWebP() []byte {
	b := make([]byte, 32)
	copy(b, "RIFF")
	b[4] = 24 // little-endian chunk size, irrelevant to the sniff
	copy(b[8:], "WEBPVP8 ")
	return b
}

func assetFiles(t *testing.T, workspace, docID string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(workspace, docID+bundleSuffix, "assets"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func mustPut(t *testing.T, a *Assets, data []byte) Ref {
	t.Helper()
	ref, err := a.Put(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	return ref
}

func readAsset(t *testing.T, a *Assets, hash string) ([]byte, Ref) {
	t.Helper()
	f, ref, err := a.Open(hash)
	if err != nil {
		t.Fatalf("Open(%q): %v", hash, err)
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	return data, ref
}

// The hash is the sha256 of the bytes and nothing else: checked against an
// independent computation, so the store cannot quietly switch to some other
// naming scheme and still pass its own dedup test.
func TestAssetHashIsSha256OfTheBytes(t *testing.T) {
	ws := t.TempDir()
	a := NewAssets(ws, testDoc)
	data := tinyPNG(t, color.RGBA{G: 255, A: 255})

	ref := mustPut(t, a, data)

	sum := sha256.Sum256(data)
	if ref.Hash != hex.EncodeToString(sum[:]) {
		t.Fatalf("hash = %q, want the sha256 %q", ref.Hash, hex.EncodeToString(sum[:]))
	}
	if ref.Size != int64(len(data)) {
		t.Fatalf("size = %d, want %d", ref.Size, len(data))
	}
	if ref.ContentType != "image/png" {
		t.Fatalf("content type = %q, want image/png", ref.ContentType)
	}
}

// The whole point of content addressing: the same image dropped twice is
// stored ONCE.
func TestAssetPutIsIdempotentForTheSameBytes(t *testing.T) {
	ws := t.TempDir()
	a := NewAssets(ws, testDoc)
	data := tinyPNG(t, color.RGBA{B: 255, A: 255})

	first := mustPut(t, a, data)
	second := mustPut(t, a, data)

	if first.Hash != second.Hash {
		t.Fatalf("same bytes gave two hashes: %q and %q", first.Hash, second.Hash)
	}
	if files := assetFiles(t, ws, testDoc); len(files) != 1 {
		t.Fatalf("the same image is stored %d times (%v), want once", len(files), files)
	}
}

func TestAssetPutKeepsDifferentImagesApart(t *testing.T) {
	ws := t.TempDir()
	a := NewAssets(ws, testDoc)

	red := mustPut(t, a, tinyPNG(t, color.RGBA{R: 255, A: 255}))
	blue := mustPut(t, a, tinyPNG(t, color.RGBA{B: 255, A: 255}))

	if red.Hash == blue.Hash {
		t.Fatal("two different images collapsed onto one hash")
	}
	if files := assetFiles(t, ws, testDoc); len(files) != 2 {
		t.Fatalf("stored %d files (%v), want 2", len(files), files)
	}
}

func TestAssetOpenReturnsTheExactBytes(t *testing.T) {
	ws := t.TempDir()
	a := NewAssets(ws, testDoc)
	data := tinyJPEG(t)

	ref := mustPut(t, a, data)
	got, gotRef := readAsset(t, a, ref.Hash)

	if !bytes.Equal(got, data) {
		t.Fatalf("read back %d bytes, want the %d that went in", len(got), len(data))
	}
	if gotRef.ContentType != "image/jpeg" {
		t.Fatalf("content type = %q, want image/jpeg", gotRef.ContentType)
	}
	if gotRef.Size != int64(len(data)) {
		t.Fatalf("size = %d, want %d", gotRef.Size, len(data))
	}
}

func TestAssetOpenUnknownHashIsNotFound(t *testing.T) {
	a := NewAssets(t.TempDir(), testDoc)
	_, _, err := a.Open(strings.Repeat("ab", 32))
	if !errors.Is(err, ErrAssetNotFound) {
		t.Fatalf("err = %v, want ErrAssetNotFound", err)
	}
}

// A hash is 64 lowercase hex characters and the file name is built from it, so
// anything else must be refused BEFORE it reaches filepath.Join -- otherwise
// "../meta.json" reads a file the asset route has no business serving.
func TestAssetOpenRefusesAnythingThatIsNotAHash(t *testing.T) {
	ws := t.TempDir()
	a := NewAssets(ws, testDoc)
	// A real file just outside the assets directory, to prove traversal fails
	// on the validation and not merely on the file being absent.
	if err := os.MkdirAll(filepath.Join(ws, testDoc+bundleSuffix), 0o755); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(ws, testDoc+bundleSuffix, "meta.json")
	if err := os.WriteFile(secret, []byte(`{"id":"secret"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, bad := range []string{
		"",
		"../meta.json",
		"..\\meta.json",
		strings.Repeat("AB", 32), // uppercase hex is a DIFFERENT name on a case-sensitive fs
		strings.Repeat("ab", 31), // too short
		strings.Repeat("ab", 33), // too long
		strings.Repeat("zz", 32), // not hex
		strings.Repeat("ab", 32) + "/../../meta.json",
	} {
		if _, _, err := a.Open(bad); !errors.Is(err, ErrAssetHash) {
			t.Errorf("Open(%q) err = %v, want ErrAssetHash", bad, err)
		}
	}
}

// A doc id is joined into the bundle path, so the same rule applies one level up.
func TestNewAssetsRefusesAnUnsafeDocID(t *testing.T) {
	ws := t.TempDir()
	for _, bad := range []string{"", "..", "../other", "a/b", `a\b`, "a:b"} {
		a := NewAssets(ws, bad)
		if _, err := a.Put(bytes.NewReader(tinyPNG(t, color.White))); !errors.Is(err, ErrAssetDocID) {
			t.Errorf("Put with docID %q err = %v, want ErrAssetDocID", bad, err)
		}
		if _, _, err := a.Open(strings.Repeat("ab", 32)); !errors.Is(err, ErrAssetDocID) {
			t.Errorf("Open with docID %q err = %v, want ErrAssetDocID", bad, err)
		}
	}
}

// The store is a route the browser can reach; serving back whatever bytes were
// posted, with a sniffed content type, would turn it into a same-origin host
// for HTML and scripts. Only image types this editor draws are accepted.
func TestAssetPutRefusesWhatIsNotAnImage(t *testing.T) {
	a := NewAssets(t.TempDir(), testDoc)
	for name, data := range map[string][]byte{
		"empty":      {},
		"html":       []byte("<html><script>alert(1)</script></html>"),
		"plain text": []byte("this is not an image, it is a sentence"),
		"svg":        []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
		"pdf":        []byte("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"),
	} {
		if _, err := a.Put(bytes.NewReader(data)); !errors.Is(err, ErrAssetType) {
			t.Errorf("Put(%s) err = %v, want ErrAssetType", name, err)
		}
	}
}

func TestAssetPutAcceptsTheFourRasterTypes(t *testing.T) {
	a := NewAssets(t.TempDir(), testDoc)
	for want, data := range map[string][]byte{
		"image/png":  tinyPNG(t, color.Black),
		"image/jpeg": tinyJPEG(t),
		"image/gif":  tinyGIF(t),
		"image/webp": tinyWebP(),
	} {
		ref, err := a.Put(bytes.NewReader(data))
		if err != nil {
			t.Errorf("Put(%s): %v", want, err)
			continue
		}
		if ref.ContentType != want {
			t.Errorf("content type = %q, want %q", ref.ContentType, want)
		}
	}
}

// The cap lives in the store, not only in the HTTP handler: it is what keeps a
// caller from filling the disk regardless of how it got here.
func TestAssetPutRefusesAnOversizeUpload(t *testing.T) {
	ws := t.TempDir()
	a := NewAssets(ws, testDoc)
	// A valid PNG header followed by more bytes than the cap allows: the type
	// is fine, the size is not, and the two must be distinguishable.
	data := append(tinyPNG(t, color.Black), bytes.Repeat([]byte{0}, MaxAssetSize)...)

	if _, err := a.Put(bytes.NewReader(data)); !errors.Is(err, ErrAssetTooLarge) {
		t.Fatalf("err = %v, want ErrAssetTooLarge", err)
	}
	if files := assetFiles(t, ws, testDoc); len(files) != 0 {
		t.Fatalf("a refused upload left %v behind", files)
	}
}

// Every refusal and every success must leave the directory holding exactly the
// assets and nothing else: a half-written temp file would be served as an
// asset by its own name if it were ever named one, and would leak disk either
// way.
func TestAssetPutLeavesNoTemporaryFiles(t *testing.T) {
	ws := t.TempDir()
	a := NewAssets(ws, testDoc)

	ref := mustPut(t, a, tinyPNG(t, color.Black))
	if _, err := a.Put(bytes.NewReader([]byte("not an image"))); err == nil {
		t.Fatal("expected the non-image to be refused")
	}
	// A reader that fails halfway: the frame is valid, the copy is not.
	broken := io.MultiReader(bytes.NewReader(tinyPNG(t, color.White)[:8]), errReader{})
	if _, err := a.Put(broken); err == nil {
		t.Fatal("expected a failing reader to be reported")
	}

	files := assetFiles(t, ws, testDoc)
	if len(files) != 1 || files[0] != ref.Hash {
		t.Fatalf("assets dir holds %v, want exactly [%s]", files, ref.Hash)
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("disk went away") }

func TestFontFilesAreAcceptedWithTheirOwnContentType(t *testing.T) {
	for want, head := range map[string]string{
		"font/ttf":   "\x00\x01\x00\x00rest",
		"font/otf":   "OTTOrest",
		"font/woff":  "wOFFrest",
		"font/woff2": "wOF2rest",
	} {
		if got := DetectImageType([]byte(head)); got != want {
			t.Errorf("%q: got %q want %q", head[:4], got, want)
		}
	}
	// Anything else that could be served back from the same origin stays out.
	for _, head := range []string{"<!doctype html>", "<svg xmlns", "<script>", "%PDF-1.4"} {
		if got := DetectImageType([]byte(head)); got != "" {
			t.Errorf("%q must not be accepted, got %q", head, got)
		}
	}
}
