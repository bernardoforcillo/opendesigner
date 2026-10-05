# Exporting the design as code

Closes the **design -> working app** loop: from the document (scene graph + flows)
to a project that opens in the browser, with the flow transitions wired and the
e2e tests already written. A single implementation, in Go (`internal/codegen`),
used by the CLI, the RPC and the MCP tool.

```
Document ──> screens ──> IR (tree of elements + CSS properties) ──┬─> html   (CSS in a <style>)
                                                                  └─> react  (Tailwind v4 classes)
```

The IR is unique: CSS and Tailwind come out of the **same tree**, so they cannot
diverge (the parity script checks this too, see below). The output is
deterministic: same document, same bytes (golden files, PR diffs).

## What is generated

### `react` target (default)

Vite + React 19 + TypeScript + Tailwind v4 (`@tailwindcss/vite`) +
react-router-dom project:

| File | Content |
|---|---|
| `src/screens/<Name>.tsx` | one screen = one component, Tailwind classes |
| `src/App.tsx` | the routes (`BrowserRouter`); the flow's start screen is also mounted on `/` |
| `src/main.tsx`, `src/index.css`, `index.html` | skeleton; `index.css` = `@import "tailwindcss"` + Inter font import |
| `package.json`, `vite.config.ts`, `tsconfig.json` | `dev` / `build` / `test` scripts, dependencies at the current majors |
| `playwright.config.ts` | `webServer` = Vite dev server; `PW_CHROMIUM_PATH` (optional) for an already installed Chromium |
| `tests/flows.spec.ts` | the tests from `opendesigner flow tests`, for every flow |
| `public/assets/<hash>.<ext>` | the document's images |
| `README.md` | how to start it, how the design becomes code, how to regenerate |

Every file has at the top a comment "Exported by opendesigner ... regenerate
with `opendesigner export`" and every element carries `data-node-id="<node id>"`:
the design <-> code link, at almost no cost.

### `html` target

A **self-contained** `.html` file per screen (`<slug>.html`): CSS with one
class per element (`.button-3`) in a `<style>`, navigation between screens
with `<a href>`. The flow's start screen is `index.html`; without a flow,
`index.html` is the list of screens. Images are in `assets/`.

## What a screen is

A **top-level frame** of a page (component masters, which are frames too,
are not) plus any top-level node that a flow references. Component name =
`meta["code.component"]`, otherwise the node's name in PascalCase (`Empty cart`
-> `EmptyCart`, accents removed, duplicates numbered). Route =
`meta["code.route"]`, otherwise `/` + the name's slug.
Screens have a **fixed size** and sit at the top left.

## Mapping rules

The semantics are those of the **editor's canvas** (`web/src/renderer/canvasRenderer.ts`),
not the "typical" ones of a design editor: the exported code must look like the
canvas, not like what you would expect.

