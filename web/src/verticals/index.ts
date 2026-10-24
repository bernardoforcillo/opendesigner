import type { IconName } from "../ui/ds/Icon";
import type { EditorMode } from "../store/flowUi";
import type { Vertical } from "../store/types";

// THE VERTICALS. A document is for one kind of work, and the editor shows what that work needs:
//
//   publishing  books, magazines, reports  -- pages and masters, text frames, styles, PDF / EPUB
//   design      illustration, UI, boards   -- vector, components, variables, boards
//   product     design + development       -- flows, prototype, handoff, generated code
//
// A vertical shapes the INTERFACE (which modes, tools and menu entries are offered, the templates on
// the Home, the defaults of a new page); it never limits what a document can hold. A document of any
// vertical opens in every vertical's editor, and changing it (document menu) loses nothing. It is stored
// in the document (settings.vertical), so everyone who opens it sees the same editor. "product" is the
// default: documents made before verticals existed behave as they always did.

export interface VerticalDef {
  id: Vertical;
  name: string;
  tagline: string;
  icon: IconName;
  /** The modes offered, in order; the first is the one a document opens in. */
  modes: readonly EditorMode[];
  /** Labels that replace the mode's usual name in this vertical. */
  modeLabels: Partial<Record<EditorMode, string>>;
  /** Document-menu entries that are not offered here (their ids, see ui/shell/DocMenu.tsx). */
  hiddenMenu: readonly string[];
  /** What a "New document" of this vertical starts as. */
  blank: { docName: string };
}

export const VERTICAL_DEFS: Readonly<Record<Vertical, VerticalDef>> = {
  publishing: {
    id: "publishing",
    name: "Publishing",
    tagline: "Books, magazines and reports: pages, masters, text that flows, PDF and EPUB.",
    icon: "page",
    modes: ["design"],
    modeLabels: { design: "Layout" },
    hiddenMenu: ["board", "import-fig", "plugins", "variables"],
    blank: { docName: "Untitled publication" },
  },
  design: {
    id: "design",
    name: "Design",
    tagline: "Illustration, UI design and boards: vector, components, variables.",
    icon: "pen",
    modes: ["design", "board"],
    modeLabels: {},
    hiddenMenu: ["export-epub", "export-pdf-bleed", "page-setup"],
    blank: { docName: "Untitled design" },
  },
  product: {
    id: "product",
    name: "Design × Development",
    tagline: "Design the screens, connect the flows, try the prototype and take the code home.",
    icon: "code",
    modes: ["design", "flows", "dev", "board"],
    modeLabels: {},
    hiddenMenu: ["export-epub", "export-pdf-bleed", "page-setup"],
    blank: { docName: "Untitled" },
  },
};

export const VERTICAL_LIST: readonly VerticalDef[] = [VERTICAL_DEFS.publishing, VERTICAL_DEFS.design, VERTICAL_DEFS.product];

export function verticalDef(v: Vertical | undefined): VerticalDef {
  return VERTICAL_DEFS[v ?? "product"];
}

/** The mode a document of this vertical should be in: `mode` when offered, else the vertical's first. */
export function modeFor(v: Vertical, mode: EditorMode): EditorMode {
  const def = verticalDef(v);
  return def.modes.includes(mode) ? mode : def.modes[0];
}

/** Is the document-menu entry `id` offered in this vertical? */
export function menuShows(v: Vertical, id: string): boolean {
  return !verticalDef(v).hiddenMenu.includes(id);
}
