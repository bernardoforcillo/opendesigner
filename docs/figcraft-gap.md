# FigCraft feature port

[FigCraft](https://github.com/storytold/figcraft) is an MIT/Apache-2.0 Rust Figma clone. This page
records which of its features opendesigner took (clean-room, from its public docs and behaviour),
and which it did not.

## Ported

- **Plugins and import**: WebAssembly plugins (docs/handoff.md; a command-list ABI instead of FigCraft's host calls), and the `.fig` import tail: connectors, tables, sticky notes and similar layers, per-kind import counts (synthetic files only).
- **Shapes and paints** (docs/shapes.md): angular and diamond gradients, polygon, star, arc and ring,
  corner smoothing and independent radii, arrowheads, per-side stroke weights, shared paint and effect styles.
- **Layout and components**: min/max sizes, absolute children, baseline alignment, swap / detach /
  reset overrides / go to main component, boolean variables and layout bindings (docs/layout.md,
  docs/components.md, docs/variables.md).
- **Dev Mode and code** (docs/codegen.md, docs/handoff.md, docs/flows.md): SwiftUI and Jetpack Compose
  export, ready-for-dev and annotations, compare changes, device frames and hotspot hints in Present,
  prototype expressions and `else` guards.
- **Leptos export, ordered else-if, exact gradients** (docs/codegen.md, docs/flows.md, docs/shapes.md): a Leptos
  (Rust) code target, `Transition.order` for if / else if / else chains, and the diamond (CSS layers) and
  angular / diamond (SVG patterns) gradients in code. The Leptos output passes `cargo check`; `trunk build`
  and the generated Playwright tests were not run (no wasm target or browser here).
- **Vector** (docs/vector.md): variable-width strokes (width profile, presets, tool, panel, SVG as a filled outline) and the shape builder tool.
- **Type and effects** (docs/typography.md, docs/effects.md): text case, super/subscript, lists, indent,
  OpenType features, vertical alignment and inset, horizontal text scale (also in rich-text runs and in
  paragraph / character styles), progressive blur, noise, texture and glass.
- **Localization** (docs/localization.md): typed catalogs with plurals, live language switch, language from
  the browser; first surfaces translated into seven languages (machine drafts).

## Not ported

- Auto layout grid mode (fixed / hug / fr tracks, spans); groups as auto layout children.
- Vector-network editing tools, noise/glass refraction.
- Accessibility tree, accounts and teams.
- Variables from `.fig` files (only a warning counts the layers that use them), live connector ends, table structure beyond frames, real-file `.fig` fidelity, Display P3, `.fig` export.

## Unverified

The CanvasKit (GPU) paths, canvas pixels and the browser UI were type-checked and unit-tested only;
run `pnpm parity` on a machine with a GPU. Generated Swift and Kotlin were never compiled.
