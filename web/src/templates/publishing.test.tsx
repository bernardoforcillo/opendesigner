import "@testing-library/jest-dom/vitest";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { applyOp } from "@/store/applyOp";
import { builtToOps } from "@/templates/builder";
import { blankFor, DESIGN_TEMPLATES, PUBLISHING_TEMPLATES, templateById, templatesFor, TEMPLATES } from "@/templates/catalog";
import { resolveScene } from "@/store/variables";
import { chainsOf } from "@/store/threads";
import { masterCopyId } from "@/store/masters";
import { emptyScene, type SceneState } from "@/store/types";
import { TemplatePreview } from "@/home/TemplatePreview";

afterEach(cleanup);

function ids() {
  let i = 0;
  return () => `n${++i}`;
}

/** The scene a fresh document reaches when the template is applied to it. */
function applyTemplate(id: string): { scene: SceneState; rejected: number; total: number } {
  const t = templateById(id)!;
  const built = t.build("page1", ids());
  const ops = builtToOps(built, "doc");
  let scene = emptyScene("doc", "Doc");
  let rejected = 0;
  for (const op of ops) {
    const next = applyOp(scene, op);
    if (next === scene) rejected++;
    scene = next;
  }
  return { scene, rejected, total: ops.length };
}

describe("templates by vertical", () => {
  it("each vertical has its own set, starting with its blank one", () => {
    expect(templatesFor("product")).toBe(TEMPLATES);
    expect(templatesFor("publishing")).toBe(PUBLISHING_TEMPLATES);
    expect(templatesFor("design")).toBe(DESIGN_TEMPLATES);
    expect(PUBLISHING_TEMPLATES.map((t) => t.id)).toEqual(["blank-publishing", "book", "magazine", "report"]);
    expect(DESIGN_TEMPLATES.map((t) => t.id)).toEqual(["blank-design", "poster", "brand-sheet"]);
    for (const v of ["publishing", "design", "product"] as const) expect(blankFor(v)).toBe(templatesFor(v)[0]);
    for (const t of PUBLISHING_TEMPLATES) expect(t.vertical).toBe("publishing");
    for (const t of DESIGN_TEMPLATES) expect(t.vertical).toBe("design");
  });

  it("finds a template by id in any vertical", () => {
    expect(templateById("book")?.name).toBe("Book");
    expect(templateById("poster")?.vertical).toBe("design");
    expect(templateById("onboarding")?.vertical).toBeUndefined();
  });
});

describe.each([...PUBLISHING_TEMPLATES, ...DESIGN_TEMPLATES].map((t) => t.id))("template %s", (id) => {
  it("applies to a new document with every op accepted", () => {
    const { scene, rejected } = applyTemplate(id);
    expect(rejected).toBe(0);
    const t = templateById(id)!;
    expect(scene.settings?.vertical).toBe(t.vertical);
    const built = t.build("page1", ids());
    expect(scene.nodes.size).toBe(built.nodes.length);
    expect(scene.pages.length).toBe(built.pages?.length ?? 1);
    expect(scene.pages[0].id).toBe("page1");
  });

  it("renders a preview", () => {
    render(<TemplatePreview template={templateById(id)!} />);
    expect(screen.getByRole("img")).toBeInTheDocument();
  });
});

describe("the publishing templates", () => {
  it("the book: sheets with bleed, a master on the chapter pages, styles and a baseline grid", () => {
    const { scene } = applyTemplate("book");
    expect(scene.pages.map((p) => p.name)).toEqual(["Cover", "A-Master", "Chapter 1", "Page 2", "Page 3"]);
    expect(scene.pages.every((p) => p.width === 432 && p.height === 648)).toBe(true);
    expect(scene.pages[1].isMaster).toBe(true);
    expect(scene.pages.filter((p) => p.masterId === scene.pages[1].id).map((p) => p.name)).toEqual(["Chapter 1", "Page 2", "Page 3"]);
    expect(scene.pages[2]).toMatchObject({ bleed: 9, marginLeft: 54 });
    expect(scene.settings).toEqual({ vertical: "publishing", baselineIncrement: 16, baselineStart: 54 });
    expect(Object.values(scene.textStyles).map((d) => d.name).sort()).toEqual(["Body", "Body (first paragraph)", "Emphasis", "Folio", "Heading"]);
  });

  it("the book's master shows the right page number on each page", () => {
    const { scene } = applyTemplate("book");
    const out = resolveScene(scene);
    const page = (name: string) => scene.pages.find((p) => p.name === name)!;
    const folio = (name: string) => [...out.nodes.values()].find((n) => n.fromMaster && n.parentId === page(name).id && n.name === "Page number")!.text!.content;
    // The cover is page 1 and the master is not counted: Chapter 1 is page 2.
    expect([folio("Chapter 1"), folio("Page 2"), folio("Page 3")]).toEqual(["2", "3", "4"]);
    expect(out.nodes.get(masterCopyId(page("Page 2").id, [...scene.nodes.values()].find((n) => n.name === "Running head")!.id))).toBeDefined();
  });

  it("the book's chapter flows over its three linked frames, keeping its styles", () => {
    const { scene } = applyTemplate("book");
    const out = resolveScene(scene);
    const chains = chainsOf(out);
    expect(chains).toHaveLength(1);
    const frames = chains[0];
    expect(frames).toHaveLength(3);
    // The formatted story is laid out frame by frame: text reaches the second frame, with its styles.
    expect(frames[0].text!.content.length).toBeGreaterThan(0);
    expect(frames[1].text!.content.length).toBeGreaterThan(0);
    expect(frames[1].text!.rich).toBeDefined();
    expect(frames[2].overset).toBeUndefined();
    expect(frames[0].text!.rich!.paragraphs[0].alignToGrid).toBe(true);
    // No word is lost between the frames.
    const story = [...scene.nodes.values()].find((n) => n.name === "Story")!.text!.content;
    const flowed = frames.map((f) => f.text!.content).join(" ");
    expect(flowed.split(/\s+/).filter(Boolean)).toEqual(story.split(/\s+/).filter(Boolean));
  });

  it("the magazine has three columns and a six-frame article; the report one wide column", () => {
    const mag = applyTemplate("magazine").scene;
    expect(mag.pages[2]).toMatchObject({ width: 595, height: 842, columns: 3, gutter: 16 });
    expect(chainsOf(resolveScene(mag))[0]).toHaveLength(6);
    const rep = applyTemplate("report").scene;
    expect(rep.pages[0]).toMatchObject({ width: 612, height: 792 });
    expect(rep.pages[0].columns).toBeUndefined();
    expect(rep.settings?.baselineIncrement).toBe(18);
  });

  it("the blank publication is an A4 sheet with margins", () => {
    const { scene } = applyTemplate("blank-publishing");
    expect(scene.pages).toEqual([{ id: "page1", name: "Page 1", width: 595, height: 842, marginTop: 54, marginBottom: 54, marginLeft: 54, marginRight: 54 }]);
    expect(scene.nodes.size).toBe(0);
  });
});

describe("the design templates", () => {
  it("the poster is an A3 sheet with bleed, the brand sheet an open canvas", () => {
    expect(applyTemplate("poster").scene.pages[0]).toMatchObject({ width: 842, height: 1191, bleed: 9 });
    const brand = applyTemplate("brand-sheet").scene;
    expect(brand.pages[0].width).toBeUndefined();
    expect(brand.nodes.size).toBeGreaterThan(10);
    expect(applyTemplate("blank-design").scene.settings).toEqual({ vertical: "design" });
  });
});
