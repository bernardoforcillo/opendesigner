import type { PluralForms } from "@/i18n/core";

// THE SOURCE CATALOG. Every key is the English text as the code writes it, and the
// value is that same text, so `en` is built from the list: add a string by adding
// it to PLAIN (or to PLURALS when it counts something) and then to every other
// catalog (the type of the others makes the compiler ask for it). Order follows
// the surface the string lives on, not the alphabet.
const PLAIN = [
  // Top bar
  "Document", "Mode", "Open left panel", "Close left panel", "Open right panel", "Close right panel",
  "Board", "Design", "Flows", "Develop",
  "An infinite board: sticky notes, text and arrows", "Draw the screens",
  "Connect the screens and try the prototype", "Readiness, generated code, export",
  "Your link does not allow editing", "View only", "Comment only", "Zoom",
  // Tool dock
  "Tools", "More shapes", "Animation", "Undo", "Redo", "Present",
  "Select", "Connect", "Sticky note", "Link", "Vote", "Frame", "Rectangle", "Ellipse", "Polygon", "Star",
  "Text", "Pen", "Node", "Hand", "Comment",
  // Document menu
  "Document menu", "Home", "New document", "Rename document", "Import SVG…", "Import .fig file…", "experimental",
  "Import PDF…", "editable text and shapes", "Import PDF as pictures…", "Export all pages as PDF…",
  "Export PDF for print (with bleed)…", "Export all pages as EPUB", "Page setup…", "Diagram (Mermaid, UML)…",
  "Whiteboard (sticky, table, kanban…)…", "Variables…", "Fonts…", "Styles (paragraph, character)…",
  "Versions…", "Share…", "Plugins…", "Pixel snap {n} px", "Pixel snap off", "cycles 1 / 4 / 8 / off",
  "Renderer {name}", "switch to {name}", "Document type", "Theme", "System", "Light", "Dark",
  "Language", "machine draft",
  // Home
  "Kind of document", "Start from a template", "Your documents", "Loading documents…", "No documents yet",
  "Pick a template above: in one click you get screens that are already connected, ready to try.",
  "Cancel", "Join", "Paste a link to join", "Link to a shared document",
  "That is not a valid opendesigner link.", "Could not read the documents ({error}).", "Open {name}",
  // Panel section headings
  "Size limits", "Variables", "Transitions", "Stroke", "Sizing", "Paths", "Override", "Layout", "Instance",
  "Fill", "Export", "Effect style", "Current flow", "Corners", "Constraints", "Component", "Arc", "Appearance",
] as const;

const PLURALS = {
  "{n} documents": { one: "{n} document", other: "{n} documents" },
  "{n} screens": { one: "{n} screen", other: "{n} screens" },
  "{n} flows": { one: "{n} flow", other: "{n} flows" },
} satisfies Record<string, PluralForms>;

/** Every key of the interface; the other catalogs are typed `Record<MessageKey, Message>`. */
export type MessageKey = (typeof PLAIN)[number] | keyof typeof PLURALS;

export const en = {
  ...Object.fromEntries(PLAIN.map((k) => [k, k])),
  ...PLURALS,
} as { [K in (typeof PLAIN)[number]]: K } & typeof PLURALS;
