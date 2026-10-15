# Rendering and styling: closing the gaps (design spec)

Status: draft for review. Date: 2026-10-15. Product code: none in this spec.

## 1. Goal

The roadmap (docs/roadmap.md, section 1) lists three paint items and two effect items under "Basic parity": more gradient stops, gradient on strokes from the panel, image as a fill, and multiple shadows per node, inner shadow, background blur, blend mode. The goal is that each of these behaves the same in every surface that draws or describes a node: the 2D canvas, the CanvasKit (GPU) renderer, the SVG export, the exported code, the panel, MCP, copy/paste and the .fig import.

## 2. Finding: the scope is already shipped

The roadmap marks all five items `[x]` (lines 12-15) and docs/effects.md documents them. The code agrees:

| Item | Where it lives |
| --- | --- |
| More stops, add/move/remove | `web/src/ui/GradientControls.tsx`, `web/src/ui/gradientOps.ts` |
| Gradient on strokes | `Stroke.paint` is a `Paint` (proto line ~61); `PaintTarget` in `gradientOps.ts` covers fill and stroke |
| Image as a paint (fill / fit / tile) | `ImagePaint` in `proto/opendesigner/v1/opendesigner.proto`; `internal/core/paints.go` (`validateNodePaints`); `imagePaintOps` in the panel |
| Effect list (drop shadow, inner shadow, layer blur, background blur) | `Effect` oneof in the proto; `web/src/ui/EffectsControls.tsx`, `effectOps.ts` |
| Blend mode | `Node.blend_mode = 48`, `BlendMode` enum, `blend_mode` mask path (`internal/core/apply.go` ~412, ~534); `web/src/store/applyOp.ts` |
| Canvas 2D | `web/src/renderer/canvasRenderer.ts` (shadows ~202-300, backdrop blur ~252) |
| CanvasKit | `web/src/renderer/ck/ckRenderer.ts` (`drawBackdropBlur`, `drawInnerShadows`, `beginEffects`) |
| SVG | `web/src/export/svg.ts` (`effectsRef`, `mix-blend-mode` style) |
| Code | `internal/codegen/css.go`, `internal/codegen/build.go` |
| MCP | `internal/mcp/tools.go` (`EffectSpec`, `blendModes`, `GradientSpec`) |
| .fig import | `internal/figimport/fig.go` (effects ~723, blend ~500, paints ~604) |
| Cross-language contract | golden `testdata/golden/blend_effects.json`, run from Go and TS |

So this spec does not propose building those features again. It proposes closing the residual gaps found while reading the code, and should be read as a hardening spec. If the owner wants something different, see open question 1.

## 3. Current state and residual gaps

Each gap is a divergence between surfaces or a documented limit. Items marked "verify" were seen only partially and must be confirmed with a failing test before any fix.

G1. Stale MCP wording. `internal/mcp/exportcode.go:59` still tells agents the export renders "the first drop shadow and first layer blur", while docs/effects.md says extra shadows, inner shadows, background blur and blend mode are exported to code. An agent reading the tool description will under-use effects.

G2. Fill paint kinds over MCP. `FillSpec` (`internal/mcp/tools.go` ~21-31) accepts a solid or a linear/radial gradient only. Image paints and mesh paints exist in the document and the panel but cannot be set by an agent through `fills`. Stroke paint over MCP: verify whether any tool writes a gradient or image stroke (a grep found no stroke spec in `tools.go`).

G3. Gradient types lost on import. `figimport` maps angular and diamond gradients to radial and warns (`fig.go` ~615-623). There is no angular or conic paint in the model.

G4. Blend mode has no group isolation. docs/effects.md "Known limits": a frame does not isolate its children, so a blend mode on a child blends against everything behind the frame, unlike Figma's "pass through" versus "normal" frame semantics and unlike CSS `isolation`. The importer already maps `PASS_THROUGH` to normal (`fig.go:501`), which hides the difference on import.

G5. Effect coverage by node kind. Inner shadow and background blur are ignored on text, images and vectors (docs/effects.md). Panel behaviour for those kinds (does it still offer the control?) needs verification.

