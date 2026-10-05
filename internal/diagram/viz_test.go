package diagram

import (
	"fmt"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"os"
	"strings"
	"testing"
)

// Development aid: DIAGRAM_VIZ=dir go test -run TestViz writes an SVG for each
// example, to look at in a browser. Without the variable it does nothing.
func TestViz(t *testing.T) {
	dir := os.Getenv("DIAGRAM_VIZ")
	if dir == "" {
		t.Skip()
	}
	for name, src := range map[string]string{"flow": flowSrc, "class": classSrc, "seq": seqSrc, "state": stateSrc} {
		res, err := Render(src)
		if err != nil {
			t.Fatal(err)
		}
		var b strings.Builder
		fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="%.0f" height="%.0f" style="background:#fff">`, res.Width, res.Height)
		for _, n := range res.Nodes[1:] {
			b.WriteString(nodeSVG(n))
		}
		b.WriteString("</svg>")
		if err := os.WriteFile(dir+"/"+name+".svg", []byte(b.String()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func paintCol(p []*opendesignerv1.Paint) string {
	if len(p) == 0 {
		return "none"
	}
	c := p[0].GetSolid().GetColor()
	return fmt.Sprintf("rgb(%.0f,%.0f,%.0f)", c.R*255, c.G*255, c.B*255)
}

func nodeSVG(n *opendesignerv1.Node) string {
	sw, sc := 0.0, "none"
	if len(n.Strokes) > 0 {
		sw = n.Strokes[0].Weight
		sc = paintCol([]*opendesignerv1.Paint{n.Strokes[0].Paint})
	}
	switch {
	case n.GetRect() != nil:
		return fmt.Sprintf(`<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="%s" stroke="%s" stroke-width="%.1f"/>`, n.X, n.Y, n.Width, n.Height, n.GetRect().CornerRadius, paintCol(n.Fills), sc, sw)
	case n.GetEllipse() != nil:
		return fmt.Sprintf(`<ellipse cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f" fill="%s" stroke="%s" stroke-width="%.1f"/>`, n.X+n.Width/2, n.Y+n.Height/2, n.Width/2, n.Height/2, paintCol(n.Fills), sc, sw)
	case n.GetVector() != nil:
		var d strings.Builder
		for _, sp := range n.GetVector().Subpaths {
			for i, a := range sp.Anchors {
				c := "L"
				if i == 0 {
					c = "M"
				}
				fmt.Fprintf(&d, "%s%.1f %.1f ", c, n.X+a.X, n.Y+a.Y)
			}
			if sp.Closed {
				d.WriteString("Z ")
			}
		}
		return fmt.Sprintf(`<path d="%s" fill="%s" stroke="%s" stroke-width="%.1f" stroke-linejoin="round"/>`, d.String(), paintCol(n.Fills), sc, sw)
	case n.GetText() != nil:
		t := n.GetText()
		anchor, px := "middle", n.X+n.Width/2
		if t.Style.Align == opendesignerv1.TextAlign_TEXT_ALIGN_LEFT {
			anchor, px = "start", n.X
		}
		var b strings.Builder
		for i, l := range strings.Split(t.Content, "\n") {
			fmt.Fprintf(&b, `<text x="%.1f" y="%.1f" text-anchor="%s" font-family="Inter,sans-serif" font-size="%.0f" font-weight="%s" fill="%s">%s</text>`, px, n.Y+(float64(i)+0.8)*t.Style.FontSize*1.2, anchor, t.Style.FontSize, t.Style.FontWeight, paintCol(n.Fills), strings.NewReplacer("&", "&amp;", "<", "&lt;").Replace(l))
		}
		return b.String()
	}
	return ""
}
