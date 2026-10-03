import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimelinePanel } from "./TimelinePanel";
import { LABEL_W } from "./TrackArea";
import { useScene } from "../../store/store";
import { useTimeline } from "../../animation/timelineStore";
import { baseScene } from "../../flow/testSupport";
import type { ClipLite, SceneState } from "../../store/types";

// I pezzi della timeline sotto jsdom: cosa mostra, cosa scrive (un op per gesto),
// la tastiera dentro il pannello. Il disegno sulla tela e il trascinamento vero
// sono nei test di renderer / logica e nella verifica in browser.

// jsdom non misura: la timeline ripiega su 720 px di larghezza, quindi la corsia è (720 - etichette - margini 16+28) px per tutta la durata
const PPM = (720 - LABEL_W - 16 - 28) / 1000;

const clip = (over: Partial<ClipLite> = {}): ClipLite => ({
  id: "k", name: "Entrata", duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "A",
  tracks: [
    { nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0, easing: "" }, { time: 500, value: 1, easing: "easeOut" }] },
    { nodeId: "btn", prop: "x", keyframes: [{ time: 100, value: 10, easing: "" }, { time: 800, value: 50, easing: "" }] },
  ],
  ...over,
});

function install(s: SceneState = { ...baseScene(), clips: { k: clip() } }) {
  useScene.setState({ undoStack: [], redoStack: [], gesture: null, sync: null, selection: [] });
  useScene.getState().setScene(s);
}
const sc = () => useScene.getState().scene!;
const tl = () => useTimeline.getState();

beforeEach(() => {
  useTimeline.setState({
    open: true, clipId: null, playhead: 0, playing: false, loop: false, speed: 1, record: false, posed: false,
    zoom: 1, selection: [], draftClip: null, recordDraft: null, collapsed: false, filterToSelection: false,
  });
  install();
});
afterEach(() => {
  cleanup();
  tl().setOpen(false);
  vi.restoreAllMocks();
});

