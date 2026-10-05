# Rendering performance

The renderer draws with Canvas 2D. This document says what it does to stay
fast on large documents, how to measure it and where the limits are.

## What it does

1. **Invalidation-driven drawing** (`ui/App.tsx`). A frame only when something
   visible changes (scene, camera, selection, previews, presence, images,
   fonts, canvas size). At rest the editor redraws nothing: before, it
   always drew 60 times per second.
2. **Scene index** (`renderer/sceneIndex.ts`). For each scene: the already
   ordered children and, for each node, the WORLD rectangle of everything it
   draws with its subtree (stroke, shadow, blur, overflowing text). It is updated
   **incrementally** from one scene to the next, comparing objects by
   identity; a test compares it with the full rebuild on random sequences
   of changes.
3. **Discarding what is not visible.** `drawScene`, `hitTest` and `nodesIntersecting`
   skip entire subtrees outside the view or smaller than 0.3 px.
4. **Levels of detail.** Below 4 px a node becomes a flat rectangle of its
   colour; a clipping frame below 12 px does not clip.
5. **Reuse of the last frame** (`renderer/layerCache.ts`). If a frame is heavy
   (> 20 ms) and only the camera changes, the last image is redrawn shifted
   and scaled, and when the movement ends (120 ms) the exact frame is redone.

## Measurements

Headless Chromium **without GPU** (CPU rasterization, so the absolute values
are pessimistic; the comparisons hold). Synthetic document: frames of 20 children
(rectangles, ellipses, texts), 1200x800.

| nodes  | frame, framed (before → now) | frame, one screen (before → now) | hit-test (before → now) |
|--------|------------------------------|----------------------------------|-------------------------|
| 1,000  | 7.6 → 8 ms                   | 6.4 → 0.8 ms                     | 0.3 → ~0 ms             |
| 5,000  | 34 → 21 ms                   | 40 → 1.3 ms                      | 1.4 → ~0 ms             |
| 20,000 | 177 → 108 ms                 | 139 → 1.5 ms                     | 7.1 → ~0 ms             |

Cost of ONE edit (new scene, index and zoomed frame): 150 ms → 27 ms at
20,000 nodes, 6 ms at 5,000. While panning/zooming a heavy document, a frame
costs ~0 ms (reuse).

## How to measure again

```bash
pnpm --dir web vite --port 5199 &
# then, with Playwright, open http://localhost:5199/bench.html and call
# window.runBench([1000, 5000, 20000]) or window.runPan(20000)
```

`web/src/bench/` has the synthetic document generator.

## GPU renderer (CanvasKit)

Besides Canvas 2D there is a second scene renderer: **CanvasKit** (Skia in
WebAssembly) on WebGL, in `renderer/ck/`. It is chosen with the CPU/GPU button in
the bar (or with `?renderer=gpu`); the choice is remembered. **The default stays
the CPU**, for two reasons:

- **I have not measured an advantage.** The development environment has no GPU: WebGL
  runs in software (SwiftShader), and there CanvasKit is SLOWER than Canvas 2D (20,000
  nodes framed: ~104 ms versus ~76 ms; zoomed: equal). On a real GPU it is
  plausible that it does better, but Canvas 2D in Chrome is GPU-accelerated
  too, so it is not a given. The button shows the last frame's time,
  so the comparison can be made on your own machine.
- **Text is different.** The WASM has no system fonts: text is drawn with
  Inter (included in `public/fonts`, OFL licence, four weights), which is already
  the model's default typeface. Text in another family falls back to
  Inter, and CanvasKit does not do kerning (sub-pixel differences).

What is there: the same rules as Canvas 2D for instances and overrides, clipping and
transparent frames, gradients, center/inside/outside strokes, shadow and blur (here for
the whole node), vectors, images and placeholders, scene index, discarding and
levels of detail. CanvasKit is downloaded only the first time the GPU is chosen (~7
MB, in files separate from the main bundle). If it fails to load, WebGL is missing
or the context is lost, the app goes back to the CPU and says so in the button.

**Parity.** `pnpm parity` draws a gallery with both renderers at four
zoom levels and fails if more than 1.5% of the pixels differ by more than 32/255. Today:
0.87% at zoom 1 (all text), 0.08% at 2, 0.15% at 0.35 and 0.01% at 0.08.

## Editing large documents (20,000 nodes)

Measured with `go run ./scripts/gen-large-doc -workspace DIR -nodes 20000` and a
CDP profile during a drag:

- opening until "connected": 46 s -> ~1.7 s (children indexed once, Layers virtualised and with branches collapsed above 2000 nodes);
- drag: p90 268 ms -> ~44 ms, median ~8 ms;
- `applyOp` records the scene's *provenance* (`store/sceneDelta.ts`): the scene index updates only the touched nodes without comparing the whole map (`updateIndex` 18% -> 4%);
- snap with `SnapIndex` (sorted lines, binary search) instead of a linear scan;
- `relayout` does not copy the node map if no frame has auto layout.

On the server side `Hub.Submit` used to deep-clone the whole document on every op (85% of the
cost). Now it is copy-on-write (`core.ApplyShared`: the node map is copied by
pointer, only the written nodes are cloned): 5,000 nodes 5.5 -> 0.65 ms, 20,000
nodes >22 -> 2.2 ms per op (`go test ./internal/server -bench SubmitLargeDoc`).

On the client side the node map (`SceneState.nodes`) is no longer an object copied
on every op (~9 ms at 20,000 nodes) but a PERSISTENT map with 256 buckets
(`store/nodeMap.ts`): an edit copies 256 pointers and only the touched buckets,
the comparison between two scenes skips shared buckets, and the scene index's
extents use it too. In the profile of a drag at 20,000 nodes
`applyOp` and `updateIndex` no longer appear among the top costs (p90 ~33 ms,
no regular long task). The remaining cost is React (properties panel).

## Known limits

- With a **full view of tens of thousands of nodes** the cost is the
  rasterizer's (`fill`, `roundRect`): on CPU it stays ~100 ms, which is why
  image reuse covers the movement. The GPU renderer (above) exists
  but its advantage must be measured on real hardware.
- `applyOp` copies the node map on every op (12 ms at 20,000 nodes), and the
  comparison for the index is linear in the number of nodes. Persistent data
  structures are needed to go further.
- Documents with components rebuild the whole index when a node
  inside a master changes.
