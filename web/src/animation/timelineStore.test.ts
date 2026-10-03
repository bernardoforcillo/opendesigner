import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { baseScene } from "../flow/testSupport";
import { useScene } from "../store/store";
import type { ClipLite, SceneState } from "../store/types";
import { makeSetPropsOp } from "../tools/ops";
import { recordFinal, recordPreview, propChangesOfOps, setRecordHook } from "./recordHook";
import {
  addPropertyTracks, commitClip, createClip, duplicateClipOp, removeClip, useTimeline,
} from "./timelineStore";
import { isPosing, posedScene } from "./posedScene";
import { isValidClip } from "./validate";

const clip = (over: Partial<ClipLite> = {}): ClipLite => ({
  id: "k", name: "k", duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "A",
  tracks: [{ nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0, easing: "" }, { time: 1000, value: 1, easing: "" }] }],
  ...over,
});

function install(s: SceneState = { ...baseScene(), clips: { k: clip() } }) {
  useScene.setState({ undoStack: [], redoStack: [], gesture: null, sync: null, selection: [] });
  useScene.getState().setScene(s);
}
const sc = () => useScene.getState().scene!;
const tl = () => useTimeline.getState();

beforeEach(() => {
  setRecordHook(null);
  useTimeline.setState({
    open: false, clipId: null, playhead: 0, playing: false, loop: false, speed: 1, record: false, posed: false,
    zoom: 1, selection: [], draftClip: null, recordDraft: null, collapsed: false,
  });
  install();
});
afterEach(() => {
  tl().setOpen(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("registrazione OFF: il gancio non c'è e niente cambia", () => {
  it("le due porte sono l'identità", () => {
    const ops = [makeSetPropsOp("btn", { x: 5 }, ["x"])];
    expect(recordPreview(ops[0])).toBe(false);
    expect(recordFinal(ops)).toBe(ops); // lo STESSO array
  });

  it("un trascinamento normale cambia il nodo, non la clip", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(makeSetPropsOp("btn", { x: 300, y: 7 }, ["x", "y"]));
    expect(sc().nodes.at("btn").x).toBe(300);
    st.endGesture([makeSetPropsOp("btn", { x: 300, y: 7 }, ["x", "y"])]);
    expect(sc().nodes.at("btn").x).toBe(300);
    expect(sc().clips.k).toEqual(clip());
  });

  it("anche con la clip aperta, finché Registra è spento", () => {
    tl().openClip("k");
    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([makeSetPropsOp("btn", { x: 300 }, ["x"])]);
    expect(sc().nodes.at("btn").x).toBe(300);
    expect(sc().clips.k.tracks).toHaveLength(1);
  });
});

describe("propChangesOfOps", () => {
  const sp = (paths: string[], patch: object = { x: 1, y: 2, rotation: 3, opacity: 0.5 }) =>
    makeSetPropsOp("n", patch, paths as never);
  it("registrabili: setProps con la sola mask x/y/rotation/opacity", () => {
    expect(propChangesOfOps([sp(["x", "y"])])).toEqual([{ nodeId: "n", prop: "x", value: 1 }, { nodeId: "n", prop: "y", value: 2 }]);
    expect(propChangesOfOps([sp(["opacity"])])).toEqual([{ nodeId: "n", prop: "opacity", value: 0.5 }]);
    expect(propChangesOfOps([sp(["x", "y", "rotation"])])).toHaveLength(3);
  });
  it("tutto o niente: basta un campo non registrabile", () => {
    expect(propChangesOfOps([sp(["x", "width"], { x: 1, width: 5 })])).toBeNull();
    expect(propChangesOfOps([sp(["x"]), sp(["height"], { height: 3 })])).toBeNull();
    expect(propChangesOfOps([])).toBeNull();
  });
});

describe("registrazione ON", () => {
  beforeEach(() => {
    tl().openClip("k");
    tl().setPlayhead(600);
    tl().setRecord(true);
  });

  it("l'anteprima va nella bozza e non tocca il nodo; la tela mostra la bozza", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(makeSetPropsOp("btn", { x: 300, y: 70 }, ["x", "y"]));
    expect(sc().nodes.at("btn").x).toBe(60);
    expect(tl().recordDraft?.get("btn")).toEqual({ x: 300, y: 70 });
    expect(posedScene()!.nodes.at("btn").x).toBe(300);
    expect(isPosing()).toBe(true);
  });

  it("il rilascio scrive UN SetClip: keyframe al playhead (con il punto di partenza a 0) e nodo intatto", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(makeSetPropsOp("btn", { x: 300, y: 70 }, ["x", "y"]));
    st.endGesture([makeSetPropsOp("btn", { x: 300, y: 70 }, ["x", "y"])]);
    const c = sc().clips.k;
    const x = c.tracks.find((t) => t.prop === "x")!;
    expect(x.keyframes.map((k) => [k.time, k.value])).toEqual([[0, 60], [600, 300]]);
    expect(c.tracks.find((t) => t.prop === "y")!.keyframes.map((k) => [k.time, k.value])).toEqual([[0, 200], [600, 70]]);
    expect(sc().nodes.at("btn").x).toBe(60);
    expect(isValidClip(sc(), c)).toBe(true);
    expect(tl().recordDraft).toBeNull();
    // un solo passo di undo per tutto il gesto
    expect(useScene.getState().undoStack).toHaveLength(1);
    useScene.getState().undo();
    expect(sc().clips.k).toEqual(clip());
  });

  it("opacità: registra sulla traccia esistente senza toccare gli altri keyframe", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([makeSetPropsOp("btn", { opacity: 0.2 }, ["opacity"])]);
    expect(sc().clips.k.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[0, 0], [600, 0.2], [1000, 1]]);
  });

  it("la rotazione non scavalca lo 0/360: registra la determinazione che non salta", () => {
    useTimeline.getState().setPlayhead(0);
    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([makeSetPropsOp("btn", { rotation: 350 }, ["rotation"])]);
    useTimeline.getState().setPlayhead(500);
    st.beginGesture();
    st.endGesture([makeSetPropsOp("btn", { rotation: 10 }, ["rotation"])]);
    const rot = sc().clips.k.tracks.find((t) => t.prop === "rotation")!;
    // 0 -> 350 è un passo di -10 (il più breve), poi 10 è +20 avanti: mai un giro intero a ritroso
    expect(rot.keyframes.map((k) => k.value)).toEqual([-10, 10]);
  });

  it("un gesto con altro dentro (resize) passa com'è: il nodo cambia e la clip no", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([makeSetPropsOp("btn", { x: 1, width: 99 }, ["x", "width"])]);
    expect(sc().nodes.at("btn").width).toBe(99);
    expect(sc().clips.k.tracks).toHaveLength(1);
  });

  it("un nodo FUORI dal bersaglio si modifica normalmente", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(makeSetPropsOp("loose", { x: 77 }, ["x"]));
    expect(sc().nodes.at("loose").x).toBe(77);
    st.endGesture([makeSetPropsOp("loose", { x: 77 }, ["x"])]);
    expect(sc().clips.k.tracks).toHaveLength(1);
  });

  it("Esc a metà gesto: la bozza si butta e non si scrive niente", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(makeSetPropsOp("btn", { x: 300 }, ["x"]));
    expect(tl().recordDraft).not.toBeNull();
    st.cancelGesture();
    expect(tl().recordDraft).toBeNull();
    expect(sc().clips.k.tracks).toHaveLength(1);
  });

  it("spegnere Registra rimette l'identità", () => {
    tl().setRecord(false);
    const ops = [makeSetPropsOp("btn", { x: 5 }, ["x"])];
    expect(recordFinal(ops)).toBe(ops);
  });

  it("senza una clip aperta non si può armare", () => {
    tl().setRecord(false);
    tl().openClip(null);
    tl().setRecord(true);
    expect(tl().record).toBe(false);
  });
});

