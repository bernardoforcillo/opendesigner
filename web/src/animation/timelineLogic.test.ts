import { describe, it, expect } from "vitest";
import type { ClipLite } from "../store/types";
import { baseScene, child } from "../flow/testSupport";
import { nodesWith } from "../store/nodeMap";
import { isValidClip } from "./validate";

const SCENE = baseScene();
const valid = (c: ClipLite) => isValidClip(SCENE, c);
import {
  SNAP_MS, addKeyframe, addPropertyTrack, addTrack, clipsForSelection, defaultTargetId, deleteKeyframes, dragDelta,
  duplicateKeyframes, formatClock, formatTime, isInside, moveKeyframes, propsFor, recordChanges, removeTrack, rulerStep,
  rulerTicks, snapTime, unwrapDegrees, updateKeyframe, valueAt, withDuration, type KeyRef,
} from "./timelineLogic";

const clip = (over: Partial<ClipLite> = {}): ClipLite => ({
  id: "k", name: "k", duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "A",
  tracks: [
    { nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0, easing: "" }, { time: 400, value: 0.5, easing: "easeOut" }, { time: 1000, value: 1, easing: "" }] },
    { nodeId: "btn", prop: "x", keyframes: [{ time: 200, value: 10, easing: "" }, { time: 600, value: 50, easing: "" }] },
  ],
  ...over,
});
const times = (c: ClipLite, ti: number) => c.tracks[ti].keyframes.map((k) => k.time);
const ref = (track: number, key: number): KeyRef => ({ track, key });

describe("snapTime", () => {
  // [t, others, opts, atteso]
  const table: [number, number[], { free?: boolean; thresholdMs?: number }, number][] = [
    [123, [], {}, 120],
    [126, [], {}, 130],
    [123, [128], {}, 128], // un altro keyframe entro la soglia vince sulla griglia
    [123, [140], {}, 120], // fuori soglia: griglia
    [123, [128, 126], {}, 126], // il più vicino fra più bersagli
    [123, [], { free: true }, 123],
    [123.4, [128], { free: true }, 123], // libero: niente aggancio, arrotondato al ms
    [-50, [], {}, 0],
    [5000, [], {}, 1000],
    [123, [140], { thresholdMs: 30 }, 140],
  ];
  it.each(table)("snapTime(%f, %j, %j) = %f", (t, others, opts, want) => {
    expect(snapTime(t, 1000, others, opts)).toBe(want);
  });
});

describe("moveKeyframes (trascinamento)", () => {
  it("sposta un keyframe; il risultato è una clip valida", () => {
    const r = moveKeyframes(clip(), [ref(0, 1)], 300); // 400 -> 700
    expect(times(r.clip, 0)).toEqual([0, 700, 1000]);
    expect(r.clip.tracks[0].keyframes[1].value).toBe(0.5);
    expect(valid(r.clip)).toBe(true);
  });

  it("oltre la fine il delta si limita e il keyframe in fondo viene sostituito", () => {
    const r = moveKeyframes(clip(), [ref(0, 1)], 700); // 400 -> 1100: limite 600, atterra su 1000
    expect(times(r.clip, 0)).toEqual([0, 1000]);
    expect(r.clip.tracks[0].keyframes[1].value).toBe(0.5);
  });

  it("non esce da [0, durata]: il delta si limita", () => {
    const r = moveKeyframes(clip(), [ref(1, 0), ref(1, 1)], 900);
    expect(times(r.clip, 1)).toEqual([600, 1000]); // il gruppo si ferma quando l'ultimo tocca la fine
    const l = moveKeyframes(clip(), [ref(1, 0), ref(1, 1)], -900);
    expect(times(l.clip, 1)).toEqual([0, 400]);
  });

  it("un gruppo si muove dello stesso passo (le distanze restano)", () => {
    const r = moveKeyframes(clip(), [ref(0, 0), ref(1, 0)], 100);
    expect(times(r.clip, 0)).toEqual([100, 400, 1000]);
    expect(times(r.clip, 1)).toEqual([300, 600]);
    expect(r.sel).toEqual([ref(0, 0), ref(1, 0)]);
  });

  it("scavalcare un altro keyframe riordina e aggiorna la selezione", () => {
    const r = moveKeyframes(clip(), [ref(0, 0)], 500); // 0 -> 500, supera 400
    expect(times(r.clip, 0)).toEqual([400, 500, 1000]);
    expect(r.sel).toEqual([ref(0, 1)]);
  });

  it("atterrare su un keyframe NON selezionato lo sostituisce", () => {
    const r = moveKeyframes(clip(), [ref(0, 0)], 400);
    expect(times(r.clip, 0)).toEqual([400, 1000]);
    expect(r.clip.tracks[0].keyframes[0].value).toBe(0); // il valore è quello del keyframe spostato
    expect(r.sel).toEqual([ref(0, 0)]);
  });

  it("delta 0 o selezione vuota: la stessa clip", () => {
    const c = clip();
    expect(moveKeyframes(c, [ref(0, 0)], 0).clip).toBe(c);
    expect(moveKeyframes(c, [], 50).clip).toBe(c);
  });

  it("non muta la clip di partenza", () => {
    const c = clip();
    const before = JSON.stringify(c);
    moveKeyframes(c, [ref(0, 1)], 100);
    expect(JSON.stringify(c)).toBe(before);
  });
});

