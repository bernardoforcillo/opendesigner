package codegen_test

import (
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	"os"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// TestBlendAndEffectsInTheExport: blend mode, inner shadow, background blur and a
// second drop shadow come out as CSS.
func TestBlendAndEffectsInTheExport(t *testing.T) {
	doc := screenDoc(func(b *B, s string) {
		b.Add("card", s, "Card", 20, 20, 100, 100, Fill(Solid(C(1, 0, 0))))
	})
	black := &opendesignerv1.Color{A: 0.5}
	apply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "card",
		Patch: &opendesignerv1.Node{
			BlendMode: opendesignerv1.BlendMode_BLEND_MODE_MULTIPLY,
			Effects: []*opendesignerv1.Effect{
				{Kind: &opendesignerv1.Effect_DropShadow{DropShadow: &opendesignerv1.DropShadow{Color: black, OffsetX: 1, OffsetY: 2, Blur: 3}}},
				{Kind: &opendesignerv1.Effect_DropShadow{DropShadow: &opendesignerv1.DropShadow{Color: black, OffsetX: 4, OffsetY: 5, Blur: 6}}},
				{Kind: &opendesignerv1.Effect_InnerShadow{InnerShadow: &opendesignerv1.InnerShadow{Color: black, OffsetY: 7, Blur: 8}}},
				{Kind: &opendesignerv1.Effect_BackgroundBlur{BackgroundBlur: &opendesignerv1.BackgroundBlur{Radius: 9}}},
			},
		},
		Mask: &fieldmaskpb.FieldMask{Paths: []string{"blend_mode", "effects"}},
	}}})
	html := screenHTML(t, doc)
	for _, want := range []string{
		"mix-blend-mode: multiply;",
		"box-shadow: 1px 2px 3px rgba(0,0,0,0.5),4px 5px 6px rgba(0,0,0,0.5),inset 0 7px 8px rgba(0,0,0,0.5);",
		"backdrop-filter: blur(9px);",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %q in:\n%s", want, html)
		}
	}
}

// TestImageFillsInTheExport: an image paint is a background-image sized by its mode, with the
// asset copied; a missing asset keeps the flat grey.
func TestImageFillsInTheExport(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\nxyz")
	hash := strings.Repeat("c", 64)
	src := codegen.FuncAssets(func(h string) ([]byte, error) {
		if h == hash {
			return png, nil
		}
		return nil, os.ErrNotExist
	})
	for mode, want := range map[opendesignerv1.ImageScaleMode]string{
		opendesignerv1.ImageScaleMode_IMAGE_SCALE_MODE_UNSPECIFIED: "background-size: cover;",
		opendesignerv1.ImageScaleMode_IMAGE_SCALE_MODE_FIT:         "background-size: contain;",
		opendesignerv1.ImageScaleMode_IMAGE_SCALE_MODE_TILE:        "background-repeat: repeat;",
	} {
		doc := screenDoc(func(b *B, s string) { b.Add("card", s, "Card", 20, 20, 100, 100) })
		doc.Nodes["card"].Fills = []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Image{Image: &opendesignerv1.ImagePaint{AssetHash: hash, Mode: mode}}}}
		out := gen(t, doc, codegen.TargetHTML, src)
		html := string(file(t, out, "screen.html"))
		if !strings.Contains(html, "background-image: url(assets/"+hash+".png);") || !strings.Contains(html, want) {
			t.Errorf("mode %v:\n%s", mode, html)
		}
		if got := file(t, out, "assets/"+hash+".png"); string(got) != string(png) {
			t.Errorf("mode %v: asset not copied", mode)
		}
	}
	doc := screenDoc(func(b *B, s string) { b.Add("card", s, "Card", 20, 20, 100, 100) })
	doc.Nodes["card"].Fills = []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Image{Image: &opendesignerv1.ImagePaint{AssetHash: strings.Repeat("d", 64)}}}}
	html := string(file(t, gen(t, doc, codegen.TargetHTML, src), "screen.html"))
	if strings.Contains(html, "background-image") || !strings.Contains(html, "background-color: #ccc;") {
		t.Errorf("missing asset must keep the flat grey:\n%s", html)
	}
}
