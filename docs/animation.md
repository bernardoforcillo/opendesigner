# Animation

The document has **animation clips**: sets of tracks (node, property) with
keyframes, attached to a "target" node (a screen, a group, an imported SVG)
whose `enter` / `hover` / `tap` starts them. Like flows, clips are in the
document and go through the op log: they are read and written from the editor,
MCP and code, and survive a reload. This document describes the **data
model**, the **engine** that samples it, the **MCP tools**, **code
generation** and the **editor** (timeline, recording, playback on the canvas and in the
prototype, at the end); the SVG importer uses the model but lives elsewhere.

## Model

```
Document.clips : map<id, Clip>

Clip     { id, name, duration (ms), trigger, delay (ms), repeat, yoyo,
           tracks[], target_id }
Track    { node_id, prop, keyframes[] }          // one per (node, property)
Keyframe { time (ms, 0..duration), value, easing }
```

Two ops, **absolute upserts** as for flows (the incoming value is the final
value, so the inverse of an op is the previous state):

| Op | Number | Effect |
|---|---|---|
| `SetClip { clip }` | 25 | creates the clip or **replaces it entirely** |
| `DeleteClip { id }` | 26 | deletes it (nonexistent id = rejection) |

The model lives in `proto/opendesigner/v1/opendesigner.proto` (`Keyframe`,
`Track`, `Clip`, `Document.clips = 9`), the authority in `internal/core/animation.go`
and the TypeScript mirror in `web/src/store/applyOp.ts` + `web/src/animation/`.

### Properties

| `prop` | Semantics | Values |
|---|---|---|
| `opacity` | absolute opacity | 0..1 |
| `x`, `y` | **absolute local** coordinates of the node (like `Node.x/y`) | finite |
| `scale` | multiplier, base 1, around the centre | finite |
| `rotation` | **absolute** degrees (like `Node.rotation`) | finite |
| `draw` | how much of the path is drawn | 0..1; only on `vector`, `rect`, `ellipse`, `frame` |

Before the first keyframe the first value holds, after the last the last value
holds (hold). A track with a single keyframe is a constant.

### Trigger

`enter` (when the screen appears), `hover`, `tap`, `loop` (like `enter` but
endless), `manual` (started by code). An empty trigger means `manual`.
`delay` (ms) delays the start; `repeat` is the number of **extra** repetitions
(`-1` = infinite); `yoyo` makes odd repetitions run backwards.

### Easing

A keyframe's easing is the curve of the **segment that starts at it**:

```
easing := "" | "linear" | "easeIn" | "easeOut" | "easeInOut" | "spring"
        | "cubic-bezier(a,b,c,d)"
```

`""` = `linear`. `easeIn`/`easeOut`/`easeInOut` are the CSS curves
(`cubic-bezier(0.42,0,1,1)`, `(0,0,0.58,1)`, `(0.42,0,0.58,1)`). `spring` is a
critically damped spring (`1 - (1 + wt)e^(-wt)`, ω = 9.2, rescaled so that it
starts at 0, reaches 1 and stays monotonic: no bounce). In `cubic-bezier` the
four numbers are decimals (no `inf`, `nan`, hexadecimals), spaces allowed
around the numbers; the **abscissae** `a` and `c` are in [0,1] as in CSS (the
ordinates may go outside: overshoot).

### Validation (`SetClip`)

Rejected (`Err*` sentinels in Go, scene unchanged in TS) if: empty id; duration
not finite or ≤ 0; negative or non-finite `delay`; `repeat < -1`; unknown trigger;
nonexistent target; for each track nonexistent node, property outside the
table, no keyframes, times non-finite / decreasing / outside
`[0, duration]`, non-finite values (`opacity` and `draw` outside [0,1]), easing
outside the grammar; two tracks with the same (node, property) pair in the
same clip; `draw` on a node without a path (text, image, group,
instance). Keyframes at the **same time** are allowed: they are a jump.

### Cascade

Deleting a node (and its subtree) or a page:

- removes the **tracks** on the vanished nodes from the clips;
- deletes the clips whose **target** vanished;
- a clip left **without tracks but with a live target is kept** (it is empty, not
  orphaned).

