# Graphics and colour: swatches, colour mode, object styles, layers, links, anchored objects

All of these are in the document menu (*Swatches and colour mode…*, *Object styles…*, *Layers…*, *Links…*) and, for the selection, in the properties panel.

## Swatches and colour mode

A **swatch** is a named color of the document's palette — RGB, a CMYK process color, a spot color, or a tint of another swatch. It is a *color variable with print data* (`Variable.swatch`, `cmyk`, `spot_name`, `tint_of` + `tint`), kept in a collection named "Swatches" that is made on first use. Because it is a variable, **using** a swatch is a binding: *Use for fill* / *Use for stroke* binds `fills.0` / `strokes.0` to it, and changing the swatch changes everything that uses it. Deleting a swatch detaches what used it (the node keeps its color); the swatches that were its tints stay as plain swatches of the color they show.

- **Process (CMYK)**: tick *Defined in CMYK* and set C, M, Y, K; the screen color is derived from them.
- **Spot**: give the ink a name (e.g. `PANTONE 485 C`); it is meant to print on its own plate.
- **Tint**: *New tint of this swatch* (1–100 % of the base ink). A tint follows its base: editing the base swatch re-derives its tints, and theirs, in the same gesture.
- **Colour mode** (RGB / CMYK) and the **output profile** (FOGRA39, SWOP v2, …) are document settings. In CMYK mode new swatches are CMYK, and exports will convert to CMYK; the profile is recorded as the PDF output intent.

**Honest scope.** The RGB ↔ CMYK conversion is the plain device one (`web/src/color/cmyk.ts`), not profile-managed: the profile is *recorded*, not applied, so a CMYK value here is a starting point for the print shop's own conversion, not a proof. Spot colors print as their CMYK/RGB equivalent until the print-ready PDF writer (a later block) gives them their own separation. No overprint, no gamut warnings.

## Object styles

A shared look for shapes. A style **sets** some of: fill, stroke, effects, opacity, corner radius, blend mode (`ObjectStyleDef.sets`). A node that applies it (`Node.object_style_id`) is drawn with those; its own values stay as the fallback, so detaching gives them back. A style can be *based on* another (the nearest wins). *New from selection* makes a style from a shape and applies it to it; *Redefine from selection* updates the style, and so every shape that uses it. Not for groups or instances. Deleting a style detaches its nodes and clears the `based_on` of the styles built on it (undo restores both).

## Layers

Layers are shared by **all pages**. A node names its layer (`Node.layer_id`; groups carry their children). A **hidden** layer hides what is on it, a **locked** one keeps it from being picked or selected (it is still drawn), and *Don't print* keeps it out of PDF export (recorded; honoured by the PDF writer). Layers are listed in a panel order that undo restores; nodes on no layer are unaffected. This does not reorder drawing: stacking is still by each page's order. *Move selection here* and the Layer picker in the properties panel assign nodes.

## Linked images

An image node is a reference to a file in the document's assets plus what is known about the file it was placed from (`ImageNode.original_name`, `pixel_width`, `pixel_height`, recorded when it is dropped). The **Link** section of the properties panel shows the file, its size in pixels and the **effective resolution** at the placed size (`pixels ÷ width × 72`, since 72 world units are one inch), warns under 150 ppi, and offers *Restore shape*, *Actual size* (72 ppi) and *Print size (300 ppi)*. **Relink…** picks a file, uploads it and replaces the source in one gesture (`SetImage`, op 48), keeping the width and taking the new image's shape. *Links…* lists every image of the document, opens one on its page and relinks it. A browser cannot watch a file on disk, so "update a link" is relinking to the new version. Images placed before this existed have no pixel size recorded: they show no resolution until relinked.

## Anchored objects

Put `[@a1b2c3d4]` in a text (the start of an object's id; *Anchor the object in the text* with a text and an object selected does it, at the end) and the object sits in the text like a character: the text leaves a box in the line, sized like the object and standing on the baseline, and the object is drawn there. It moves with the text, its edits and its reflow, and a threaded story anchors it in the frame the marker falls in. The object's own x and y are ignored while it is anchored (derived, like threads and wrap); any shape, picture, group or frame works, best on the same page as the text. A marker that names nothing, or is ambiguous, leaves no trace. *Release* takes the marker out.

## Model and rules

```
Variable      + swatch, cmyk{c,m,y,k 0..1}, spot_name, tint_of, tint
DocSettings   + color_mode ("" | "cmyk"), icc_profile
ObjectStyleDef{id, name, sets, fills, strokes, effects, opacity, corner_radius, blend_mode, based_on}   Document.object_styles
Layer{id, name, hidden, locked, no_print}                                                              Document.layers (ordered)
Node          + object_style_id, layer_id          (mask paths "object_style_id", "layer_id")
ImageNode     + original_name, pixel_width, pixel_height
ops 44-48     SetObjectStyleDef, DeleteObjectStyleDef, SetLayer(+position), DeleteLayer, SetImage
```

Rules (Go `internal/core/graphics.go` is the authority, `web/src/store/graphics.ts` its twin; golden fixtures `object_styles`, `layers`, `swatches`, `color_mode`, `image_link` run on both): `sets` are distinct known properties; paints are well formed; opacity 0–1; corner radius ≥ 0; no `based_on` loops; a node's style and layer must exist; at most 200 layers; CMYK channels 0–1; spot name ≤ 64; a tint has a base swatch and 1–100 %; colour mode is `""` or `cmyk`; profile ≤ 64 characters; relinking needs an image node.

## MCP

`list_object_styles`, `set_object_style` (values, or `fromNodeId` to take them from a shape), `delete_object_style`, `apply_object_style`; `list_layers`, `set_layer`, `delete_layer`, `assign_layer`; `list_swatches`, `set_swatch` (CMYK, RGB, spot or tint; use it with `bind_variable` on `fills.0` / `strokes.0`), `delete_swatch`; `set_document_settings` takes `colorMode` and `iccProfile`. Linking, relinking and anchoring are editor commands.

## Not yet

Profile-managed conversion and soft proofing, overprint, separations of spot colors in output (Block 5), swatch groups, gradient swatches, layer stacking order across pages, image fitting inside a frame (an image node *is* its box; fill an ordinary frame with an image to crop it), watching a file on disk for changes, and anchored objects that sit above the line or beside it.
