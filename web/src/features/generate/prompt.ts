import type { SceneState } from "@/store/types";

// GENERATE A SCREEN (docs/generate.md): the editor has no model. This module turns the open document into
// the kit an agent may build from, and a description into a prompt that sends the agent to the MCP tools.

export interface DesignKit {
  components: string[];
  colorVariables: string[];
  textStyles: string[];
}

const byName = (a: string, b: string) => a.localeCompare(b);

/** The names the document offers: components, color variables and paragraph text styles. */
export function designKitOf(scene: SceneState | null): DesignKit {
  if (!scene) return { components: [], colorVariables: [], textStyles: [] };
  return {
    components: Object.values(scene.components).map((c) => c.name).filter(Boolean).sort(byName),
    colorVariables: Object.values(scene.variables).filter((v) => v.type === "color").map((v) => v.name).sort(byName),
    textStyles: Object.values(scene.textStyles).filter((d) => d.kind !== "character").map((d) => d.name).sort(byName),
  };
}

export const kitIsEmpty = (k: DesignKit) => k.components.length + k.colorVariables.length + k.textStyles.length === 0;

const list = (names: string[]) => (names.length === 0 ? "(none)" : names.map((n) => `"${n}"`).join(", "));

/**
 * The prompt for the connected agent. With `screenshot` the description is optional context and the agent reads
 * the attached image itself; the width is the screen's, in px.
 */
export function buildGeneratePrompt(description: string, kit: DesignKit, opts: { width?: number; screenshot?: boolean } = {}): string {
  const width = opts.width && opts.width > 0 ? Math.round(opts.width) : 393;
  const what = opts.screenshot ? "the screen in the attached screenshot (read its structure, not its exact pixels or colors)" : "this screen";
  const lines = [
    `Generate ${what} in the open opendesigner document, using ONLY the document's own components and tokens.`,
    description.trim() ? `Description: ${description.trim()}` : "",
    `Components: ${list(kit.components)}`,
    `Color variables: ${list(kit.colorVariables)}`,
    `Text styles: ${list(kit.textStyles)}`,
    `Use the opendesigner MCP prompt "generate_screen" (or: get_design_kit, then generate_screen with width ${width}, then review_design).`,
    "Every color is a color variable, every text takes a text style, every repeated part is a component instance. Never write a literal color.",
    "If the kit has nothing that fits a part, say so instead of inventing one.",
  ];
  return lines.filter((l) => l !== "").join("\n");
}
