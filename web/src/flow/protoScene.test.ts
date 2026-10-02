import { describe, it, expect } from "vitest";
import { PROTO_PAGE_ID, sceneForScreen } from "./protoScene";
import { baseScene } from "./testSupport";
import { topLevelScreens } from "./screens";
import { sceneIndexOf } from "../renderer/sceneIndex";
import { rootsOf } from "../renderer/canvasRenderer";

describe("sceneForScreen", () => {
  const s = baseScene();

  it("la scena derivata ha UNA pagina e UNA sola radice: la schermata scelta", () => {
    const d = sceneForScreen(s, "B")!;
    expect(d.pages).toEqual([{ id: PROTO_PAGE_ID, name: "Prototipo" }]);
    const roots = rootsOf(d, sceneIndexOf(d).children, PROTO_PAGE_ID);
    expect(roots.map((n) => n.id)).toEqual(["B"]);
    // le altre schermate non sono raggiungibili: nessuna pagina le contiene
    expect(topLevelScreens(d, PROTO_PAGE_ID).map((n) => n.id)).toEqual(["B"]);
  });

  it("i figli della schermata restano al loro posto", () => {
    const d = sceneForScreen(s, "A")!;
    expect(d.nodes.at("btn").parentId).toBe("A");
  });

  it("non muta la scena di partenza", () => {
    sceneForScreen(s, "B");
    expect(s.nodes.at("B").parentId).toBe("page1");
    expect(s.pages.map((p) => p.id)).toEqual(["page1"]);
  });

  it("è memoizzata sull'ultima coppia (scena, schermata)", () => {
    expect(sceneForScreen(s, "A")).toBe(sceneForScreen(s, "A"));
    expect(sceneForScreen(s, "A")).not.toBe(sceneForScreen(s, "B"));
  });

  it("schermata inesistente: null; schermata nascosta: la si mostra comunque", () => {
    expect(sceneForScreen(s, "ghost")).toBeNull();
    const hidden = { ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), visible: false }) };
    expect(sceneForScreen(hidden, "A")!.nodes.at("A").visible).toBe(true);
  });
});
