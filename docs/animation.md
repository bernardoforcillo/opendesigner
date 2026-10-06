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
