package codegen

// IR -- the intermediate representation between the document and the code
// renderers.
//
// The document (trees of Nodes with coordinates relative to the parent) is
// translated ONCE into a tree of Elements: tag, attributes, CSS properties IN
// ORDER, text and children. The two renderers (html.go: CSS in a <style>,
// react.go: Tailwind classes) read the SAME tree, so CSS and Tailwind cannot
// diverge: the only thing that changes is the syntax used to write a Prop.
//
// Properties live in a LIST rather than a map for two reasons: the emission
// order is part of the output (golden files, readable diffs) and some
// properties are read in pairs (position/left/top).

// Prop is a CSS property: name and value already in their final form ("12px",
// "#fff", "rotate(30deg)").
type Prop struct{ Name, Value string }

// Attr is a tag attribute (HTML or SVG). The name is the HTML/SVG one
// (kebab-case): the React renderer converts it to camelCase where needed.
type Attr struct{ Name, Value string }

// Trigger is the wiring of a flow transition onto an element (or onto the
// screen, if the transition has no element).
type Trigger struct {
	TransitionID string
	FlowID       string
	Label        string
	Kind         string // click | submit | auto | key | back | free text
	Guard        string
	Effect       string
	// Dest is the destination screen (nil if the destination is not among the
	// generated screens: the link stays a comment).
	Dest *Screen
}

// Element is a node of the IR tree.
type Element struct {
	Tag   string
	Attrs []Attr
	Style []Prop
	// Text is the element's text content (only for text nodes): the renderer
	// quotes/escapes it according to the target. HasText distinguishes "empty
	// text" from "no text".
	Text     string
	HasText  bool
	Children []*Element

	// Design <-> code traceability.
	NodeID   string
	NodeName string
	Meta     map[string]string

	// Triggers: transitions fired by THIS element (click). Empty for the
	// majority.
	Triggers []Trigger
	// NavTriggers: screen transitions with no element (or with several
	// transitions on the same element): the root renders them as visually hidden
	// buttons in a transparent <nav>.
	NavTriggers []Trigger
	// KeyTriggers: transitions with a "key" trigger (Label = the key).
	KeyTriggers []Trigger

	// Anim: the animations of the clips that touch this element (animation.go).
	// nil for the majority.
	Anim *ElemAnim
	// StrokePath: the <path> of a vector's stroke (the one `draw` animates),
	// distinct from the fill path.
	StrokePath bool
}

// Screen is an exported screen: a top-level frame (or a node referenced by a
// flow) with its IR tree.
type Screen struct {
	NodeID string
	// Name is the component name (PascalCase, deduplicated).
	Name string
	// Slug is the file name for the html target (kebab-case, deduplicated).
	Slug string
	// Route is the app route (meta code.route or "/" + slug).
	Route string
	// File is the path of the generated file, relative to the output root.
	File string

	Width, Height float64
	Root          *Element
}

func (e *Element) addStyle(name, value string) {
	e.Style = append(e.Style, Prop{name, value})
}

func (e *Element) addAttr(name, value string) {
	e.Attrs = append(e.Attrs, Attr{name, value})
}

// attr returns the value of an attribute ("" if missing).
func (e *Element) attr(name string) string {
	for _, a := range e.Attrs {
		if a.Name == name {
			return a.Value
		}
	}
	return ""
}

// style returns the value of a CSS property ("" if missing).
func (e *Element) style(name string) string {
	for _, p := range e.Style {
		if p.Name == name {
			return p.Value
		}
	}
	return ""
}

// walk visits the element and its descendants in pre-order.
func (e *Element) walk(fn func(*Element)) {
	fn(e)
	for _, c := range e.Children {
		c.walk(fn)
	}
}
