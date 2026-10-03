import { describe, it, expect, beforeEach, vi } from "vitest";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import { STACK_OFFSET, attachImageDrop, dropImages, type ImageDropDeps } from "./imageDrop";

// Il rilascio di un file SVG sul canvas: nodi modificabili, non un'immagine raster.
// (Il resto del rilascio -- PNG/JPEG/GIF/WebP -- è in imageDrop.test.ts.)

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><rect id="r" width="40" height="20"/><circle id="c" cx="70" cy="25" r="10"/></svg>`;

function installScene(): void {
  useScene.setState({ gesture: null, lastError: null, notice: null, selection: [] });
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
}

function nodes(): NodeLite[] {
  const s = useScene.getState().scene;
  return s ? [...s.nodes.values()] : [];
}

function deps(over: Partial<ImageDropDeps> = {}): ImageDropDeps {
  return {
    measure: async () => ({ width: 200, height: 100 }),
    upload: async () => ({ hash: HASH, size: 1234, contentType: "image/png" }),
    ...over,
  };
}

const svgFile = (name = "logo.svg", type = "image/svg+xml") => new File([SVG], name, { type });
const pngFile = (name = "a.png") => ({ name, type: "image/png", size: 10 }) as unknown as File;

describe("rilascio di un file SVG", () => {
  beforeEach(installScene);

  it("diventa un gruppo di nodi modificabili centrato sul punto, senza passare da misura e upload", async () => {
    const measure = vi.fn(async () => ({ width: 1, height: 1 }));
    const upload = vi.fn(async () => ({ hash: HASH, size: 1, contentType: "image/png" }));
    const ids = await dropImages([svgFile()], { x: 500, y: 300 }, deps({ measure, upload }));

    expect(measure).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(ids.length).toBe(1);
    const ns = nodes();
    expect(ns.map((n) => n.kind).sort()).toEqual(["ellipse", "group", "rect"]);
    expect(ns.find((n) => n.kind === "image")).toBeUndefined();
    const root = ns.find((n) => n.id === ids[0])!;
    // 100x50 centrato su (500,300)
    expect(root).toMatchObject({ kind: "group", name: "logo", x: 450, y: 275 });
    expect(useScene.getState().selection).toEqual([ids[0]]);
    expect(useScene.getState().notice).toBe("Importato come 3 livelli");
  });

  it("anche con tipo vuoto (estensione sola) e con la .SVG maiuscola", async () => {
    const ids = await dropImages([svgFile("A.SVG", "")], { x: 0, y: 0 }, deps());
    expect(ids.length).toBe(1);
    expect(nodes().some((n) => n.kind === "group")).toBe(true);
  });

  it("un rilascio = un annulla", async () => {
    await dropImages([svgFile()], { x: 0, y: 0 }, deps());
    expect(nodes().length).toBe(3);
    useScene.getState().undo();
    expect(nodes().length).toBe(0);
  });

  it("insieme a un PNG: l'SVG è nodi e il PNG segue la strada di sempre", async () => {
    const upload = vi.fn(async () => ({ hash: HASH, size: 1, contentType: "image/png" }));
    const ids = await dropImages([pngFile(), svgFile()], { x: 0, y: 0 }, deps({ upload }));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(ids.length).toBe(2);
    expect(nodes().filter((n) => n.kind === "image").length).toBe(1);
    expect(nodes().filter((n) => n.kind === "group").length).toBe(1);
  });

  it("più SVG: ciascuno il suo gruppo, scostati dello STACK_OFFSET", async () => {
    const ids = await dropImages([svgFile("a.svg"), svgFile("b.svg")], { x: 0, y: 0 }, deps());
    expect(ids.length).toBe(2);
    const [a, b] = ids.map((id) => nodes().find((n) => n.id === id)!);
    expect(b.x - a.x).toBe(STACK_OFFSET);
    expect(b.y - a.y).toBe(STACK_OFFSET);
  });

  it("un SVG rotto non butta via il rilascio: avviso e nessun nodo", async () => {
    const ids = await dropImages([new File(["<svg><rect></svg>"], "rotto.svg", { type: "image/svg+xml" })], { x: 0, y: 0 }, deps());
    expect(ids).toEqual([]);
    expect(nodes().length).toBe(0);
    expect(useScene.getState().notice).toMatch(/Importazione SVG non riuscita/);
  });

  it("il listener del canvas lo intercetta: preventDefault e import al punto in coordinate mondo", async () => {
    const handlers: Record<string, (e: Event) => void> = {};
    attachImageDrop(
      { addEventListener: (t, h) => { handlers[t] = h; }, removeEventListener: () => {} },
      () => ({ x: 200, y: 100 }),
      deps(),
    );
    const drop = { preventDefault: vi.fn(), dataTransfer: { files: [svgFile()], types: ["Files"] } };
    handlers.drop(drop as unknown as Event);
    expect(drop.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(nodes().length).toBe(3));
    expect(nodes().find((n) => n.kind === "group")).toMatchObject({ x: 150, y: 75 });
  });
});