describe("scritture sul documento: un op per gesto", () => {
  it("createClip / duplica / elimina", () => {
    const before = useScene.getState().undoStack.length;
    const c = createClip(sc(), ["btn"])!;
    expect(c.targetId).toBe("A");
    expect(sc().clips[c.id]).toBeDefined();
    expect(tl().clipId).toBe(c.id);
    expect(useScene.getState().undoStack.length).toBe(before + 1);
    duplicateClipOp(sc(), "k");
    expect(Object.keys(sc().clips)).toHaveLength(3);
    tl().openClip(c.id);
    removeClip(c.id);
    expect(sc().clips[c.id]).toBeUndefined();
    expect(tl().clipId).toBeNull();
  });

  it("addPropertyTracks: senza clip aperta ne crea una; con una la riempie; salta i nodi fuori bersaglio", () => {
    const n = addPropertyTracks(sc(), ["btn"], "scale");
    expect(n).toBe(1);
    const created = Object.values(sc().clips).find((c) => c.id !== "k")!;
    expect(created.tracks.map((t) => t.prop)).toEqual(["scale"]);
    expect(tl().clipId).toBe(created.id);
    // di nuovo la stessa proprietà: niente da aggiungere
    expect(addPropertyTracks(sc(), ["btn"], "scale")).toBe(0);
    // un nodo fuori dal bersaglio (loose sta sulla pagina) non si aggiunge
    expect(addPropertyTracks(sc(), ["loose"], "opacity")).toBe(0);
    expect(isValidClip(sc(), sc().clips[created.id])).toBe(true);
  });

  it("commitClip scrive la clip intera (upsert)", () => {
    commitClip(clip({ name: "rinominata" }));
    expect(sc().clips.k.name).toBe("rinominata");
  });
});