describe("dragDelta: aggancio durante il trascinamento", () => {
  it("alla griglia", () => {
    expect(dragDelta(clip(), [ref(0, 1)], ref(0, 1), 33)).toBe(30); // 400 + 33 = 433 -> 430
  });
  it("agli altri keyframe (non a quelli del gruppo che si muove)", () => {
    // il keyframe a 400 della traccia 0 verso 600 (il keyframe 1 della traccia x): aggancia a 600 anche a 596
    expect(dragDelta(clip(), [ref(0, 1)], ref(0, 1), 196)).toBe(200);
  });
  it("Maiusc = libero", () => {
    expect(dragDelta(clip(), [ref(0, 1)], ref(0, 1), 33, { free: true })).toBe(33);
  });
  it("ai bersagli extra (il playhead)", () => {
    expect(dragDelta(clip(), [ref(0, 1)], ref(0, 1), 96, { extra: [500] })).toBe(100);
  });
  it("un riferimento inesistente non muove niente", () => {
    expect(dragDelta(clip(), [ref(9, 9)], ref(9, 9), 50)).toBe(0);
  });
});

describe("aggiungere / cancellare / duplicare keyframe", () => {
  it("addKeyframe inserisce in ordine con il valore dato", () => {
    const r = addKeyframe(clip(), 1, 400, 30);
    expect(times(r.clip, 1)).toEqual([200, 400, 600]);
    expect(r.ref).toEqual(ref(1, 1));
    expect(r.clip.tracks[1].keyframes[1].value).toBe(30);
    expect(valid(r.clip)).toBe(true);
  });
  it("a un tempo già occupato cambia il valore invece di raddoppiare", () => {
    const r = addKeyframe(clip(), 1, 200, 99);
    expect(r.clip.tracks[1].keyframes).toHaveLength(2);
    expect(r.clip.tracks[1].keyframes[0].value).toBe(99);
  });
  it("tiene opacity e draw in 0..1 e il tempo dentro la durata", () => {
    const r = addKeyframe(clip(), 0, 5000, 7);
    const last = r.clip.tracks[0].keyframes.at(-1)!;
    expect(last.time).toBe(1000);
    expect(last.value).toBe(1);
  });
  it("deleteKeyframes toglie i selezionati e la traccia che resta vuota", () => {
    const c = deleteKeyframes(clip(), [ref(1, 0), ref(1, 1), ref(0, 1)]);
    expect(c.tracks).toHaveLength(1);
    expect(times(c, 0)).toEqual([0, 1000]);
    expect(valid(c)).toBe(true);
  });
  it("duplicateKeyframes: la copia del primo cade al tempo dato, gli altri tengono le distanze", () => {
    const r = duplicateKeyframes(clip(), [ref(1, 0), ref(1, 1)], 500);
    // 200 -> 500, 600 -> 900; i vecchi 200 e 600 restano
    expect(times(r.clip, 1)).toEqual([200, 500, 600, 900]);
    expect(r.sel.map((s) => r.clip.tracks[s.track].keyframes[s.key].time)).toEqual([500, 900]);
    expect(valid(r.clip)).toBe(true);
  });
  it("la copia si porta dentro la durata", () => {
    const r = duplicateKeyframes(clip(), [ref(1, 0), ref(1, 1)], 900); // la coppia è larga 400: finirebbe a 1300
    expect(Math.max(...times(r.clip, 1))).toBe(1000);
  });
  it("una copia che cade su un keyframe lo sostituisce", () => {
    const r = duplicateKeyframes(clip(), [ref(1, 0)], 600);
    expect(times(r.clip, 1)).toEqual([200, 600]);
    expect(r.clip.tracks[1].keyframes[1].value).toBe(10);
  });
});

