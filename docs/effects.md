# Effects and blend modes

A node carries an ordered list of effects (`Node.effects`, replaced whole by the `effects` mask path) and a blend mode (`Node.blend_mode`, the `blend_mode` mask path).

| Effect | What it does | Drawn on |
| --- | --- | --- |
| `drop_shadow` | shadow behind the node; any number, the last is the lowest | every node |
| `inner_shadow` | shadow of everything outside the outline, cast inward | rect, ellipse, frame |
| `layer_blur` | blurs the node itself (the first one counts) | every node |
| `background_blur` | blurs what is behind the node, inside its outline (the first one counts) | rect, ellipse, frame |

Offsets, blur and radii are in world units. Shadow `blur` is the canvas radius (sigma = blur / 2); blur `radius` is the sigma.

The blend mode is one of the CSS names (`multiply`, `screen`, `overlay`, ... `luminosity`); absent means normal. `BLEND_MODE_*` out of range is rejected whole, like the constraint enums (golden fixture `testdata/golden/blend_effects.json`, run from Go and TS).

## Where it is drawn

- **Canvas 2D**: the first shadow uses the context's shadow state; the others are drawn first with the shape parked off canvas and the shadow offset bringing the shadow back. Inner shadows fill an even-odd ring inside a clip. Background blur redraws the canvas blurred inside the outline. Blend mode is `globalCompositeOperation`.
- **CanvasKit (GPU)**: shadows are image filters on the node's layer (several are stacked with a blend filter), inner shadow is a shadow-only filter over a ring inside a clip, background blur is a backdrop filter, blend mode is the layer paint's blend mode.
- **Code (HTML/React)**: extra shadows and inner shadows are `box-shadow` entries (`inset` for inner), background blur is `backdrop-filter`, blend mode is `mix-blend-mode`.
- **SVG**: several shadows are merged in one `<filter>`; blend mode is a `mix-blend-mode` style. Inner shadows are a filter (inverted alpha, blurred, offset, clipped to the shape); background blur cannot be expressed in a standalone SVG and is not exported.
- **MCP**: `set_properties` takes `effects` (`dropShadow`, `innerShadow`, `layerBlur`, `backgroundBlur`) and `blendMode`; `get_document` reports `blendMode`.

## Known limits

- A blend mode applies to what the node itself draws against what is already on the canvas; a frame does not isolate its children into a group first.
- Inner shadow and background blur need an outline path, so they are ignored on text, images and vectors.
- Shadows of text cast from the glyphs; box-shadow in code casts from the box.
