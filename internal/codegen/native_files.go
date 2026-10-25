package codegen

import (
	"fmt"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// nativeAssetDir is where the builder drops the document's images before the
// native renderers move them into the platform's resource layout.
const nativeAssetDir = "assets/"

// homeScreen: the start screen of the first flow that has one, otherwise the
// first screen (the same rule as the react App.tsx).
func homeScreen(d *opendesignerv1.Document, screens []*Screen, opts Options) *Screen {
	for _, f := range selectedFlows(d, opts.FlowID) {
		if s := d.GetFlows()[f].GetStartId(); s != "" {
			for _, sc := range screens {
				if sc.NodeID == s {
					return sc
				}
			}
			break
		}
	}
	return screens[0]
}

// moveNativeAssets turns the builder's `assets/<hash>.<ext>` files into the
// platform's resources: place receives the resource name (img_<hash>), the
// extension and the bytes, and returns the files to write.
func moveNativeAssets(files map[string][]byte, place func(name, ext string, data []byte) map[string][]byte) {
	var keys []string
	for p := range files {
		if strings.HasPrefix(p, nativeAssetDir) {
			keys = append(keys, p)
		}
	}
	sort.Strings(keys)
	for _, p := range keys {
		data := files[p]
		delete(files, p)
		base := strings.TrimPrefix(p, nativeAssetDir)
		for path, content := range place(nativeAssetName(base), extOf(base), data) {
			files[path] = content
		}
	}
}

func nativeReadme(d *opendesignerv1.Document, screens []*Screen, opts Options, home *Screen, reg *compRegistry, anim bool, unsup map[string]bool, kind string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", d.GetName())
	fmt.Fprintf(&b, "<!-- %s -->\n\n", generatedHeader(d, "README"))
	swift := kind == "swiftui"
	if swift {
		b.WriteString("SwiftUI sources generated from the design with `opendesigner export -target swiftui`.\n\n")
		b.WriteString("## Getting started\n\nCreate an iOS App project in Xcode (iOS 17+, SwiftUI lifecycle), delete its `App` and `ContentView` files and drag the `Sources` folder into the project. `Sources/App.swift` holds the `@main` entry point, `Sources/Router.swift` the navigation state. The previews (`#Preview`) render every screen at its design size.\n\n")
	} else {
		b.WriteString("Jetpack Compose sources generated from the design with `opendesigner export -target compose`.\n\n")
		b.WriteString("## Getting started\n\nCopy `app/src/main` into a Compose app module whose namespace is `" + composePkg + "` (it provides the generated `R`) and register `MainActivity` in the manifest. Dependencies: Compose UI 1.9+ (`Modifier.dropShadow`), Material 3 (`Text`) and `androidx.navigation:navigation-compose`.\n\n")
	}
	b.WriteString("## How the design becomes code\n\n")
	if swift {
		b.WriteString("- Each **screen** (top-level frame) is a `View` in `Sources/Screens/<Name>.swift`; the flow's start screen (`" + home.Name + "`) is the root of the `NavigationStack`.\n")
		b.WriteString("- **Auto layout** -> `VStack` / `HStack` (spacing, padding, alignment; space-between uses `Spacer`); everything else is a `ZStack(alignment: .topLeading)` with children placed by `.offset(x:y:)` at the design's coordinates. `hug` leaves the axis without a fixed `.frame`.\n")
		b.WriteString("- Fills (colour, linear and radial gradients), corner radius, strokes, shadows, blur, opacity and rotation follow **what the editor's canvas draws**; vectors are `Path` code.\n")
		b.WriteString("- **Images** are image sets in `Sources/Resources/Assets.xcassets`.\n")
	} else {
		b.WriteString("- Each **screen** (top-level frame) is a `@Composable` in `screens/<Name>.kt`; the flow's start screen (`" + home.Name + "`) is the `NavHost` start destination.\n")
		b.WriteString("- **Auto layout** -> `Column` / `Row` (`Arrangement.spacedBy`, padding, alignment; space-between -> `Arrangement.SpaceBetween`); everything else is a `Box` with children placed by `Modifier.offset` at the design's coordinates. `hug` leaves the axis without a fixed size.\n")
		b.WriteString("- Fills (colour, linear and radial gradients via `Brush`), corner radius, strokes, shadows, blur, opacity and rotation follow **what the editor's canvas draws**; vectors are drawn on a `Canvas` from their SVG path data.\n")
		b.WriteString("- **Images** are in `app/src/main/res/drawable-nodpi`.\n")
	}
	b.WriteString("- Every element has a comment with the design node's name and `data-node-id=\"<node id>\"`: the link between the design and the code.\n")
	if len(reg.order) > 0 {
		dir := "Sources/Components/<Name>.swift"
		if !swift {
			dir = "components/<Name>.kt"
		}
		b.WriteString("- A **component set** (variants) is ONE " + map[bool]string{true: "`View`", false: "`@Composable`"}[swift] + " in `" + dir + "`: its parameters are the set's axes (a string, the first option by default) and the **component properties** (boolean = show/hide, text = string, number = the target attribute, instance swap = an optional slot with the default content as fallback). An instance becomes `Name(axis: \"option\", prop: ...)`; what it leaves out is the component's default. Instances with overrides, or with animation or flow wiring inside, are expanded inline.\n")
	} else {
		b.WriteString("- Component **instances** are expanded inline.\n")
	}
	b.WriteString("- Screens have a fixed size (no responsiveness).\n\n")
	b.WriteString("## Flows\n\n")
	if swift {
		b.WriteString("The element that fires a transition is wrapped in a `Button` that calls `router.go(.screen)` (`router.back()` for back transitions). Transitions without an element become accessibility actions on the screen's root. Key and auto triggers are left as comments.\n\n")
	} else {
		b.WriteString("The element that fires a transition gets `Modifier.clickable { onNavigate(\"<Screen>\") }` (`onBack()` for back transitions). Transitions without an element become custom accessibility actions on the screen's root. Key and auto triggers are left as comments.\n\n")
	}
	var notes []string
	for k := range unsup {
		notes = append(notes, k)
	}
	sort.Strings(notes)
	if anim {
		notes = append(notes, "animation clips")
	}
	if len(notes) > 0 {
		b.WriteString("## Not exported\n\n")
		for _, n := range notes {
			b.WriteString("- " + n + "\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("## Screens\n\n| View | Route in the design | Design node |\n|---|---|---|\n")
	for _, s := range screens {
		fmt.Fprintf(&b, "| `%s` | `%s` | `%s` (%s) |\n", s.Name, s.Route, s.NodeID, strings.ReplaceAll(d.GetNodes()[s.NodeID].GetName(), "|", "\\|"))
	}
	b.WriteString("\n## Regenerating\n\n")
	flag := ""
	if opts.FlowID != "" {
		flag = " -flow " + opts.FlowID
	}
	fmt.Fprintf(&b, "```sh\nopendesigner export -doc %s -target %s%s -out . -force\n```\n\n", d.GetId(), kind, flag)
	b.WriteString("The generated files must not be edited by hand: the next export overwrites them.\n")
	return b.String()
}