describe("TimelinePanel: apertura", () => {
  it("chiusa non rende niente", () => {
    useTimeline.setState({ open: false });
    const { container } = render(<TimelinePanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("aperta senza clip aperta: lo stato vuoto che dice cosa fare, con la lista delle clip", () => {
    render(<TimelinePanel />);
    expect(screen.getByRole("region", { name: "Timeline" })).toBeInTheDocument();
    expect(screen.getByText("Anima qualcosa: seleziona un livello e premi + Proprietà")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Elenco delle clip" })).getByText("Entrata")).toBeInTheDocument();
  });

  it("senza nessuna clip nel documento lo dice e 'Nuova clip' ne crea UNA con un solo gesto", async () => {
    install(baseScene());
    useScene.getState().setSelection(["btn"]);
    render(<TimelinePanel />);
    expect(screen.getByText("Nessuna clip. Creane una con +.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Crea una clip" }));
    expect(Object.keys(sc().clips)).toHaveLength(1);
    const c = Object.values(sc().clips)[0];
    expect(c.targetId).toBe("A");
    expect(tl().clipId).toBe(c.id);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("scegliere una clip dalla lista la apre (e mostra tracce e impostazioni)", async () => {
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: /Entrata/ }));
    expect(tl().clipId).toBe("k");
    expect(screen.getByRole("button", { name: "Impostazioni della clip" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Traccia Opacità di btn" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Traccia X di btn" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Keyframe a/ })).toHaveLength(4);
  });

  it("una clip senza tracce mostra l'invito a usare + Proprietà", () => {
    install({ ...baseScene(), clips: { k: clip({ tracks: [] }) } });
    tl().openClip("k");
    render(<TimelinePanel />);
    expect(screen.getByText("Anima qualcosa: seleziona un livello e premi + Proprietà")).toBeInTheDocument();
  });
});

describe("impostazioni della clip: un SetClip per modifica", () => {
  beforeEach(() => tl().openClip("k"));
  // Le impostazioni stanno in un popover dalla barra del trasporto: si aprono prima.
  const openSettings = () => userEvent.click(screen.getByRole("button", { name: "Impostazioni della clip" }));

  it("l'innesco", async () => {
    render(<TimelinePanel />);
    await openSettings();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Innesco" }), "hover");
    expect(sc().clips.k.trigger).toBe("hover");
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("il nome conferma su Invio, una volta sola", async () => {
    render(<TimelinePanel />);
    await openSettings();
    const input = screen.getByRole("textbox", { name: "Nome della clip" });
    await userEvent.clear(input);
    await userEvent.type(input, "Apparizione{Enter}");
    expect(sc().clips.k.name).toBe("Apparizione");
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("la durata: i keyframe oltre la nuova fine si portano alla fine", async () => {
    render(<TimelinePanel />);
    await openSettings();
    const field = screen.getByRole("textbox", { name: "Durata" });
    await userEvent.clear(field);
    await userEvent.type(field, "300{Enter}");
    expect(sc().clips.k.duration).toBe(300);
    expect(sc().clips.k.tracks[0].keyframes.map((k) => k.time)).toEqual([0, 300]);
  });

  it("infinito e yoyo", async () => {
    render(<TimelinePanel />);
    await openSettings();
    await userEvent.click(screen.getByRole("button", { name: "Ripeti all'infinito" }));
    expect(sc().clips.k.repeat).toBe(-1);
    await userEvent.click(screen.getByRole("button", { name: "Yoyo" }));
    expect(sc().clips.k.yoyo).toBe(true);
    expect(useScene.getState().undoStack).toHaveLength(2);
  });

  it("il bersaglio è uno dei frame/gruppi del documento", async () => {
    render(<TimelinePanel />);
    await openSettings();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Bersaglio" }), "B");
    expect(sc().clips.k.targetId).toBe("B");
  });

  it("duplica ed elimina dalla lista", async () => {
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Duplica la clip" }));
    expect(Object.keys(sc().clips)).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Elimina la clip" }));
    expect(Object.keys(sc().clips)).toHaveLength(1);
    expect(tl().clipId).toBeNull();
  });
});

describe("keyframe: selezione, ispettore, tastiera", () => {
  beforeEach(() => tl().openClip("k"));
  const kf = (name: RegExp | string) => screen.getAllByRole("button", { name: new RegExp(`^Keyframe a ${name}`) })[0];

  it("cliccare un keyframe lo seleziona, porta il playhead lì e mostra l'ispettore", () => {
    render(<TimelinePanel />);
    fireEvent.pointerDown(kf("500 ms"), { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(kf("500 ms"), { button: 0, pointerId: 1, clientX: 100 });
    expect(tl().selection).toEqual([{ track: 0, key: 1 }]);
    expect(tl().playhead).toBe(500);
    const insp = screen.getByRole("complementary", { name: "Keyframe" });
    expect(within(insp).getByRole("textbox", { name: "Tempo" })).toHaveValue("500");
    // l'ultimo keyframe non ha un segmento dopo di sé: niente curva
    expect(within(insp).queryByRole("combobox", { name: "Easing" })).not.toBeInTheDocument();
    // il primo sì, e mostra la sua curva
    fireEvent.pointerDown(kf("0 ms"), { button: 0, pointerId: 1, clientX: 20 });
    fireEvent.pointerUp(kf("0 ms"), { button: 0, pointerId: 1, clientX: 20 });
    expect(within(screen.getByRole("complementary", { name: "Keyframe" })).getByRole("combobox", { name: "Easing" })).toHaveValue("linear");
    expect(screen.getByRole("group", { name: "Curva di easing" })).toBeInTheDocument();
  });

  it("l'ispettore cambia valore ed easing con UN op ciascuno", async () => {
    render(<TimelinePanel />);
    fireEvent.pointerDown(kf("500 ms"), { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(kf("500 ms"), { button: 0, pointerId: 1, clientX: 100 });
    const insp = screen.getByRole("complementary", { name: "Keyframe" });
    const v = within(insp).getByRole("textbox", { name: "Valore" });
    await userEvent.clear(v);
    await userEvent.type(v, "0.4{Enter}");
    expect(sc().clips.k.tracks[0].keyframes[1].value).toBe(0.4);
    fireEvent.pointerDown(kf("0 ms"), { button: 0, pointerId: 1, clientX: 20 });
    fireEvent.pointerUp(kf("0 ms"), { button: 0, pointerId: 1, clientX: 20 });
    await userEvent.selectOptions(within(screen.getByRole("complementary", { name: "Keyframe" })).getByRole("combobox", { name: "Easing" }), "spring");
    expect(sc().clips.k.tracks[0].keyframes[0].easing).toBe("spring");
    expect(useScene.getState().undoStack).toHaveLength(2);
  });

  it("Canc cancella i keyframe selezionati (UN op) e NON i livelli selezionati sulla tela", () => {
    useScene.getState().setSelection(["btn"]);
    render(<TimelinePanel />);
    const b = kf("500 ms");
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(b, { button: 0, pointerId: 1, clientX: 100 });
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    fireEvent.keyDown(screen.getByRole("region", { name: "Timeline" }), { key: "Delete" });
    window.removeEventListener("keydown", onWindow);
    expect(onWindow).not.toHaveBeenCalled(); // il tasto non arriva ai listener globali (che cancellerebbero il nodo)
    expect(sc().clips.k.tracks[0].keyframes.map((k) => k.time)).toEqual([0]);
    expect(sc().nodes.has("btn")).toBe(true);
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(tl().selection).toEqual([]);
  });

  it("Ctrl+D duplica al playhead; le frecce spostano di un passo di griglia", () => {
    render(<TimelinePanel />);
    const b = kf("500 ms");
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(b, { button: 0, pointerId: 1, clientX: 100 });
    tl().setPlayhead(700);
    fireEvent.keyDown(screen.getByRole("region", { name: "Timeline" }), { key: "d", ctrlKey: true });
    expect(sc().clips.k.tracks[0].keyframes.map((k) => k.time)).toEqual([0, 500, 700]);
    // la selezione ora è la copia (a 700): freccia destra = +10 ms
    const copy = screen.getAllByRole("button", { name: /^Keyframe a 700 ms/ })[0];
    fireEvent.keyDown(copy, { key: "ArrowRight" });
    expect(sc().clips.k.tracks[0].keyframes.map((k) => k.time)).toEqual([0, 500, 710]);
  });

  it("trascinare un keyframe: bozza durante il gesto, UN op al rilascio, agganciato alla griglia", () => {
    render(<TimelinePanel />);
    const b = kf("500 ms");
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 200 });
    // +50 px = +107 ms a PPM px/ms: 500 + 107 = 607 -> griglia 610
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 250 });
    expect(tl().draftClip?.tracks[0].keyframes[1].time).toBe(610);
    expect(useScene.getState().undoStack).toHaveLength(0); // niente op durante il trascinamento
    expect(sc().clips.k.tracks[0].keyframes[1].time).toBe(500);
    fireEvent.pointerUp(b, { pointerId: 1, clientX: 250 });
    expect(sc().clips.k.tracks[0].keyframes[1].time).toBe(610);
    expect(tl().draftClip).toBeNull();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(tl().selection).toEqual([{ track: 0, key: 1 }]);
  });

  it("Maiusc libera l'aggancio", () => {
    render(<TimelinePanel />);
    const b = kf("500 ms");
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 250, shiftKey: true });
    expect(tl().draftClip?.tracks[0].keyframes[1].time).toBe(607);
    fireEvent.pointerCancel(b, { pointerId: 1 });
    expect(tl().draftClip).toBeNull();
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("un tremolio sotto la soglia è un click, non un trascinamento", () => {
    render(<TimelinePanel />);
    const b = kf("500 ms");
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 201 });
    expect(tl().draftClip).toBeNull();
    fireEvent.pointerUp(b, { pointerId: 1, clientX: 201 });
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("il doppio click su una riga aggiunge un keyframe col valore campionato", () => {
    render(<TimelinePanel />);
    const lane = screen.getByRole("group", { name: "Traccia Opacità di btn" });
    // x = 16 (PAD) + 250 ms * PPM; getBoundingClientRect in jsdom è tutto zero
    fireEvent.doubleClick(lane, { clientX: 16 + 250 * PPM });
    const ks = sc().clips.k.tracks[0].keyframes;
    expect(ks.map((k) => k.time)).toEqual([0, 250, 500]);
    expect(ks[1].value).toBeGreaterThan(0.3); // easing "" (lineare) fra 0 e 1 con curva easeOut dopo: campionato, non zero
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("il pulsante della riga aggiunge un keyframe al playhead", async () => {
    tl().setPlayhead(300);
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Aggiungi un keyframe al playhead su X" }));
    expect(sc().clips.k.tracks[1].keyframes.map((k) => k.time)).toEqual([100, 300, 800]);
  });

  it("rimuovere una traccia", async () => {
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Rimuovi la traccia X" }));
    expect(sc().clips.k.tracks.map((t) => t.prop)).toEqual(["opacity"]);
  });
});

describe("trasporto", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    tl().openClip("k");
  });

  it("Spazio col fuoco dentro la timeline fa play/pausa, e non arriva al pan globale", () => {
    render(<TimelinePanel />);
    const panel = screen.getByRole("region", { name: "Timeline" });
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    fireEvent.keyDown(panel, { code: "Space", key: " " });
    window.removeEventListener("keydown", onWindow);
    expect(tl().playing).toBe(true);
    expect(onWindow).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { code: "Space", key: " " });
    expect(tl().playing).toBe(false);
  });

  it("fuori dalla timeline lo spazio resta del pan: nessuno ascolta la finestra per questo", () => {
    render(<TimelinePanel />);
    fireEvent.keyDown(window, { code: "Space", key: " " });
    expect(tl().playing).toBe(false);
  });

  it("pulsanti: riproduci, pausa, stop, loop, velocità, registra", async () => {
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Riproduci" }));
    expect(tl().playing).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Pausa" }));
    expect(tl().playing).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Ripeti in loop" }));
    expect(tl().loop).toBe(true);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Velocità" }), "0.5");
    expect(tl().speed).toBe(0.5);
    await userEvent.click(screen.getByRole("button", { name: "Registra" }));
    expect(tl().record).toBe(true);
    expect(screen.getByRole("button", { name: "Registra" })).toHaveAttribute("aria-pressed", "true");
    // armata: il bordo del pannello diventa rosso, è l'indicatore che si vede anche a colpo d'occhio
    expect(screen.getByRole("region", { name: "Timeline" }).className).toContain("border-danger");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(tl().playhead).toBe(0);
  });

  it("il righello scorre il playhead (agganciato a 10 ms) e mostra il tempo corrente", () => {
    render(<TimelinePanel />);
    const ruler = screen.getByRole("slider", { name: "Playhead" });
    fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX: 16 + 333 * PPM });
    expect(tl().playhead).toBe(330);
    expect(tl().posed).toBe(true);
    expect(screen.getByLabelText("Tempo corrente")).toHaveTextContent("0:00.330");
    fireEvent.keyDown(ruler, { key: "ArrowRight" });
    expect(tl().playhead).toBe(340);
  });

  it("Registra è disabilitato senza una clip aperta", () => {
    tl().openClip(null);
    render(<TimelinePanel />);
    expect(screen.getByRole("button", { name: "Registra" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Riproduci" })).toBeDisabled();
  });
});

describe("+ Proprietà e preset", () => {
  it("+ Proprietà sul livello selezionato aggiunge la traccia alla clip aperta", async () => {
    tl().openClip("k");
    useScene.getState().setSelection(["btn"]);
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Aggiungi proprietà" }));
    // opacità e X ci sono già: disabilitate; Scala è libera
    expect(await screen.findByRole("menuitem", { name: /Opacità/ })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("menuitem", { name: /Scala/ }));
    expect(sc().clips.k.tracks.map((t) => t.prop)).toEqual(["opacity", "x", "scale"]);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("senza selezione il menu è spento", () => {
    tl().openClip("k");
    render(<TimelinePanel />);
    expect(screen.getByRole("button", { name: "Aggiungi proprietà" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Anima con un preset" })).toBeDisabled();
  });

  it("un preset crea una clip nuova con UN gesto e la apre", async () => {
    useScene.getState().setSelection(["btn"]);
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Anima con un preset" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Fade in/ }));
    expect(Object.keys(sc().clips)).toHaveLength(2);
    const made = Object.values(sc().clips).find((c) => c.id !== "k")!;
    expect(made.name).toMatch(/Fade in/);
    expect(tl().clipId).toBe(made.id);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });
});

describe("resize e riduzione", () => {
  it("l'altezza si cambia con le frecce sul bordo e si salva", () => {
    render(<TimelinePanel />);
    const h0 = tl().height;
    fireEvent.keyDown(screen.getByRole("separator", { name: "Altezza della timeline" }), { key: "ArrowUp" });
    expect(tl().height).toBe(h0 + 24);
  });

  it("ridurre nasconde il corpo e lascia la testata", async () => {
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Riduci la timeline" }));
    expect(screen.queryByRole("toolbar", { name: "Trasporto" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Espandi la timeline" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Chiudi la timeline" }));
    expect(tl().open).toBe(false);
  });
});
