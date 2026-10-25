package core

import (
	"errors"
	"fmt"
	"math"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// DOCUMENT SETTINGS and PAGE SETUP -- the Go half (the authority) of web/src/store/docSettings.ts.
//
//	1. the vertical is "", "publishing", "design" or "product" ("" is "product"); it only shapes the editor;
//	2. the baseline grid has a finite increment in 0..1000 (0 = no grid) and a finite start >= 0;
//	3. a page's size is 0 (unbounded) or 1..100000 in each direction; margins, gutter and bleed are
//	   finite and non-negative (bleed up to 1000); columns are 0..24;
//	4. the margins of a sized page leave room: left + right < width and top + bottom < height;
//	5. with more than one column the gutters leave room: (columns - 1) * gutter < the text width.

var (
	ErrBadVertical      = errors.New("core: vertical must be publishing, design or product")
	ErrBadPresentDevice = errors.New("core: present device must be generic, phone, tablet, desktop or none")
	ErrBadBaseline      = errors.New("core: baseline grid needs a finite increment between 0 and 1000 and a start >= 0")
	ErrBadPageSetup     = errors.New("core: invalid page setup (size, margins, columns or bleed)")
	ErrBadDocSettings   = errors.New("core: invalid document settings (colour mode or profile)")
	errNilDocSettings   = errors.New("core: nil document settings")
)

// ValidVertical reports whether v names a vertical ("" included).
func ValidVertical(v string) bool {
	switch v {
	case "", "publishing", "design", "product":
		return true
	}
	return false
}

// PresentDevices are the device frames the prototype player knows (web/src/flow/devices.ts::DEVICES).
var PresentDevices = []string{"generic", "phone", "tablet", "desktop", "none"}

// ValidPresentDevice reports whether d names a device frame ("" included: the default, generic).
func ValidPresentDevice(d string) bool {
	if d == "" {
		return true
	}
	for _, k := range PresentDevices {
		if k == d {
			return true
		}
	}
	return false
}

func validateDocSettings(s *opendesignerv1.DocSettings) error {
	if s == nil {
		return errNilDocSettings
	}
	if !ValidVertical(s.GetVertical()) {
		return fmt.Errorf("%w: %q", ErrBadVertical, s.GetVertical())
	}
	if !ValidPresentDevice(s.GetPresentDevice()) {
		return fmt.Errorf("%w: %q", ErrBadPresentDevice, s.GetPresentDevice())
	}
	inc, start := s.GetBaselineIncrement(), s.GetBaselineStart()
	if math.IsNaN(inc) || math.IsInf(inc, 0) || inc < 0 || inc > 1000 || math.IsNaN(start) || math.IsInf(start, 0) || start < 0 {
		return ErrBadBaseline
	}
	if err := validateColorMode(s); err != nil {
		return err
	}
	return validateBook(s.GetBook())
}

func applySetDocSettings(doc *opendesignerv1.Document, s *opendesignerv1.SetDocSettings) error {
	if err := validateDocSettings(s.GetSettings()); err != nil {
		return err
	}
	doc.Settings = proto.Clone(s.GetSettings()).(*opendesignerv1.DocSettings)
	return nil
}

// ValidateDocSettings is for callers outside the package (document creation).
func ValidateDocSettings(s *opendesignerv1.DocSettings) error { return validateDocSettings(s) }

func finiteIn(v, lo, hi float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= lo && v <= hi
}

// validatePageSetup checks invariants 3-5 for p.
func validatePageSetup(p *opendesignerv1.Page) error {
	w, h := p.GetWidth(), p.GetHeight()
	if !(w == 0 || finiteIn(w, 1, 100000)) || !(h == 0 || finiteIn(h, 1, 100000)) {
		return ErrBadPageSetup
	}
	for _, v := range []float64{p.GetMarginTop(), p.GetMarginRight(), p.GetMarginBottom(), p.GetMarginLeft(), p.GetGutter()} {
		if !finiteIn(v, 0, 100000) {
			return ErrBadPageSetup
		}
	}
	if !finiteIn(p.GetBleed(), 0, 1000) || p.GetColumns() > 24 {
		return ErrBadPageSetup
	}
	if w > 0 && p.GetMarginLeft()+p.GetMarginRight() >= w {
		return ErrBadPageSetup
	}
	if h > 0 && p.GetMarginTop()+p.GetMarginBottom() >= h {
		return ErrBadPageSetup
	}
	if w > 0 && p.GetColumns() > 1 {
		text := w - p.GetMarginLeft() - p.GetMarginRight()
		if float64(p.GetColumns()-1)*p.GetGutter() >= text {
			return ErrBadPageSetup
		}
	}
	return validatePageStructure(p)
}

// validatePageStructure checks the numbering, slug, guides and hidden master items of p.
func validatePageStructure(p *opendesignerv1.Page) error {
	switch p.GetNumberStyle() {
	case "", "i", "I", "a", "A":
	default:
		return ErrBadPageSetup
	}
	if p.GetNumberStart() > 100000 || !finiteIn(p.GetSlug(), 0, 1000) {
		return ErrBadPageSetup
	}
	if len(p.GetGuides()) > 200 || len(p.GetHiddenMasterItems()) > 1000 {
		return ErrBadPageSetup
	}
	for _, g := range p.GetGuides() {
		if !finiteIn(g.GetPosition(), -100000, 100000) {
			return ErrBadPageSetup
		}
	}
	for _, id := range p.GetHiddenMasterItems() {
		if id == "" {
			return ErrBadPageSetup
		}
	}
	return nil
}
