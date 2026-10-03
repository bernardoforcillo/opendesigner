import { describe, it, expect } from "vitest";
import { baseScene, child } from "../flow/testSupport";
import { nodesWith } from "../store/nodeMap";
import { sceneIndexOf, buildIndex } from "../renderer/sceneIndex";
import { worldTransformOf } from "../canvas/transform";
import type { SceneState } from "../store/types";
import { canDraw, mergeAnim, poseScene, sampleWithDraft } from "./pose";
import type { NodeAnim } from "./engine";

const anim = (o: Record<string, NodeAnim>) => new Map(Object.entries(o));

function scene(): SceneState {
  const s = baseScene();
  return {
    ...s,
    nodes: nodesWith(s.nodes, {
      grp: { ...child("grp", "A", 0, 0), kind: "group", width: 0, height: 0 },
      g1: child("g1", "grp", 10, 20),
      g2: child("g2", "grp", 110, 20),
      vec: { ...child("vec", "A", 0, 100), kind: "vector", vector: { subpaths: [] } },
      txt: { ...child("txt", "A", 0, 150), kind: "text" },
    }),
  };
}

describe("poseScene", () => {
  it("niente da animare (o valori uguali alla base): la STESSA scena", () => {
    const s = scene();
    expect(poseScene(s, anim({}))).toBe(s);
    expect(poseScene(s, anim({ btn: { x: 60, y: 200, opacity: 1, rotation: 0 } }))).toBe(s);
    expect(poseScene(s, anim({ gone: { x: 5 } }))).toBe(s);
    expect(poseScene(s, anim({ btn: { scale: 1 } }))).toBe(s);
  });

  it("x, y, rotation, opacity diventano campi veri del nodo, senza toccare la scena di base", () => {
    const s = scene();
    const p = poseScene(s, anim({ btn: { x: 5, y: 6, rotation: 45, opacity: 0.25 } }));
    expect(p).not.toBe(s);
    const n = p.nodes.at("btn");
    expect([n.x, n.y, n.rotation, n.opacity]).toEqual([5, 6, 45, 0.25]);
    expect(s.nodes.at("btn").x).toBe(60); // il documento non cambia
    expect(p.nodes.at("btn").animScale).toBeUndefined();
    expect(p.nodes.at("B")).toBe(s.nodes.at("B")); // i nodi non toccati restano gli stessi oggetti
  });

  it("scale e draw vanno nei campi transitori; draw solo dove c'è un tracciato", () => {
    const s = scene();
    const p = poseScene(s, anim({ btn: { scale: 1.5, draw: 0.4 }, vec: { draw: 0.5 }, txt: { draw: 0.5 } }));
    expect(p.nodes.at("btn").animScale).toBe(1.5);
    expect(p.nodes.at("btn").animDraw).toBe(0.4);
    expect(p.nodes.at("vec").animDraw).toBe(0.5);
    expect(p.nodes.at("txt")).toBe(s.nodes.at("txt")); // un testo ignora draw
    expect(p.anim?.hasDraw).toBe(true);
    expect(p.anim?.scaled.has("btn")).toBe(true);
    expect([...p.anim!.ancestors]).toEqual(["A"]);
  });

  it("draw = 1 è il tracciato intero: non obbliga il renderer GPU a ripiegare", () => {
    const s = scene();
    expect(poseScene(s, anim({ vec: { draw: 1 } })).anim?.hasDraw).toBe(false);
    expect(poseScene(s, anim({ vec: { draw: 0.99 } })).anim?.hasDraw).toBe(true);
  });

  it("il perno della scala di un GRUPPO è il centro dei suoi contenuti e segue x/y animati", () => {
    const s = scene();
    const p = poseScene(s, anim({ grp: { scale: 2 } }));
    // i figli coprono x 10..190, y 20..50: centro (100, 35) nello spazio del parent (A, a 0,0)
    expect(p.nodes.at("grp").animPivot).toEqual({ x: 100, y: 35 });
    const moved = poseScene(s, anim({ grp: { scale: 2, x: 30 } }));
    expect(moved.nodes.at("grp").animPivot).toEqual({ x: 130, y: 35 });
  });

  it("la scala entra nella trasformazione dei figli, attorno al centro", () => {
    const s = scene();
    const p = poseScene(s, anim({ A: { scale: 2 } }));
    // A è 200x300 a (0,0): scala 2 attorno a (100,150). L'angolo (0,0) dei figli va a (-100,-150).
    const t = worldTransformOf(p, "A");
    expect(t.a).toBe(2);
    expect(t.e).toBe(-100);
    expect(t.f).toBe(-150);
  });

  it("la provenienza registrata fa aggiornare l'indice senza ricostruirlo e dà extent giusti a x/y", () => {
    const s = scene();
    const base = sceneIndexOf(s);
    const p = poseScene(s, anim({ btn: { x: 500, y: 400 } }));
    const idx = sceneIndexOf(p);
    const fresh = buildIndex(p);
    expect(idx.extent.get("btn")).toEqual(fresh.extent.get("btn"));
    expect(idx.extent.get("btn")).not.toEqual(base.extent.get("btn"));
    expect(sceneIndexOf(s)).toBe(base); // la scena di base ha ancora il suo indice
  });
});

describe("sampleWithDraft / mergeAnim", () => {
  it("la bozza vince sul campionamento, proprietà per proprietà", () => {
    const clip = { tracks: [{ nodeId: "btn", prop: "x", keyframes: [{ time: 0, value: 10, easing: "" }] }, { nodeId: "btn", prop: "y", keyframes: [{ time: 0, value: 20, easing: "" }] }] };
    const m = sampleWithDraft(clip, 0, anim({ btn: { x: 99 } }));
    expect(m.get("btn")).toEqual({ x: 99, y: 20 });
    expect(sampleWithDraft(clip, 0, null).get("btn")).toEqual({ x: 10, y: 20 });
  });
  it("mergeAnim: le ultime vincono, non muta la sorgente", () => {
    const src = anim({ a: { x: 1 } });
    const dst = mergeAnim(anim({ a: { x: 0, y: 5 } }), src);
    expect(dst.get("a")).toEqual({ x: 1, y: 5 });
    dst.get("a")!.x = 77;
    expect(src.get("a")!.x).toBe(1);
  });
  it("canDraw", () => {
    expect(["vector", "rect", "ellipse", "frame"].every((kind) => canDraw({ kind: kind as never }))).toBe(true);
    expect(["text", "image", "group", "instance"].some((kind) => canDraw({ kind: kind as never }))).toBe(false);
  });
});
