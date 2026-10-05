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
  it("without a selection (or with several nodes) it invites to select a screen", () => {
    render(<ScreenMetaEditor />);
    expect(screen.getByText(/Select a screen/)).toBeInTheDocument();
    select("A", "B");
    expect(screen.getByText(/Select a screen/)).toBeInTheDocument();
  });

  it("shows the defaults: type Screen, status Planned, empty fields", () => {
    select("A");
    render(<ScreenMetaEditor />);
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveValue("screen");
    expect(screen.getByRole("radio", { name: "Planned" })).toBeChecked();
    for (const l of ["Route", "Component", "Test id", "Test text"]) expect(screen.getByRole("textbox", { name: l })).toHaveValue("");
  });

  it("reads the existing metadata", () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({
      ...s,
      nodes: s.nodes.set("A", { ...s.nodes.at("A"), meta: { "flow.kind": "decision", status: "tested", "code.route": "/home", "test.id": "home-root" } }),
    });
    select("A");
    render(<ScreenMetaEditor />);
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveValue("decision");
    expect(screen.getByRole("radio", { name: "Tested" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Route" })).toHaveValue("/home");
    expect(screen.getByRole("textbox", { name: "Test id" })).toHaveValue("home-root");
  });

  it("changing the type writes setProps with the «meta» mask (ONE op)", () => {
    select("A");
    render(<ScreenMetaEditor />);
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "end" } });
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setProps");
    const v = sync.sent[0].kind.value as { mask: { paths: string[] } };
    expect(v.mask.paths).toEqual(["meta"]);
    expect(metaOf("A")).toEqual({ "flow.kind": "end" });
  });

  it("each field writes its own key without erasing the others (including unknown ones)", () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({ ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), meta: { "other.tool": "x" } }) });
    select("A");
    render(<ScreenMetaEditor />);
    fireEvent.click(screen.getByRole("radio", { name: "Implemented" }));
    const route = screen.getByRole("textbox", { name: "Route" });
    fireEvent.change(route, { target: { value: "/login" } });
    fireEvent.keyDown(route, { key: "Enter" });
    const comp = screen.getByRole("textbox", { name: "Component" });
    fireEvent.change(comp, { target: { value: "LoginPage" } });
    fireEvent.blur(comp);
    const tid = screen.getByRole("textbox", { name: "Test id" });
    fireEvent.change(tid, { target: { value: "login" } });
    fireEvent.blur(tid);
    const txt = screen.getByRole("textbox", { name: "Test text" });
    fireEvent.change(txt, { target: { value: "Log in" } });
    fireEvent.blur(txt);
    expect(sync.sent).toHaveLength(5);
    expect(metaOf("A")).toEqual({
      "other.tool": "x", status: "implemented", "code.route": "/login", "code.component": "LoginPage",
      "test.id": "login", "test.text": "Log in",
    });
  });

  it("emptying a field REMOVES the key; unchanged value = no op", () => {
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
    // the last key removed: meta disappears entirely (in the model it is absent, not empty)
    fireEvent.click(screen.getByRole("radio", { name: "Planned" }));
    expect(metaOf("A")).toEqual({ status: "planned" });
  });

  it("changing the selection the fields show the new node's values (not the previous one's)", () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({ ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), meta: { "code.route": "/a" } }) });
    select("A");
    render(<ScreenMetaEditor />);
    expect(screen.getByRole("textbox", { name: "Route" })).toHaveValue("/a");
    select("B");
    expect(screen.getByRole("textbox", { name: "Route" })).toHaveValue("");
  });

  it("undoing a change restores the previous metadata", () => {
    select("A");
    render(<ScreenMetaEditor />);
    fireEvent.click(screen.getByRole("radio", { name: "Tested" }));
    expect(metaOf("A")).toEqual({ status: "tested" });
    act(() => useScene.getState().undo());
    expect(metaOf("A")).toBeUndefined();
  });
});