The op stays one (`deleteNode`/`deletePage`); the **inverse** (undo, client side in
`web/src/store/history.ts`) recreates the nodes and **then** restores with `setClip` the clips
as they were. Go replaces the touched clips with copies (never in place: the server's
copy-on-write clone, `cowClone`, shares them with the previous
generation) and TS does the same with new objects.

## Engine (`web/src/animation/engine.ts`)

**Pure** functions, with no DOM or renderer (used by the editor's playback and the prototype):

| Function | What it does |
|---|---|
| `easingFn(spec)` | a segment's curve; cubic-bezier with a real solver (Newton + bisection); an invalid spec falls back to `linear` |
| `sampleTrack(track, t)` | value at `t` ms: hold before/after, easing of the keyframe that opens the segment, jumps for equal times |
| `sampleClip(clip, t)` | `Map<nodeId, {opacity?, x?, y?, scale?, rotation?, draw?}>` |
| `clipTimeline(clip, elapsed)` | real time -> `{t, done}`: delay, repetitions, yoyo, infinite repetition |

`isValidClip` (`web/src/animation/validate.ts`) is Go's validation, for
`applyOp` and for undo.

## MCP tools

Descriptions designed for an agent (they repeat the model in brief):

| Tool | Use |
|---|---|
| `list_clips` | the clips with target, trigger, duration, number of tracks |
| `get_clip` | one clip with all tracks and keyframes (with node names) |
| `create_clip` | a whole clip with its tracks, in one call |
| `set_clip` | **replaces** a clip: read it with `get_clip`, modify it, send it back |
| `delete_clip` | deletes a clip |
| `animate_node` | convenience: one property of a node from one value to another (`from` default = current value; `draw` default 0 -> 1; `easing` default `easeOut`; `duration` default 600; `trigger` default `enter`; `delay` staggers the track). It finds or creates the clip on the **nearest frame/group** that contains the node (the node itself if it sits on the page) with the same trigger, adds or replaces the track and lengthens the duration |

`get_document` includes `clips`. Errors are validated with the core before
sending the op and say what to fix (allowed properties, valid easings, ...).

## Generated code

`opendesigner export` (and `export_code`) translates the clips: `react` into **Motion**
(`motion/react`, `initial` / `animate` / `hover` / `tap` variants on the target),
`html` into **CSS `@keyframes`** with no dependencies. The full mapping, the
treatment of deltas (`x`, `y`, `rotation` are relative to the position and rotation
already written) and the limits are in [codegen.md](codegen.md#animations).
In brief:

| Trigger | react | html |
|---|---|---|
| `enter` | `animate` on mount | `animation:` on the element |
| `loop` | `repeat: Infinity` (`repeatType` `reverse` if yoyo) | `animation-iteration-count: infinite` (`alternate` if yoyo) |
| `hover` | `whileHover="hover"` | `.target:hover .element` |
| `tap` | `whileTap="tap"` | `.target:active .element` |
| `manual` | variant named after the clip | class named after the clip on the target |

Real verification: `pnpm export-anim-app` (in `web/`) exports a screen with one
clip per trigger in the two targets, builds the react app with `tsc` + `vite build` and
runs in Chromium a test that samples opacity, transform and stroke over time.

## Editor: timeline, recording, playback

A **Timeline** panel below the canvas, in Design mode (it is not a fourth
mode): it opens with **M** or from the dock's "Animation" entry, and on its own when
a clip is opened (from the list, by creating it or with a preset). It is resized from the
top edge and collapses to just the header. Closed it costs nothing: it is not
mounted, does not sample, does not listen.

- **Clips**: the left column lists them (filter "of the selection": those whose
  target is an ancestor of the selected nodes or that have a track on
  them); new, duplicate, delete. The settings (name, trigger, duration,
  delay, repetitions or infinite, yoyo, target = frame/group nearest the
  selection) are in the transport bar's popover. Every change is **a single
  `SetClip` with the whole clip in one gesture: one undo step**.
- **Tracks**: "+ Property" (opacity, X, Y, scale, rotation, path for nodes
  with a path) on the selected layer; with no clip open it creates one. Two
  keyframes, start and end, with the base value. "Animate with a preset" creates a ready
  clip (Fade in, Slide up, Pop, Spin, Pulse, Draw: `animation/presets.ts`, values
  relative to the node).
- **Keyframes**: diamonds that can be selected (Ctrl/Cmd for more than one), dragged
  (snapping to the 10 ms grid, to the other keyframes and to the playhead; **Shift**
  for free dragging), deleted (Del), duplicated at the playhead
  (Ctrl/Cmd+D), moved with the arrows. Dragging works on a draft
  in the view store and writes **a single op on release**. Double-click on a
  row: a keyframe with the value sampled there; the inspector on the right has time,
  value, easing (menu + mini-curve with the two control points to drag).
- **Transport**: play/pause (**Space only with focus inside the timeline**: outside,
  Space stays pan), stop, loop, speed 0.25-2×, current time, draggable
  ruler, zoom (Ctrl + wheel). The preview respects `delay`, `repeat` and
  `yoyo` exactly like the prototype (`clipTimeline`); the `loop` trigger runs
  forever.
- **Record**: with the clip open and "Record" on, moving, rotating or
  changing the opacity of a layer (on the canvas or from the Properties panel) writes
  keyframes at the playhead instead of changing the layer; a new track at t > 0
  also receives the keyframe at 0 with the previous value, and rotation does not jump across
  0/360. A gesture with something else inside (resizing) or a layer outside the
  target goes through as is. Technically it is a hook (`animation/recordHook.ts`) on the
  store's two gates, `applyLocal` and `endGesture`: with recording off the
  hook is null and the two functions are the identity.

### The pose

While a clip runs, is scrubbed or recorded, the canvas shows a **derived
scene** (`animation/pose.ts`, `posedScene.ts`) and **never** the document: the same
nodes with the sampled values (x, y, rotation, opacity are real fields;
`scale` and `draw` are the transient fields `animScale`/`animPivot`/`animDraw` of
`NodeLite`, which no op carries and no snapshot contains). The cost is
proportional to the animated nodes: the provenance (`sceneDelta`) makes the scene
index update incrementally. The renderer (CPU and GPU) reads the scale from
`localTransformOf`; the stroke being drawn is a canvas 2D dash with the real
length of the path (`renderer/animDraw.ts`); the off-screen culling is
skipped for scaled nodes, their ancestors and their subtree. The
`requestAnimationFrame` loop runs **only while playing**: with the timeline stopped or
closed the editor does zero frames. While it runs, the selection handles are not
drawn and the Properties panel shows the real scene; when paused or scrubbing
they follow the pose.

The GPU renderer supports scale and everything else; only the stroke being
drawn (`draw` < 1) it cannot do and, as long as it is there, the scene is drawn on CPU without
touching the user's choice.

### Prototype

In Present (`ui/PrototypePlayer.tsx`, `animation/runtime.ts`) the `enter` and
`loop` clips whose target is in the shown screen start when it appears (also
when returning to it); `hover` and `tap` start when the pointer enters / presses in the target's
box and last as long as it does (like `:hover` / `:active` in the exported code).
A finished clip stays on its last value. Here too the frame loop runs only
while a clip is running.


## Effect tracks (EffectCraft)

The motion panel can animate [EffectCraft](https://github.com/storytold/effectcraft)'s effects (MIT OR Apache-2.0,
Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors). An effect parameter is an ordinary track whose `prop` is
`fx.<effectId>.<paramId>`, e.g. `fx.ec.blur.gaussian.blurriness`; the document model does not change (no proto field), and
Go (`core.ValidTrackProp`) and TypeScript (`engine.ts::isTrackProp`) check the same shape. A node has an effect as soon as a
track names it; parameters without a track keep their default. Values are finite and unbounded in the document; the editor
clamps them to the parameter's range.

- `web/src/animation/fx/catalog.ts`: all 307 EffectCraft effects (id, name, category), generated from its `docs/effects.md`.
- `web/src/animation/fx/library.ts` + `kernels*.ts`: all 307, drawn or played, with EffectCraft's parameter names, ranges and
  defaults where it has them. Each is one of four kinds:
  - **filter**: a CanvasKit image/colour filter over the node's pixels (blur, colour matrices, minimax, glow, offset);
  - **overlay**: an SkSL shader drawn over the node inside its layer (grain, fills, gradients, patterns, generators), or a
    mask that keeps the node where it is opaque (the wipes);
  - **kernel**: an SkSL shader that READS the node (`uniform shader src`). The renderer draws the node offscreen
    (`ckRenderer.ts::drawLayerBody`, at the screen's resolution, capped at 4096 px), passes the image in and draws the
    result; several kernels chain, each reading the previous one. This is what distortions (wave, ripple, bulge, twirl,
    polar, mirror, tiles, kaleidoscope, corner pin, transform), radial/cross/channel/lens/smart blurs, sharpen, edges,
    emboss, posterize, mosaic, scatter, colour-by-hue effects, keyers, drop shadow, bevel and light rays are;
  - **time** (`fx/timeFx.ts`): the node drawn as it is at other moments: Echo, CC Wide Time, Pixel Motion Blur, CC Force
    Motion Blur, Posterize Time, Timewarp, Time Difference, Time Displacement. The "frame history" is not stored pixels: clips are pure
    functions of time, so `pose.ts` poses the node again at `now + dt` (`TimeSource.at`, from the playhead in the editor and
    from the running clips in Present), which is exact, free to keep and the same when scrubbing or playing backwards.
    The renderer (`ckRenderer.ts::drawEchoes`) draws each pose as a weighted layer inside an isolated layer, combined with
    the effect's mode (add, screen, max, min, over, difference). Time Displacement draws 8 poses
    spread over +-max displacement offscreen and a shader (`DISPLACE_SKSL`, 9 named children) picks, per pixel, the pose the
    map selects (the node now: luminance, alpha or a channel; 0.5 is no displacement), blending neighbouring poses.
    Limits: the node's own pixels only (its children are drawn once, as now) and the first time effect on a node wins.
  - **kernel with statistics** (`fx/stats.ts`, `fx/lutImage.ts`, `kit.ts::lutKern`): Auto Levels, Auto Contrast, Auto Color and
    Equalize look at the whole node first. The renderer reads back a copy of the node (at most 256 px), counts it by channel and
    luma weighted by alpha, builds a 256 x 2 lookup table and hands it to the shader as a second child (`uniform shader lut`).
    Auto Levels stretches each channel to its own clip points, Auto Contrast uses the luma's for all of them, Auto Color adds a
    gamma per channel that pulls the mid-tones to neutral, Equalize maps through the cumulative distribution (RGB, brightness or
    Photoshop style). The read-back runs every frame the effect is on screen, and EffectCraft's temporal smoothing and scene
    detection are not implemented (each frame is analysed on its own, so a changing frame can make the levels flicker).
  - **pieces, particles and text** (`fx/kernelsSim.ts`): Shatter, Pixel Polly, Card Dance and Card Wipe cut the node into a grid
    of shards or cards; for every output pixel the pieces that could cover it (3 cells around) are inverse-transformed and
    tested. Particle World, Particle Systems II and Particle Playground run 96 closed-form particles. Numbers and Timecode draw
    a 5x7 font in SkSL, the characters formatted on the CPU. These overlays use the `srcover` blend: they draw beyond the node.
  - **second layer** (`fx/kernelsLayer.ts`): Set Matte, Set Channels, Blend, Calculations, Compound Arithmetic, Difference Matte,
    Object Matte, Match Grain, Color Stabilizer and CC Environment take another layer of the document; CC Composite takes the node
    as it was before the effects. The reference is a track of the node's clip named `fx.<effectId>.layer.<nodeId>` with one
    constant keyframe (core.ValidTrackProp / `engine.ts::isTrackProp` check its shape; naming a layer is enough to have the effect),
    so no model change is needed. The renderer draws the layer offscreen in the node's local space (`ckRenderer.ts::layerShader`):
    the layer may be hidden, keeps its own effects and animation, is not moved or turned by the node's own rotation and scale, and a
    loop (the layer names the node back) is cut. A layer that is gone, or none, makes the effect do nothing. In the editor,
    **+ Effect** lists these with a "layer" submenu of the other nodes; the track row reads "Set Matte · Layer: <name>".
  - **mask-based** (`fx/kernelsMask.ts`): the editor has no free-hand mask tool, so what After Effects draws is given in the ways the
    document does have. A *mask* is another layer (its alpha), named like any second layer; a *pin, push, mesh point, region or path
    point* is a numeric parameter, so it animates like everything else. Roto Brush & Refine Edge takes a rough matte layer and re-computes
    the alpha near its edge from the foreground and background colours the node has around it (a closed-form refine edge, with edge
    decontamination); Inner/Outer Key does the same from an inner layer (surely foreground) and an outer layer (outside it, surely
    background): a second layer reference, `fx.<effect>.layer2.<nodeId>`, listed as "inner layer" / "outer layer" in the Effect menu.
    Puppet (4 pins), Liquify (3 push, bloat, pucker or twirl dabs), Mesh Warp (4 inner lattice points) and Reshape (source region to
    destination region) are inverse-mapped warps; Write-on and CC Glue Gun follow a path given by points up to a progress you animate;
    Mocha shape is a shape mask given by parameters. They are simpler than EffectCraft's tools, which edit meshes and paths by hand.
  - **text** (`fx/kernelsText.ts`) and **string parameters** (`fx/props.ts`): Basic Text and Path Text have a real string. A keyframe
    value is a number and the document has no other place for text without a model change, so the string lives in the NAME of a
    track, like a layer reference: `fx.<effectId>.str.<paramId>.<text>`, the text as UTF-8 in unpadded base64url (at most 4000
    characters of it, about 2900 bytes of text), with one constant keyframe. It is not animated; a later track for the same
    parameter replaces an earlier one (`timelineLogic.ts::setStringParam`), and Go (`core.ValidTrackProp`) and TypeScript check the same
    shape. In the editor, **+ Effect > Basic Text** asks for the text and the font in a dialog (`ui/timeline/EffectTextDialog.tsx`), and
    the pencil on the text track edits it later. The renderer draws the text as a text node built from the effect's numeric parameters
    (`ckRenderer.ts::drawFxText`), so it uses the document's fonts, wrapping, weights and letter spacing, not a bitmap font. Path Text
    runs along a built-in circle, arc, wave or line, or along a vector layer named like any layer (**+ Effect > Path Text > on a layer**),
    using the document's own text-on-path. Limits: a glyph the document's fonts do not have (for example Chinese or Japanese) is
    drawn as a box, the same as in text nodes; the text is a static string; the text node is not clipped to the layer.
  - **carrier**: no pixels, only values for expressions (EffectCraft's Expression Controls, Grow Bounds).
- `pnpm fx-render [zoom] [ms]` (web/) draws a node per effect through the real pipeline (clip -> pose -> `CanvasKitRenderer` on WebGL in
  headless Chromium) into `web/fx-out/`: the offscreen kernels, layers, time effects and lookup-table read-back, at any zoom.
  It fails on SkSL errors. The scene is `src/bench/fxdemo.ts`.
- `fx/kit.ts` has the SkSL helpers (`kern`, `over`, noise, hsv, `ring` taps). Every shader is compiled and drawn against the real
  CanvasKit by `fx/fx.test.ts`.
- `pose.ts` writes the sampled values to the transient `NodeLite.animFx`; `ckRenderer.ts::beginEffects/endEffects` draws them.
  Order: kernels first (innermost), then the node's own effects and the animated image filters, then overlays.
- Editor: **+ Effect** in the transport adds an effect (its first parameter as a track); **+ Property** then lists the other
  parameters of the effects the node already has.
- Every effect of the catalog is now drawn or played; some are manual versions of what EffectCraft computes (below).
  Where EffectCraft's version needs data this editor does not have, the ones that are drawn work on the node's own pixels
  instead: the 3D-channel effects take the node's luminance as depth and its colours as IDs, Stroke/Vegas/Stylize follow the
  node's alpha edge, Paint Bucket fills the colours that match the one at a point. The shatter, card, particle, hair, mercury,
  foam and wave effects are 2D, stateless approximations (every piece or particle is a function of its id and the animatable
  phase), not EffectCraft's simulations. Selective Color and Lumetri cover the basic controls, OCIO Color Space covers sRGB, linear
  Rec.709, ACEScg, Rec.2020 and Display P3, and a few legacy effects reuse their modern counterpart (`ALIASES` in `fx/library.ts`).
- **Files** (Apply Color LUT, OCIO File Transform, OCIO Look Transform, PS Arbitrary Map): adding the effect opens a dialog with a
  file picker; the file is parsed in the browser (`animation/fx/files.ts`: `.cube` 1D and 3D, `.3dl`, ASC CDL `.cdl/.cc/.ccc`,
  Photoshop `.acv/.amp` curves), uploaded as an asset and its hash is kept in the effect's string track `file`. LUTs are plain
  text with no signature, so the upload is wrapped in a one-line container (`ODFX\n` + the bytes) that is the only thing the
  server accepts for them. The shader reads the table as an 8-bit data image and interpolates linearly, nearest or
  tetrahedrally; the inverse direction inverts a 1D table by search and a cube by Newton's method on the CPU (cached). Until the
  file has arrived, or if it cannot be read, the node is drawn without the effect. Limits: 8-bit tables (no HDR range),
  cubes up to 65³, no `.csp`/`.spi1d`/`.look` files and no OCIO config (looks are files, not names).
- **Tracking** (3D Camera Tracker, Warp Stabilizer, Face Track Points, Face Measurements) is done by hand: the editor has no video to
  analyse, so the track is what you keyframe, as ordinary effect parameters in % of the node's box (`animation/fx/kernelsTrack.ts`).
  Warp Stabilizer holds the node steady against the tracked point (and, with a second point, its rotation and scale): the point's
  keyframes are averaged over Smoothness ms around now (`derive` in `fx/library.ts`, run by `animation/pose.ts`, kept in
  `animFxDerived`) and the node is moved from where the point is to where its smoothed path is, with Strength and Zoom.
  3D Camera Tracker is a plane pin: four tracked corners drive a perspective (homography) warp of the node, optionally smoothed,
  with markers. Face Track Points holds 13 landmarks (eyes, brows, nose, mouth, chin, jaw, forehead) and draws them with their mesh.
  Face Measurements reads those landmarks from the layer it names, or from its own node, and draws guide lines (eye line, mouth
  width and opening, face width and height, brow raise) and five gauges (mouth opening, eye distance, brow raise, head roll,
  head turn). Limits: no automatic analysis or solve (no 3D camera or point cloud), the face measurements assume the box is
  roughly square, and the values are drawn, not exposed to other effects.
- **Paint**: adding it opens a pad where the strokes are drawn with the pointer (brush colour and size, Undo, Clear). The strokes
  are the effect's string track `strokes` in a compact text form (`animation/fx/paint.ts`: size, colour, opacity and a simplified
  polyline in fractions of the node's box), so a few seconds of drawing fit the 2900-byte parameter; the pad says when it is full.
  Write On reveals them in the order they were painted (animatable), Brush Size and Opacity scale them, and Paint on Transparent
  takes the node's own pixels away. They are drawn as round-capped smoothed polylines inside the node's layer, so the other
  effects chain over them. Limits: one brush (no hardness, erasers or clone/blend modes) and no per-stroke timing.
- **Audio**: a sound is attached to a node (**Sound** in the transport; the file is uploaded as an asset and kept in the node's
  `meta`: `audio.hash`, `audio.start` in ms, `audio.name`; the server accepts WAV, MP3, Ogg, FLAC and MP4/AAC). The 13 Audio
  effects (`fx.ec.audio.*` tracks) form a Web Audio chain per node in track order; gate and compressor run as AudioWorklets built
  from the pure functions in `animation/audio/dsp.ts`. Playback follows the timeline (play, pause, speed, playhead jumps) and
  samples the clip to update the parameters. Audio Spectrum and Audio Waveform are drawn from the decoded buffer at the node's
  animated time (give them the sound's layer with "on a layer"). Limits: scrubbing is silent, there is no audio in export or
  Present, and no spatial audio. `pnpm audio-check` measures every effect on an offline render in Chromium.
- Code export (HTML/React) and the 2D canvas renderer ignore effect tracks (the exporter warns).

## Limits (for now)

- **No morph** between shapes: numeric properties are animated, not the points of a
  path.
- **No automatic stagger**: to stagger several elements use tracks with
  different times (or `delay` in `animate_node`).
- **No scroll trigger**: only enter / hover / tap / loop / manual.
- There are six properties; no colour, shadow, size or path `d`.
- A clip's tracks must be inside its target (in the code a
  track outside is ignored with a warning); no animation inside component
  instances.
- The export does not animate `draw` on rect/ellipse/frame (CSS boxes with no path).
- In the timeline a node's animated scale does not enter the node's own selection
  box (the handles stay on the base box); `draw` on a vector
  hides the fill until the path is complete.
