import { describe, expect, it } from "vitest";
import { layoutDiagram } from "./layout";
import { MermaidError, parseMermaid } from "./mermaid";
import { mermaidToSvg } from "./toSvg";

describe("parseMermaid", () => {
  it("legge direzione, forme ed etichette", () => {
    const d = parseMermaid(`flowchart LR
      A[Inizio] --> B{Valido?}
      B -->|sì| C([Fine])
      B -- no --> D((Errore))`);
    expect(d.direction).toBe("LR");
    expect(d.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ["A", "Inizio", "rect"], ["B", "Valido?", "diamond"], ["C", "Fine", "stadium"], ["D", "Errore", "circle"],
    ]);
    expect(d.edges.map((e) => [e.from, e.to, e.label])).toEqual([["A", "B", undefined], ["B", "C", "sì"], ["B", "D", "no"]]);
  });

  it("concatena archi, stili e gruppi con &", () => {
    const d = parseMermaid("graph TB\nA --> B -.-> C ==> D\nA & B --- E <--> F");
    expect(d.direction).toBe("TD");
    expect(d.edges.slice(0, 3).map((e) => [e.style, e.arrowEnd])).toEqual([["solid", true], ["dotted", true], ["thick", true]]);
    const rest = d.edges.slice(3);
    expect(rest.map((e) => `${e.from}>${e.to}`)).toEqual(["A>E", "B>E", "E>F"]);
    expect(rest[0].arrowEnd).toBe(false);
    expect(rest[2]).toMatchObject({ arrowStart: true, arrowEnd: true });
  });

  it("una dichiarazione tardiva dà forma a un riferimento nudo e i commenti si ignorano", () => {
    const d = parseMermaid("flowchart TD\nA --> B %% commento\nB[Fine]\nstyle A fill:#f9f\nsubgraph x\nend");
    expect(d.nodes.find((n) => n.id === "B")!.label).toBe("Fine");
    expect(d.nodes).toHaveLength(2);
  });

  it("id con trattino e <br/> nelle etichette", () => {
    const d = parseMermaid('graph TD\nmy-x["riga1<br/>riga2"] --> b');
    expect(d.nodes[0]).toMatchObject({ id: "my-x", label: "riga1\nriga2" });
  });

  it("rifiuta ciò che non è un flowchart o è vuoto", () => {
    expect(() => parseMermaid("sequenceDiagram\nA->>B: hi")).toThrow(MermaidError);
    expect(() => parseMermaid("")).toThrow(MermaidError);
    expect(() => parseMermaid("graph TD\nA --> ")).toThrow(MermaidError);
  });
});

describe("layoutDiagram", () => {
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it("mette i livelli nell'ordine del flusso e non sovrappone i nodi", () => {
    const l = layoutDiagram(parseMermaid("graph TD\nA-->B\nA-->C\nB-->D\nC-->D\nA-->D"));
    const y = (id: string) => l.nodes.find((n) => n.id === id)!.y;
    expect(y("A")).toBeLessThan(y("B"));
    expect(y("B")).toBeLessThan(y("D"));
    expect(y("B")).toBe(y("C"));
    for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) expect(overlap(l.nodes[i], l.nodes[j])).toBe(false);
  });

  it("LR, RL e BT ribaltano gli assi", () => {
    const x = (dir: string, id: string) => layoutDiagram(parseMermaid(`graph ${dir}\nA-->B`)).nodes.find((n) => n.id === id)!;
    expect(x("LR", "A").x).toBeLessThan(x("LR", "B").x);
    expect(x("RL", "A").x).toBeGreaterThan(x("RL", "B").x);
    expect(x("BT", "A").y).toBeGreaterThan(x("BT", "B").y);
  });

  it("regge cicli, auto-anelli e archi che saltano livelli", () => {
    const l = layoutDiagram(parseMermaid("graph TD\nA-->B\nB-->C\nC-->A\nB-->B\nA-->C"));
    expect(l.nodes).toHaveLength(3);
    const back = l.edges.find((e) => e.from === "C" && e.to === "A")!;
    expect(back.points.length).toBeGreaterThanOrEqual(2);
    const loop = l.edges.find((e) => e.from === "B" && e.to === "B")!;
    expect(loop.points).toHaveLength(4);
    for (const e of l.edges) for (const p of e.points) expect(Number.isFinite(p.x + p.y)).toBe(true);
  });

  it("è deterministico", () => {
    const src = "graph LR\nA-->B\nA-->C\nB-->D\nC-->D";
    expect(mermaidToSvg(src)).toBe(mermaidToSvg(src));
  });
});

describe("mermaidToSvg", () => {
  it("produce un SVG con una forma per nodo, il testo e le punte", () => {
    const svg = mermaidToSvg("graph TD\nA[Start] --> B{Ok?}\nB -->|sì| C((End))");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(">Start</text>");
    expect(svg).toContain(">sì</text>");
    expect(svg).toContain("<ellipse");
    expect((svg.match(/fill="#475569"\/>/g) ?? []).length).toBe(2);
    expect(svg).not.toContain("marker");
  });

  it("esegue l'escape del testo", () => {
    expect(mermaidToSvg('graph TD\nA["a < b & c"]')).toContain("a &lt; b &amp; c");
  });
});

describe("SVG prodotto", () => {
  it("è XML ben formato", () => {
    const svg = mermaidToSvg('graph LR\nA["x & y"] -- "a<b" --> B{c}\nB -.-> A\nB --> B');
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelectorAll("text").length).toBe(3);
  });
});