describe("riproduzione", () => {
  let queue: ((t: number) => void)[] = [];
  let now = 1000;
  beforeEach(() => {
    queue = [];
    now = 1000;
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => { queue.push(cb); return queue.length; });
    vi.stubGlobal("cancelAnimationFrame", () => { queue = []; });
    vi.spyOn(performance, "now").mockImplementation(() => now);
    tl().openClip("k");
    queue = [];
  });
  // Il ciclo limita un singolo salto a 100 ms (scheda in secondo piano): si avanza a passi da 50.
  const frame = (dt: number) => {
    for (let left = dt; left > 0; left -= 50) {
      const cb = queue.shift();
      now += Math.min(50, left);
      cb?.(now);
    }
  };

  it("a timeline ferma NON pianifica nessun frame", () => {
    expect(queue).toHaveLength(0);
    tl().setPlayhead(300);
    tl().stop();
    expect(queue).toHaveLength(0);
    // chiudere il pannello chiede UN solo resize (la tela cambia altezza), poi niente
    tl().setOpen(false);
    queue.splice(0).forEach((cb) => cb(now));
    expect(queue).toHaveLength(0);
  });

  it("play avanza il playhead col tempo reale e alla fine si ferma", () => {
    tl().play();
    expect(tl().playing).toBe(true);
    expect(queue).toHaveLength(1);
    frame(250);
    expect(tl().playhead).toBe(250);
    frame(250);
    expect(tl().playhead).toBe(500);
    frame(600);
    expect(tl().playing).toBe(false);
    expect(tl().playhead).toBe(1000);
    expect(queue).toHaveLength(0); // niente frame dopo la fine
  });

  it("la velocità scala il tempo", () => {
    tl().setSpeed(0.5);
    tl().play();
    frame(400);
    expect(tl().playhead).toBe(200);
    tl().setSpeed(2);
    expect(tl().speed).toBe(2);
    tl().setSpeed(3); // non ammessa: torna a 1
    expect(tl().speed).toBe(1);
  });

  it("loop riparte da capo; pausa ferma il ciclo; stop azzera", () => {
    tl().setLoop(true);
    tl().play();
    frame(1100);
    expect(tl().playing).toBe(true);
    expect(tl().playhead).toBe(100); // è ripartito da capo a 1000 ms
    expect(queue).toHaveLength(1);
    frame(300);
    tl().pause();
    expect(tl().playing).toBe(false);
    expect(queue).toHaveLength(0);
    tl().stop();
    expect(tl().playhead).toBe(0);
    expect(tl().posed).toBe(false);
  });

  it("il trigger loop gira per sempre anche con repeat 0; yoyo torna indietro", () => {
    install({ ...baseScene(), clips: { k: clip({ trigger: "loop" }), y: clip({ id: "y", yoyo: true, repeat: 1 }) } });
    tl().openClip("k");
    queue = [];
    tl().play();
    frame(1500);
    expect(tl().playing).toBe(true);
    expect(tl().playhead).toBe(500);
    tl().openClip("y");
    queue = [];
    tl().play();
    frame(1500); // secondo ciclo, al contrario: 1500 -> 1000-500
    expect(tl().playhead).toBe(500);
    frame(100);
    expect(tl().playhead).toBe(400);
  });

  it("scorrere mette in pausa e accende la posa; chiudere la spegne", () => {
    tl().play();
    tl().setPlayhead(250);
    expect(tl().playing).toBe(false);
    expect(tl().posed).toBe(true);
    expect(posedScene()!.nodes.at("btn").opacity).toBeCloseTo(0.25);
    expect(sc().nodes.at("btn").opacity).toBe(1);
    tl().setOpen(false);
    expect(isPosing()).toBe(false);
    expect(posedScene()).toBe(sc());
  });

  it("posedScene è memoizzata sullo stesso (scena, clip, playhead)", () => {
    tl().setPlayhead(100);
    expect(posedScene()).toBe(posedScene());
  });

  it("una bozza di trascinamento si campiona al posto della clip del documento", () => {
    tl().setPlayhead(500);
    const before = posedScene()!.nodes.at("btn").opacity;
    tl().setDraftClip(clip({ tracks: [{ nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0, easing: "" }, { time: 500, value: 1, easing: "" }, { time: 1000, value: 1, easing: "" }] }] }));
    expect(before).toBeCloseTo(0.5);
    expect(posedScene()!.nodes.at("btn").opacity).toBe(1);
  });
});
