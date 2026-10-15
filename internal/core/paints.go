package core

import (
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// The size of a mesh gradient's grid.
const (
	MinMeshSide = 2
	MaxMeshSide = 8
)

// validateNodePaints: an image paint points to a well-formed asset hash and has a known scale
// mode, and a mesh paint has a grid of the right size with one color per point. Parity with web/src/store/paints.ts::arePaintsValid. The asset FILE is not checked: like
// an image node's, it may arrive after the op (and a missing one draws as a placeholder).
func validateNodePaints(fills []*opendesignerv1.Paint, strokes []*opendesignerv1.Stroke) error {
	check := func(p *opendesignerv1.Paint) error {
		if m := p.GetMesh(); m != nil {
			rows, cols := int(m.GetRows()), int(m.GetCols())
			if rows < MinMeshSide || cols < MinMeshSide || rows > MaxMeshSide || cols > MaxMeshSide {
				return fmt.Errorf("%w: mesh paint needs %d to %d rows and columns, got %dx%d", ErrPaint, MinMeshSide, MaxMeshSide, rows, cols)
			}
			if len(m.GetColors()) != rows*cols {
				return fmt.Errorf("%w: mesh paint of %dx%d needs %d colors, got %d", ErrPaint, rows, cols, rows*cols, len(m.GetColors()))
			}
			return nil
		}
		im := p.GetImage()
		if im == nil {
			return nil
		}
		if !assetHashRe.MatchString(im.GetAssetHash()) {
			return fmt.Errorf("%w: image paint needs a 64-hex asset hash", ErrPaint)
		}
		if m := im.GetMode(); m < opendesignerv1.ImageScaleMode_IMAGE_SCALE_MODE_UNSPECIFIED || m > opendesignerv1.ImageScaleMode_IMAGE_SCALE_MODE_TILE {
			return fmt.Errorf("%w: unknown image scale mode %v", ErrPaint, m)
		}
		return nil
	}
	for _, f := range fills {
		if err := check(f); err != nil {
			return err
		}
	}
	for _, s := range strokes {
		if err := check(s.GetPaint()); err != nil {
			return err
		}
	}
	return nil
}