describe("updateKeyframe", () => {
  it("cambia valore ed easing senza spostarlo", () => {
    const r = updateKeyframe(clip(), ref(0, 1), { value: 0.9, easing: "cubic-bezier(0.1,0.2,0.3,0.4)" });
    expect(r.clip.tracks[0].keyframes[1]).toEqual({ time: 400, value: 0.9, easing: "cubic-bezier(0.1,0.2,0.3,0.4)" });
    expect(r.ref).toEqual(ref(0, 1));
    expect(valid(r.clip)).toBe(true);
  });
  it("cambiare il tempo riordina e rifiuta valori fuori limite", () => {
    const r = updateKeyframe(clip(), ref(0, 0), { time: 700, value: 4 });
    expect(times(r.clip, 0)).toEqual([400, 700, 1000]);
    expect(r.clip.tracks[0].keyframes[1].value).toBe(1);
    expect(r.ref).toEqual(ref(0, 1));
  });
});

describe("tracce e durata", () => {
  it("addTrack non duplica la coppia (nodo, proprietà)", () => {
    const c = clip();
    expect(addTrack(c, "btn", "x", 0)).toBe(c);
    const n = addTrack(c, "btn", "y", 5, 300);
    expect(n.tracks).toHaveLength(3);
    expect(n.tracks[2].keyframes).toEqual([{ time: 300, value: 5, easing: "easeInOut" }]);
  });
  it("addPropertyTrack: due keyframe col valore di base (draw va da 0 a 1)", () => {
    const base = { id: "btn", x: 60, y: 200, rotation: 0, opacity: 0.8 };
    const o = addPropertyTrack(clip({ tracks: [] }), base, "opacity");
    expect(o.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[0, 0.8], [1000, 0.8]]);
    const d = addPropertyTrack(clip({ tracks: [] }), base, "draw");
    expect(d.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[0, 0], [1000, 1]]);
    const s = addPropertyTrack(clip({ tracks: [] }), base, "scale");
    expect(s.tracks[0].keyframes.map((k) => k.value)).toEqual([1, 1]);
    expect(valid(o)).toBe(true);
  });
  it("removeTrack", () => {
    expect(removeTrack(clip(), 0).tracks.map((t) => t.prop)).toEqual(["x"]);
  });
  it("withDuration riporta alla fine i keyframe che la superano e resta valida", () => {
    const c = withDuration(clip(), 500);
    expect(c.duration).toBe(500);
    expect(times(c, 0)).toEqual([0, 400, 500]);
    expect(valid(c)).toBe(true);
    const d = withDuration(clip({ tracks: [{ nodeId: "btn", prop: "x", keyframes: [{ time: 800, value: 1, easing: "" }, { time: 900, value: 2, easing: "" }] }] }), 500);
    expect(d.tracks[0].keyframes).toEqual([{ time: 500, value: 2, easing: "" }]);
  });
  it("valueAt campiona la traccia (con l'easing)", () => {
    expect(valueAt(clip(), 1, 400)).toBeCloseTo(30);
    expect(valueAt(clip(), 5, 0)).toBeUndefined();
  });
  it("propsFor: draw solo per i nodi con un tracciato", () => {
    expect(propsFor({ kind: "text" })).not.toContain("draw");
    expect(propsFor({ kind: "vector" })).toContain("draw");
    expect(propsFor({ kind: "group" })).toEqual(["opacity", "x", "y", "scale", "rotation"]);
  });
});

describe("recordChanges (mappa le modifiche in keyframe al playhead)", () => {
  const before = (_id: string, prop: string) => ({ x: 60, y: 200, opacity: 1, rotation: 0 })[prop as "x"];

  it("traccia nuova a t > 0: keyframe a 0 col valore di prima + keyframe a t col nuovo", () => {
    const r = recordChanges(clip({ tracks: [] }), [{ nodeId: "btn", prop: "x", value: 300 }], 600, before);
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[0, 60], [600, 300]]);
    expect(valid(r)).toBe(true);
  });
  it("traccia nuova a t = 0: un solo keyframe", () => {
    const r = recordChanges(clip({ tracks: [] }), [{ nodeId: "btn", prop: "x", value: 300 }], 0, before);
    expect(r.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[0, 300]]);
  });
  it("traccia esistente: inserisce il keyframe, o cambia quello che c'è già a quel tempo", () => {
    const a = recordChanges(clip(), [{ nodeId: "btn", prop: "x", value: 99 }], 400, before);
    expect(a.tracks[1].keyframes.map((k) => [k.time, k.value])).toEqual([[200, 10], [400, 99], [600, 50]]);
    const b = recordChanges(clip(), [{ nodeId: "btn", prop: "x", value: 99 }], 600, before);
    expect(b.tracks[1].keyframes.map((k) => [k.time, k.value])).toEqual([[200, 10], [600, 99]]);
  });
  it("più proprietà in un colpo sono tracce separate; il tempo si arrotonda e si limita", () => {
    const r = recordChanges(clip({ tracks: [] }), [
      { nodeId: "btn", prop: "x", value: 1 }, { nodeId: "btn", prop: "y", value: 2 }, { nodeId: "btn", prop: "opacity", value: 3 },
    ], 333.6, before);
    expect(r.tracks.map((t) => t.prop)).toEqual(["x", "y", "opacity"]);
    expect(r.tracks.every((t) => t.keyframes[1].time === 334)).toBe(true);
    expect(r.tracks[2].keyframes[1].value).toBe(1); // opacity limitata
    expect(valid(r)).toBe(true);
  });
  it("valore di prima sconosciuto: un solo keyframe a t", () => {
    const r = recordChanges(clip({ tracks: [] }), [{ nodeId: "btn", prop: "x", value: 5 }], 500, () => undefined);
    expect(r.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[500, 5]]);
  });
});

