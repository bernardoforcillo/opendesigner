import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ScreenMetaEditor } from "./ScreenMetaEditor";
import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { baseScene } from "../flow/testSupport";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ selection: [], gesture: null, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  useScene.getState().setScene(baseScene());
  useScene.getState().setSync(sync);
});
afterEach(cleanup);

const select = (...ids: string[]) => act(() => useScene.getState().setSelection(ids));
const metaOf = (id: string) => useScene.getState().scene!.nodes.at(id).meta;

describe("ScreenMetaEditor", () => {
  it("senza selezione (o con più nodi) invita a selezionare una schermata", () => {
    render(<ScreenMetaEditor />);
    expect(screen.getByText(/Seleziona una schermata/)).toBeInTheDocument();
    select("A", "B");
    expect(screen.getByText(/Seleziona una schermata/)).toBeInTheDocument();
  });

  it("mostra i default: tipo Schermata, stato Pianificata, campi vuoti", () => {
    select("A");
    render(<ScreenMetaEditor />);
    expect(screen.getByRole("combobox", { name: "Tipo" })).toHaveValue("screen");
    expect(screen.getByRole("radio", { name: "Pianificata" })).toBeChecked();
    for (const l of ["Route", "Componente", "Test id", "Test testo"]) expect(screen.getByRole("textbox", { name: l })).toHaveValue("");
  });

  it("legge i metadati esistenti", () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({
      ...s,
      nodes: s.nodes.set("A", { ...s.nodes.at("A"), meta: { "flow.kind": "decision", status: "tested", "code.route": "/home", "test.id": "home-root" } }),
    });
    select("A");
    render(<ScreenMetaEditor />);
    expect(screen.getByRole("combobox", { name: "Tipo" })).toHaveValue("decision");
    expect(screen.getByRole("radio", { name: "Testata" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Route" })).toHaveValue("/home");
    expect(screen.getByRole("textbox", { name: "Test id" })).toHaveValue("home-root");
  });

  it("cambiare il tipo scrive setProps con la mask «meta» (UN op)", () => {
    select("A");
    render(<ScreenMetaEditor />);
    fireEvent.change(screen.getByRole("combobox", { name: "Tipo" }), { target: { value: "end" } });
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setProps");
    const v = sync.sent[0].kind.value as { mask: { paths: string[] } };
    expect(v.mask.paths).toEqual(["meta"]);
    expect(metaOf("A")).toEqual({ "flow.kind": "end" });
  });

  it("ogni campo scrive la sua chiave senza cancellare le altre (anche quelle ignote)", () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({ ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), meta: { "altro.strumento": "x" } }) });
    select("A");
    render(<ScreenMetaEditor />);
    fireEvent.click(screen.getByRole("radio", { name: "Implementata" }));
    const route = screen.getByRole("textbox", { name: "Route" });
    fireEvent.change(route, { target: { value: "/login" } });
    fireEvent.keyDown(route, { key: "Enter" });
    const comp = screen.getByRole("textbox", { name: "Componente" });
    fireEvent.change(comp, { target: { value: "LoginPage" } });
    fireEvent.blur(comp);
    const tid = screen.getByRole("textbox", { name: "Test id" });
    fireEvent.change(tid, { target: { value: "login" } });
    fireEvent.blur(tid);
    const txt = screen.getByRole("textbox", { name: "Test testo" });
    fireEvent.change(txt, { target: { value: "Accedi" } });
    fireEvent.blur(txt);
    expect(sync.sent).toHaveLength(5);
    expect(metaOf("A")).toEqual({
      "altro.strumento": "x", status: "implemented", "code.route": "/login", "code.component": "LoginPage",
      "test.id": "login", "test.text": "Accedi",
    });
  });

  it("svuotare un campo TOGLIE la chiave; valore invariato = nessun op", () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({ ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), meta: { "code.route": "/a", status: "tested" } }) });
    select("A");
    render(<ScreenMetaEditor />);
    const route = screen.getByRole("textbox", { name: "Route" });
    fireEvent.keyDown(route, { key: "Enter" });
    expect(sync.sent).toHaveLength(0);
    fireEvent.change(route, { target: { value: "" } });
    fireEvent.keyDown(route, { key: "Enter" });
    expect(metaOf("A")).toEqual({ status: "tested" });
    // l'ultima chiave tolta: meta sparisce del tutto (nel modello è assente, non vuota)
    fireEvent.click(screen.getByRole("radio", { name: "Pianificata" }));
    expect(metaOf("A")).toEqual({ status: "planned" });
  });

  it("cambiando selezione i campi mostrano i valori del nuovo nodo (non quelli del precedente)", () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({ ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), meta: { "code.route": "/a" } }) });
    select("A");
    render(<ScreenMetaEditor />);
    expect(screen.getByRole("textbox", { name: "Route" })).toHaveValue("/a");
    select("B");
    expect(screen.getByRole("textbox", { name: "Route" })).toHaveValue("");
  });

  it("l'undo di una modifica ripristina i metadati precedenti", () => {
    select("A");
    render(<ScreenMetaEditor />);
    fireEvent.click(screen.getByRole("radio", { name: "Testata" }));
    expect(metaOf("A")).toEqual({ status: "tested" });
    act(() => useScene.getState().undo());
    expect(metaOf("A")).toBeUndefined();
  });
});
