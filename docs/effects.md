# Effects and blend modes

A node carries an ordered list of effects (`Node.effects`, replaced whole by the `effects` mask path) and a blend mode (`Node.blend_mode`, the `blend_mode` mask path).

| Effect | What it does | Drawn on |
| --- | --- | --- |
| `drop_shadow` | shadow behind the node; any number, the last is the lowest | every node |
| `inner_shadow` | shadow of everything outside the outline, cast inward | rect, ellipse, frame |
| `layer_blur` | blurs the node itself (the first one counts) | every node |
| `background_blur` | blurs what is behind the node, inside its outline (the first one counts) | rect, ellipse, frame |
| `progressive_blur` | a blur whose radius ramps along a line, on the node (`background` false) or behind it (true) | layer: every node; background: rect, ellipse, frame |
| `noise` | seeded film grain over the node, mono, duo or multi | rect, ellipse, frame, image |
| `texture` | soft seeded mottling (light and dark blobs) over the node | rect, ellipse, frame, image |
| `glass` | frosted backdrop, a fine grain and a light edge, in one effect | rect, ellipse, frame, image |

Offsets, blur and radii are in world units. Shadow `blur` is the canvas radius (sigma = blur / 2); blur `radius` is the sigma.

The blend mode is one of the CSS names (`multiply`, `screen`, `overlay`, ... `luminosity`); absent means normal. `BLEND_MODE_*` out of range is rejected whole, like the constraint enums (golden fixture `testdata/golden/blend_effects.json`, run from Go and TS).

## Progressive blur, noise, texture and glass

`Effect` oneof fields 20..29 are reserved for these. Parameters (all validated on the `effects` mask path by `core.validateEffects`, mirrored by `store/effects.ts`; golden fixture `testdata/golden/effects_fx.json` runs both sides):

- **`progressive_blur`**: `start_radius` at (`x1`,`y1`) to `end_radius` at (`x2`,`y2`), points in the node's unit box (0..1 like a gradient's handles); the radius is held before the start and past the end. Radii are standard deviations in world units, 0..10000.
- **`noise`**: `mode` (mono: grey grains, duo: grains of `color`/`color2`, multi: random colours), `size` (grain in world units, 0 means 1), `density` (share of grains that show, 0..1), `opacity` (0..1), `seed`. The same seed draws the same grain on every renderer and every run (`renderer/effectsFx.ts::noiseTile`, a mulberry32 tile of 64 x 64 grains that repeats).
- **`texture`**: `scale` (blob size in world units, 0 means 8), `intensity` (0..1), `seed`. A wrapping value-noise tile, light blobs white and dark ones black.
- **`glass`**: `frost` (backdrop blur radius), `light` (0..1 strength of the light edge), `light_angle` (degrees, where the light comes from: 0 the left, 90 the top), `noise` (0..1 grain). It is **sugar**: every renderer first expands it (`expandGlass`, repeated in Go for the code export) into a background blur, a white mono grain and two inner shadows, a bright one on the lit side and a faint dark one opposite, and draws those. So glass needs no drawing code of its own and exports like its parts.

Noise, texture and glass need an outline (or an image's box), so they are ignored on text and vectors, like inner shadows.

## Where it is drawn

- **Canvas 2D**: the first shadow uses the context's shadow state; the others are drawn first with the shape parked off canvas and the shadow offset bringing the shadow back. Inner shadows fill an even-odd ring inside a clip. Background blur redraws the canvas blurred inside the outline. Blend mode is `globalCompositeOperation`.
- **CanvasKit (GPU)**: shadows are image filters on the node's layer (several are stacked with a blend filter), inner shadow is a shadow-only filter over a ring inside a clip, background blur is a backdrop filter, blend mode is the layer paint's blend mode.
- **Code (HTML/React)**: extra shadows and inner shadows are `box-shadow` entries (`inset` for inner), background blur is `backdrop-filter`, blend mode is `mix-blend-mode`.
- **SVG**: several shadows are merged in one `<filter>`; blend mode is a `mix-blend-mode` style. Inner shadows are a filter (inverted alpha, blurred, offset, clipped to the shape); background blur cannot be expressed in a standalone SVG and is not exported.
- **Progressive blur** is drawn in **bands** on the 2D canvas and CanvasKit: the ramp is cut into 8 strips across its direction (the first and last reach out to infinity), each strip draws the node (layer) or blurs the backdrop (background) clipped to it with the radius at its middle; strips overlap by a device pixel so the clip's antialiasing leaves no seam. It is an approximation of a continuous ramp: a visible step between bands appears only for large radii over small areas.
- **Noise and texture**: the seeded tile is a repeating pattern (2D canvas: `createPattern`; CanvasKit: an image shader) in world space anchored at the node's corner, filled over its box, clipped to its outline, at the node's opacity, after the inner shadows. One tile pixel is one grain (`size`), nearest-neighbour.
- **SVG**: a progressive *layer* blur is exported as a uniform blur of the mean of its two radii (a filter cannot ramp); a progressive background blur is not exported (as the uniform one); noise and texture are the same tile as an embedded PNG `<pattern>` (pixelated) filled over a copy of the node's outline; glass exports as its parts.
- **Code (HTML/React)**: glass becomes `backdrop-filter` and inset shadows; progressive blur, noise and texture are left out of the CSS (CSS blurs are uniform and it has no grain).
- **MCP**: `set_properties` takes `effects` (`dropShadow`, `innerShadow`, `layerBlur`, `backgroundBlur`, `progressiveBlur`, `noise`, `texture`, `glass`, with the parameters above; omitted ones take the editor's defaults) and `blendMode`; `get_document` reports `blendMode` and `effectKinds`.
- **Editor**: the Effects section has a progressive blur picker (none, layer, background) with start/end radii and a direction (top-bottom, bottom-top, left-right, right-left), a noise picker with grain/density/opacity/seed (and two colours for duo), texture and glass toggles with their parameters. Copy/paste keeps them.

## Known limits

- A blend mode applies to what the node itself draws against what is already on the canvas; a frame does not isolate its children into a group first.
- Inner shadow and background blur need an outline path, so they are ignored on text, images and vectors.
- Progressive blur is a banded approximation, the on-canvas ramp handles of a design editor are not there yet (direction is one of four presets plus whatever MCP writes), and the node's own shadows are drawn per band.
- Noise, texture and glass grain are a pattern, not per-pixel noise: at high zoom the grain scales with the node. Glass is simplified: no refraction or dispersion.
- Shadows of text cast from the glyphs; box-shadow in code casts from the box.