describe("unwrapDegrees", () => {
  const table: [number, number, number][] = [
    [10, 350, 370], // dopo 350° si arriva a 10° avanzando: 370
    [350, 10, -10],
    [90, 80, 90],
    [0, 720, 720],
    [30, 30, 30],
  ];
  it.each(table)("unwrapDegrees(%f, %f) = %f", (deg, ref, want) => expect(unwrapDegrees(deg, ref)).toBe(want));
});

describe("righello", () => {
  it("il passo cresce quando si rimpicciolisce", () => {
    expect(rulerStep(1)).toBe(100); // 1 px/ms: 100 ms = 100 px >= 64
    expect(rulerStep(0.1)).toBe(1000);
    expect(rulerStep(10)).toBe(10);
    expect(rulerStep(0.0001)).toBe(300_000);
  });
  it("le tacche coprono l'intervallo e i principali cadono sui multipli del passo", () => {
    const ticks = rulerTicks(0.5, 0, 1000); // passo 200
    expect(ticks[0]).toEqual({ t: 0, major: true });
    expect(ticks.filter((t) => t.major).map((t) => t.t)).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(ticks.at(-1)!.t).toBeLessThanOrEqual(1000 + 1e-6);
  });
  it("formati", () => {
    expect(formatTime(250)).toBe("250 ms");
    expect(formatTime(1200)).toBe("1,2 s");
    expect(formatTime(65_000)).toBe("1:05");
    expect(formatClock(1250)).toBe("0:01.250");
    expect(formatClock(-5)).toBe("0:00.000");
  });
});

describe("bersaglio e selezione", () => {
  const scene = () => {
    const s = baseScene();
    return {
      ...s,
      nodes: nodesWith(s.nodes, {
        grp: { ...child("grp", "A", 0, 0), kind: "group" },
        inner: child("inner", "grp", 5, 5),
      }),
    };
  };
  it("defaultTargetId: il contenitore più vicino (il nodo stesso se lo è)", () => {
    const s = scene();
    expect(defaultTargetId(s, ["btn"])).toBe("A");
    expect(defaultTargetId(s, ["inner"])).toBe("grp");
    expect(defaultTargetId(s, ["A"])).toBe("A");
    expect(defaultTargetId(s, ["loose"])).toBe("loose"); // senza contenitori: il nodo stesso
    expect(defaultTargetId(s, [])).toBe("");
  });
  it("isInside", () => {
    const s = scene();
    expect(isInside(s, "inner", "A")).toBe(true);
    expect(isInside(s, "A", "A")).toBe(true);
    expect(isInside(s, "btn", "B")).toBe(false);
  });
  it("clipsForSelection: per bersaglio o per traccia; selezione vuota = tutte", () => {
    const s = scene();
    const ca = clip({ id: "ca", name: "a", targetId: "A", tracks: [] });
    const cb = clip({ id: "cb", name: "b", targetId: "B", tracks: [] });
    const cl = clip({ id: "cl", name: "c", targetId: "B", tracks: [{ nodeId: "btn", prop: "x", keyframes: [{ time: 0, value: 1, easing: "" }] }] });
    const withClips = { ...s, clips: { ca, cb, cl } };
    expect(clipsForSelection(withClips, []).map((c) => c.id)).toEqual(["ca", "cb", "cl"]);
    expect(clipsForSelection(withClips, ["btn"]).map((c) => c.id)).toEqual(["ca", "cl"]);
    expect(clipsForSelection(withClips, ["inner"]).map((c) => c.id)).toEqual(["ca"]);
  });
});

describe("costanti", () => {
  it("la griglia è 10 ms", () => expect(SNAP_MS).toBe(10));
});
