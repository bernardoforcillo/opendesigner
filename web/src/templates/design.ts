import { hexFill, type IdGen } from "@/templates/builder";
import { Pager, type PublishingBuilt } from "@/templates/publishing";

// THE DESIGN TEMPLATES: a poster on a real sheet and a brand sheet on the open canvas. Like the
// publishing ones they are plain data (see publishing.ts for the shape).

const SANS = "Inter, sans-serif";
const SERIF = "Georgia, serif";

// ---------------------------------------------------------------------------------------------------
// POSTER -- A3 portrait with bleed: big type and a few shapes.
// ---------------------------------------------------------------------------------------------------
export function buildPoster(pageId: string, newId: IdGen): PublishingBuilt {
  const W = 842, H = 1191;
  const p = new Pager(pageId, newId);
  const page = p.page({ name: "Poster", width: W, height: H, bleed: 9, marginTop: 48, marginBottom: 48, marginLeft: 48, marginRight: 48 });

  p.rect(page, 0, 0, W, H, "#f4ecdd", "Background");
  const sun = p.b.add({ id: newId(), parentId: page.id, name: "Circle", kind: "ellipse", x: 120, y: 300, width: 600, height: 600, fills: [hexFill("#e8553d")] });
  void sun;
  p.rect(page, 48, 960, W - 96, 6, "#1d1d1b", "Rule");
  p.text(page, "OPEN\nAIR", 48, 48, W - 96, 460, { family: SANS, size: 190, weight: "800", color: "#1d1d1b", name: "Headline", lineHeight: 0.92, letterSpacing: -6 });
  p.text(page, "A day of music, food and ideas", 48, 990, 520, 60, { family: SERIF, size: 30, weight: "700", color: "#1d1d1b", name: "Subtitle", lineHeight: 1.15 });
  p.text(page, "SAT 14 JUNE · 12:00\nRIVERSIDE PARK", 48, 1090, 400, 50, { family: SANS, size: 16, weight: "600", color: "#1d1d1b", name: "Details", letterSpacing: 2, lineHeight: 1.5 });
  p.text(page, "opendesigner.example", 534, 1108, 260, 24, { family: SANS, size: 14, weight: "500", color: "#1d1d1b", align: "right", name: "Web" });

  return { nodes: p.b.nodes, flows: [], transitions: [], pages: p.pages, textStyles: [], settings: { vertical: "design" } };
}

// ---------------------------------------------------------------------------------------------------
// BRAND SHEET -- an open canvas: logo mark, palette and type specimen.
// ---------------------------------------------------------------------------------------------------
export function buildBrandSheet(pageId: string, newId: IdGen): PublishingBuilt {
  const p = new Pager(pageId, newId);
  const page = p.page({ name: "Brand sheet" });

  p.text(page, "Brand", 0, 0, 480, 64, { family: SANS, size: 56, weight: "800", color: "#111827", name: "Title", letterSpacing: -1.5 });
  p.text(page, "Logo, palette and type in one place.", 0, 76, 480, 24, { family: SANS, size: 16, color: "#6b7280", name: "Subtitle" });

  // Logo mark: a square and a circle.
  p.rect(page, 0, 150, 120, 120, "#2563eb", "Logo square");
  p.b.add({ id: newId(), parentId: page.id, name: "Logo circle", kind: "ellipse", x: 60, y: 210, width: 120, height: 120, fills: [hexFill("#f59e0b")] });

  // Palette.
  const palette: [string, string][] = [["Ink", "#111827"], ["Blue", "#2563eb"], ["Amber", "#f59e0b"], ["Mint", "#10b981"], ["Cloud", "#e5e7eb"]];
  p.text(page, "Palette", 260, 150, 200, 20, { family: SANS, size: 12, weight: "700", color: "#6b7280", name: "Palette label", letterSpacing: 2 });
  palette.forEach(([name, hex], i) => {
    const x = 260 + i * 104;
    p.b.add({ id: newId(), parentId: page.id, name: `Swatch ${name}`, kind: "rect", cornerRadius: 12, x, y: 180, width: 88, height: 88, fills: [hexFill(hex)] });
    p.text(page, name, x, 276, 88, 18, { family: SANS, size: 13, weight: "600", color: "#111827", name: `${name} label` });
    p.text(page, hex.toUpperCase(), x, 296, 88, 16, { family: SANS, size: 11, color: "#6b7280", name: `${name} value` });
  });

  // Type specimen.
  p.text(page, "Type", 0, 380, 200, 20, { family: SANS, size: 12, weight: "700", color: "#6b7280", name: "Type label", letterSpacing: 2 });
  p.text(page, "Aa", 0, 410, 220, 130, { family: SANS, size: 120, weight: "800", color: "#111827", name: "Sans specimen", lineHeight: 1 });
  p.text(page, "Aa", 260, 410, 220, 130, { family: SERIF, size: 120, weight: "700", color: "#111827", name: "Serif specimen", lineHeight: 1 });
  p.text(page, "Inter — headings and interface", 0, 552, 240, 20, { family: SANS, size: 13, color: "#6b7280", name: "Sans caption" });
  p.text(page, "Georgia — long reading", 260, 552, 240, 20, { family: SANS, size: 13, color: "#6b7280", name: "Serif caption" });

  return { nodes: p.b.nodes, flows: [], transitions: [], pages: p.pages, textStyles: [], settings: { vertical: "design" } };
}