| Design | Code |
|---|---|
| Frame with **auto layout** | `display:flex`, `flex-direction`, `gap`, `padding`, `justify-content` / `align-items` from main/cross alignment (also `space-between`); **hug** -> `fit-content`, otherwise fixed size. Children are in flow (`relative shrink-0`): the core has already written x/y, here CSS is told to redo the same arrangement |
| Everything else | positioned container, `absolute` children at `left`/`top` = x/y (relative to the parent, as in the model) |
| Group | positioned wrapper **without paint** |
| `clipsContent` | `overflow: hidden` |
| Rotation | `transform: rotate(Ndeg)`, origin at the centre (same clockwise convention as the canvas) |
| Rectangle | `border-radius` clamped to half the shorter side |
| Ellipse | `border-radius: 50%` |
| Fill | **only the first**: colour, `linear-gradient` / `radial-gradient` with the right geometry (see below). A shape without a fill is grey `#ccc`; a frame without a fill is transparent |
| Stroke | `box-shadow` rings: inside = `inset 0 0 0 Wpx`, outside = `0 0 0 Wpx`, center = the two W/2 ones. Several strokes stack in the canvas order |
| Shadow | the **first**: `box-shadow` (the canvas blur is the CSS blur-radius); `drop-shadow()` if the fill or the node is translucent, and for images and vectors; `text-shadow` for text |
| Blur | the **first**: `filter: blur(Rpx)` |
| Opacity | per node and **not inherited by children** (like the canvas): on leaves `opacity`, on frames with children and on nodes with a shadow the alpha is multiplied into the node's colours |
| Text | `div` with `font-family` (the document's family + generic fallback; default `Inter, sans-serif`), `font-size` (16), `font-weight` (400), `line-height` (multiplier, 1.2), `text-align`, colour, `white-space: pre-wrap`, fixed width. Gradient -> `background-clip: text`; stroke -> `-webkit-text-stroke` |
| Image | `<img>` with `object-fit: fill` (the canvas stretches it onto the box) pointing to the copied asset; if missing, the canvas **placeholder** (faint box, border, cross) |
| Vector | inline `<svg>`: path with cubics (the `in`/`out` handles are offsets relative to the anchor; without handles `L`), even-odd fill of closed outlines and a 1.5px round stroke, like the canvas |
| Instance | **inline** expansion of the master's subtree, with the overrides (fills / text per master node) |
| Hidden node | skipped (with the whole subtree) |

**Gradients.** The model gives them in normalised box coordinates; the canvas
colours according to the projection onto the P1->P2 axis. The generator derives
the CSS angle from the axis direction and rewrites the stop positions as
percentages of the CSS length (`|w sin| + |h cos|`), shifted by how far P1 is
from the centre: on a non-square box the "(0,0)->(1,1)" diagonal is not
`to bottom right`. The canvas interpolates **non-premultiplied** colours
(yellow -> transparent pink goes through pinkish yellows), CSS premultiplied:
where two stops have different alphas the segment is split into 8 points
already interpolated the canvas way.

## Flow wiring

For every transition of the chosen flows:

- the **element** (`elementId`) is the trigger: `onClick={() => navigate("<route>")}`,
  `role="button"`, `tabIndex={0}`, `aria-label` = the transition's label,
  `cursor-pointer` class, and `data-testid` from `meta["test.id"]` (in the html
  target the element becomes an `<a href>`);
- a transition **without an element** (or a second one on the same element)
  becomes a `<button>` in a visually hidden `<nav>` (1px transparent at the top
  left, in the accessibility tree with the label's name);
- `key` trigger -> `keydown` listener (the label is the key); `back` ->
  `navigate(-1)`; `auto` -> just a comment;
- `// flow: <id>`, `// guard: ...`, `// effect: ...` comments next to the trigger.

This way the locators of the generated tests (`getByTestId`, `getByText`,
`getByRole('button', { name })`) find the elements in the real DOM. Flow screens
without `code.route` get the default route **before** the tests are generated
(on a copy of the document: yours does not change), so no test is
`fixme` because of a missing route.

> The hidden `<nav>` does **not** use Tailwind's `sr-only`: that utility clips
> the element (`clip`) and Playwright, which checks who receives the pointer
> before clicking, gives it to the screen's root ("intercepts pointer events").

## Animations

The document's **clips** (`Document.clips`, see [animation.md](animation.md))
become animations in the exported code. A clip's **target** is the element
that carries the trigger; the animated elements are the target itself and its
descendants (a track outside the target is ignored with a warning). Tracks
on nodes inside a component instance are not animated.

Values in code space (the design is absolute, the code is **relative**
to the position that CSS/Tailwind have already written):

| Property | react (Motion) | html (CSS) |
|---|---|---|
| `opacity` | `opacity` (absolute) | `opacity` |
| `x`, `y` | `x`, `y` = **delta** from `node.x`/`node.y` | `--od-x`/`--od-y` (registered with `@property`) read by `translate` |
| `scale` | `scale` | `scale` property |
| `rotation` | `rotate` = **delta** in degrees from `node.rotation` | `rotate` property (composes with the base `transform: rotate()`) |
| `draw` | `pathLength` of the stroke's `motion.path` | `pathLength="1"` + `stroke-dasharray: <v> 1` |

### `react`: Motion

`package.json` adds `"motion": "^14.0.0"` **only** if the document has clips
(an export without clips is identical to before). Every element with tracks
becomes `motion.div` (or `motion.img`; a vector with `draw` has a `motion.path`
inside the `<svg>`) and receives a `<name>Variants: Variants` constant with one
variant per trigger, which **merges** the clips that touch it (one constant per
element and not per clip: an element touched by several clips still has a single
`variants`; the comment above each constant names the clips). The **target**
carries the labels:

| Trigger | On the target | Variant |
|---|---|---|
| `enter` | `initial="initial" animate="animate"` | `initial` (first keyframe) + `animate` |
| `loop` | like `enter` | `animate` with `repeat: Infinity`, `repeatType: "reverse"` if yoyo, otherwise `"loop"` |
| `hover` | `whileHover="hover"` | `hover` |
| `tap` | `whileTap="tap"` | `tap` |
| `manual` | none (a comment) | variant named after the clip (`animate="<name>"` or `useAnimate`) |

The labels propagate to descendants with `variants` (it is Motion's mechanism),
so hovering the target animates the children. For each property: keyframes
as an array, `times` (0..1 of the clip's duration), `ease` per segment (a string
if the same everywhere, an array otherwise), `duration`/`delay` in seconds, `repeat`.
If the first keyframe is not at 0 (or the last is not at the end) a "hold"
endpoint is added. `spring` comes out as `cubic-bezier(0.32,0.66,0.1,1)`, the
Bézier that best approximates the engine's critically damped spring
(`web/src/animation/engine.ts`, maximum deviation 0.04): Motion has no
per-segment springs.

### `html`: CSS, no dependencies

For each track a `@keyframes` (percentages of the clip's duration, the segment's
easing in `animation-timing-function` in the keyframe that opens it; keyframes
at the same time are spaced 0.0001% apart so they do not merge) and an
`animation:` entry with fill-mode `both`, `alternate` if yoyo, `infinite` or `repeat+1`.

- `enter`/`loop`: `animation:` on the element.
- `hover`/`tap`: `.target:hover .element { animation }` and `:active`; the rule
  **repeats** the base animations (and, for `:active`, the hover ones): changing
  the `animation` list restarts those that are no longer there.
- `manual`: `.target.<variant> .element`: it starts by adding the class
  `<variant>` to the target (`el.classList.add("highlight")`).

### Limits of the animated export

- Browsers: `translate`/`rotate`/`scale` as properties and `@property` (Chrome 104+,
  Safari 16.4+, Firefox 128+). They are not needed in the react target.
- `opacity` on a frame **also fades the children** (CSS semantics); the canvas's
  static opacity is not inherited.
- Leaving hover/tap **snaps back** to the base state in the html target
  (in react Motion animates the return).
- `draw` only on vectors (on rect/ellipse/frame, drawn as boxes, it is
  ignored with a warning). With a round-capped stroke, at `draw = 0` a
  dot remains (the same in Motion).
- No morph, no stagger, no scroll trigger (see animation.md).

## Usage

### CLI

```sh
opendesigner export [-workspace DIR] [-doc ID|NAME | -json FILE] [-assets DIR]
                    [-target react|html] [-out DIR] [-flow ID] [-force]
```

- loads the document **offline** from the workspace (like `opendesigner flow`),
  or a protojson `Document` with `-json` (and `-assets DIR` with files
  named after the hash);
- prints the list of files written; warnings (missing assets...) go to stderr;
- refuses a non-empty destination directory, unless `-force`.

### RPC

```proto
rpc ExportCode(ExportCodeRequest{doc_id, target, flow_id}) returns (ExportCodeResponse{files{path, content}, warnings})
```

Computed by the server on the current snapshot and with the workspace's assets.
Unknown `target` or `flow_id`: `InvalidArgument`. It is what the editor will call
to offer "Export code".

### MCP

`export_code { outDir, target?, flowId?, force? }`: calls the RPC and writes the files
into `outDir`; the tool description explains to the agent how the design maps
to code and which meta to write (`code.route`, `code.component`, `test.id`,
`test.text`) to get tests that find the elements.

## From the design to the tested app

```sh
# 1. draw the screens (frames) and the flow in the editor; write test.id / test.text
#    on the trigger elements and code.route on the screens (set_node_meta, or by hand)
opendesigner flow check -doc Shop                    # does the graph have problems?

# 2. export
opendesigner export -doc Shop -target react -out ./app

# 3. start
cd app && npm install && npm run dev                 # http://localhost:5173

# 4. the e2e tests generated from the flows
npx playwright install chromium                      # first time only
npx playwright test

# 5. how much of the design is built and tested?
cd .. && opendesigner flow coverage -doc Shop -repo ./app
```

`flow coverage` finds the exported screens (the node's route, `code.route`,
appears in the code) and the tested transitions (the generated tests annotate
them with `// flow:<id>`): write `code.route` in the meta of the document's
screens, not only in the code. The exported files' headers do not carry the
generated-file marker of `opendesigner flow tests`, precisely because the
exported screens **are** the implementation.

The exported code is a **starting point**: regeneration does not merge and
overwrites the files. To evolve the app by hand, export once and work on the
code from then on (the `data-node-id` and `// flow:` stay as the trace back to
the design).

## Verification

Three levels, all repeatable.

**1. Go tests** (`go test ./internal/codegen/`): golden files (`testdata/`,
`-update` to rewrite them) for auto layout, absolute positioning, rotation,
gradients, strokes, shadows and blurs, text, ellipse, present and
missing images, vectors, instances with overrides, hidden nodes, clipping and
flow wiring; `tailwind_test.go` table for the property -> class mapping; tests
on determinism, names, assets, errors.

**2. Pixel parity** (`pnpm export-parity`, in `web/`): exports the gallery
(`scripts/gen-export-samples`, ten screens covering everything above),
renders it in Chromium at DPR 1 and compares it with what the **editor's
canvas** (`drawScene`) draws on the same screen. Then it repeats the comparison
between the `html` target and the compiled React project (Tailwind), which must
give the same pixels. It saves editor / export / difference in `web/export-parity-out/`.

Results (mean difference 0..255 and maximum over the pixels **outside the text**,
percentage of pixels with a difference > 32):

| Screen | mean | max | % > 32 |
|---|---|---|---|
| Shapes | 0.12 | 20 | 0 |
| Strokes | 0.27 | 124 | 0.12 |
| Gradients | 0.17 | 3 | 0 |
| Effects | 0.12 | 12 | 0 |
| Containers | 0.14 | 5 | 0 |
| AutoLayout | 0.09 | 20 | 0 |
| Vectors | 0.17 | 92 | 0.002 |
| Images | 0.01 | 22 | 0 |
| Instances | 0.17 | 44 | 0.02 |

Thresholds: outside the text at most 0.5% of pixels with a difference > 32 and a
mean < 0.5. The residual differences are the anti-aliasing of curved or rotated
edges (Skia does not do the same in canvas and in CSS), not geometry. Html versus
React: difference **0** on all screens.

**Text is measured separately and with a wider threshold** (mean < 16/255
inside the text rectangles, which are excluded from the strict comparison; measured:
11.0 on the Text screen, 5.5 on Instances). Canvas and DOM do not do the same
anti-aliasing nor the same baseline: the canvas puts it at 0.8em from the top
edge of the line, CSS uses the font's real ascent (about 1px lower at
16px with Inter). It is a difference by construction, not a defect to fix.

**4. Animations** (`pnpm export-anim-app`, in `web/`): exports `samples.AnimDemo`
(one clip per trigger) in the two targets, builds the react app (`npm install`,
`tsc` + `vite build`) and runs in Chromium a Playwright test that samples
opacity, transform and stroke **over time** and under hover/tap, for react+Motion and
for html+CSS.

**3. Real app** (`pnpm export-app`, in `web/`): exports the example flow
Login -> Home -> Detail, `npm install`, `tsc` + `vite build`, and runs the
generated Playwright tests against the app in Chromium: they pass. It needs the network.

## Known limits

- **Text**: metrics and wrapping are the browser's, not the canvas's
  (see above). The Inter font is imported from Google Fonts; other families must
  be made available by the app. The text stroke is only one (the first) and always
  centred; a stroke with a gradient falls back to the first colour (this holds for all
  strokes: a `box-shadow` ring cannot be shaded).
- **Shadows**: the shadow follows the fill (a frame without a fill has none:
  the canvas would cast it from the stroke alone, `box-shadow` cannot do that). On a
  translucent container it is a `box-shadow`, which CSS does not paint inside the box.
  On vectors the canvas shades fill and stroke separately (a slightly darker
  shadow on the edge); here it is a single `drop-shadow`.
- **Layer blur** on a container: in CSS it also blurs the children, in the
  canvas it does not.
- **Vectors**: like the canvas, the model's `strokes` are not drawn; the
  outline is always the 1.5px stroke in the fill's colour.
- **Instances**: expanded inline, no extraction into React components. The master's
  `test.id`s are not carried into the instances (they would be duplicated).
- **No constraints/responsive**: screens have a fixed size.
- Only **top-level** nodes can be screens; a nested flow node
  is omitted (with a warning).
- **Images** are copied only if the asset is reachable (the server's workspace,
  or `-assets` with `-json`); otherwise placeholder and warning.
- Flows with free-text triggers (hover, long press) cannot be simulated
  by the generated tests: they stay `fixme`, as for `opendesigner flow tests`.