G6. "First one counts" for layer blur and background blur; shadows have no such limit. This is documented, but the panel should make it visible (verify what `EffectsControls.tsx` shows for a second blur).

G7. Background blur is not in the SVG export (no standalone SVG expression). It is silently dropped; the export gives no warning.

G8. Single fill drawn. The code export and renderers use the first fill (`resolvedFill`, and the export tool text at `exportcode.go:59`). Multiple fills per node are in the model (`repeated Paint fills`) but only the first is drawn. Not in scope here, but "image as a fill" over a solid fill (image plus tint) is affected. Needs a decision, see open question 3.

G9. Copy/paste and duplicate. Effects and blend mode are claimed for copy/paste in the roadmap. No dedicated test was found by name; verify with a test that pastes a node carrying all effect kinds, blend mode, a gradient stroke and an image fill, and compares the document.

## 4. Data-model and op changes

Most of the work needs no schema change.

- No change: G1, G5, G6, G7, G9 (docs, tests, panel messages, export warnings).
- G2: no proto change. Extend the MCP `FillSpec` (and a stroke spec, if absent) with `image { assetHash, mode }` and `mesh { rows, cols, colors }`, converted to the existing `ImagePaint`/`MeshPaint` and validated by the existing `validateNodePaints`. Asset upload stays an editor action, as for fonts (`internal/mcp/typography.go:230`).
- G4 (only if approved): add a node-level flag, for example `bool isolate_blend = N` on frames and groups, written through a new mask path `isolate_blend`. Default false keeps every stored document unchanged (proto3 absent = false = today's behaviour). Needs: an `apply.go` case (frame/group only, other kinds rejected whole like the constraint enums), `applyOp.ts` parity, and a golden fixture next to `blend_effects.json`. No new Op type.
- G3 (only if approved): a new `Paint.kind` alternative (an angular paint with the same stops) is additive. Out of this spec unless approved; see open question 2.

Rules that hold for any change here: proto additions are append-only with fresh field numbers; behaviour changes land in Go and TS together and are pinned by a golden fixture run from both sides (the existing convention); invalid values are rejected whole, scene unchanged.

## 5. Impact by surface

- Server (Go): `internal/core/apply.go` (validation of any new mask path), `internal/mcp/tools.go` (paint specs, descriptions), `internal/mcp/exportcode.go` (wording), `internal/figimport/fig.go` (warnings, optional angular). No storage migration.
- Canvas 2D (`canvasRenderer.ts`): only G4 changes drawing (draw an isolated frame into an offscreen layer, then composite it with its own blend mode).
- CanvasKit (`ckRenderer.ts`): G4 maps to `saveLayer` for an isolated frame; `beginEffects` already uses a layer. Shadow, blur and blend parity with the 2D renderer must be kept; `web/src/renderer/effects.test.ts` is the template.
- SVG export (`svg.ts`): G4 maps to `style="isolation:isolate"` on the group. G7: report "background blur not exported" through the existing export notice mechanism if one exists (verify), otherwise a comment in the output is acceptable.
- Code export (`internal/codegen`): G4 maps to CSS `isolation: isolate`. Background blur is already `backdrop-filter`.
- Panel: effects list and gradient controls exist. Changes are limited to hints for G5/G6 and, for G4, one checkbox on frames and groups ("Isolate blending").
- MCP: G1 and G2 as above; `set_properties` gains `isolateBlend` only with G4, and `get_document` reports it.
- Copy/paste, duplicate, components: effects, `blend_mode` and paints are node fields, so they travel with the node; instance overrides must be checked for `blend_mode` and `effects` (verify in `internal/core/components.go` and `web/src/store/components.ts`).

## 6. Approaches

### Approach A: verify and harden, no new rendering features

Add the missing tests (G9, panel behaviour, MCP round trips), fix the stale text (G1), extend MCP paint specs (G2), and surface the documented limits in the panel and export (G5-G7). No proto change, no renderer change.

Trade-offs: lowest risk and smallest diff, keeps the three renderers and the exporters in lockstep. Leaves blend isolation (G4), angular gradients (G3) and multi-fill drawing (G8) as documented limits.

### Approach B: A plus fidelity features

Everything in A, plus the `isolate_blend` flag (G4), an angular paint (G3), and drawing several fills in order (G8).

Trade-offs: closer to Figma behaviour and a more faithful .fig import. It touches the proto, both renderers, SVG, code export and the golden tests, and G8 changes how existing documents look (a node with two fills starts drawing both), which needs a migration decision.

### Recommendation

Approach A now, then G4 alone as a follow-up only if a user asks for it. The roadmap items in scope are done, so the highest expected value is making sure agents and importers can actually use them (G1, G2) and that the roadmap's claims are backed by tests (G9). B's G8 silently changes existing documents and G3 has no user pull in the repo. G4 is small and additive and is the one fidelity item worth keeping on the list.

## 7. Testing plan

Follow existing conventions: Go tests beside the code, vitest in `web/src`, golden fixtures in `testdata/golden` run from both sides.

- G1: a Go test that the `export_code` description mentions inner shadow, background blur and blend mode (guard against drift; model on `internal/mcp/exportcode_test.go`).
- G2: `internal/mcp` tests: `set_properties` with image and mesh fills; invalid hash and bad mesh size rejected with `ErrPaint`; round trip through `get_document`. Extend a golden fixture with an image-filled node and a gradient-stroked node.
- G3/G4 (if approved): golden fixture, 2D and CanvasKit tests modelled on `web/src/renderer/effects.test.ts`, SVG assertion in `svg.test.ts`, CSS assertion in `internal/codegen/blend_test.go`.
- G5/G6: component tests on `EffectsControls` for each node kind and for two blurs.
- G7: an `svg.test.ts` case that a background blur does not break the output and is reported.
- G9: store test that copy then paste (and duplicate) of a node with every effect kind, blend mode, gradient stroke and image fill yields an equal node; one more for an instance override.
- Regression: the existing `blend_effects.json` golden and the 20,000-node bench (docs/performance.md) must still pass; the effects outset in `sceneIndex.ts` must not change for unaffected nodes.
- Manual: open one document containing all cases with the GPU and the 2D renderer and compare with the SVG export.

## 8. Ordered task breakdown

1. Write the failing tests for G9 (copy/paste/duplicate/instance overrides) and G5/G6 (panel by node kind). From the results, decide which of G5, G6, G9 are real bugs.
2. Fix the stale `export_code` description (G1) with its guard test.
3. MCP: image and mesh fill specs, and a stroke paint spec if missing (G2), with validation and tests.
4. Golden fixture for image fill plus gradient stroke, run from Go and TS.
5. Panel hints for node-kind limits and the one-blur rule (G5, G6).
6. SVG: report that background blur is not exported (G7).
7. Update docs/effects.md and docs/roadmap.md to match (a line for any limit that moved). Keep the existing doc style.
8. Optional, separate PR, only if approved: `isolate_blend` (G4): proto, `apply.go`, `applyOp.ts`, golden, 2D, CanvasKit, SVG, code, panel, MCP.
9. Optional, separate PR, only if approved: angular paint (G3) and import mapping.

Each step is independently shippable and ends with `go test ./...` and `vitest run` green.

## 9. Open questions

1. Scope: the roadmap marks every item in this brief as done. Do you want hardening (Approach A), the fidelity features (B), or did you mean a different set of items that is not yet in the roadmap (for example more than one fill drawn)?
2. Fidelity versus Figma: should blend mode isolate children inside a frame (a new per-frame flag, default off), and do you want angular/diamond gradients as real paints instead of the radial approximation on .fig import?
3. Several fills: should a node with more than one fill draw all of them, in order (needed for "image plus tint")? It changes how existing documents render, so it needs your approval and probably an opt-in or a version gate.
4. Background blur in SVG: accept the documented omission with a warning, or rasterise the blurred backdrop into the SVG as an embedded image?
5. Should agents be able to upload image assets over MCP, or stay editor-only as fonts are today (G2)?
