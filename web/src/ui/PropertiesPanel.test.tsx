import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toJson, fromJson } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { PropertiesPanel } from "./PropertiesPanel";
import { contentWorldBounds } from "../store/groups";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { InstanceOverrideLite, NodeLite, StrokeAlignLite, StrokeLite, TextLite } from "../store/types";

// SyncClient double: records the ops that end up ON THE WIRE and models a
// server that accepts and ECHOES at once (applyPending + apply), like
// ui/LayersPanel.test.tsx.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function rectNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId: "page1", orderKey, name: "", visible: true, opacity: 1,
    x: 10, y: 20, width: 30, height: 40, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

function ellipseNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rectNode(id, orderKey), kind: "ellipse", cornerRadius: 0, clipsContent: false, ...over };
}

// A group is BORN at (0,0) and without geometry of its own: its frame is the union
// of the children (store/groups.ts), not its box.
function groupNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rectNode(id, orderKey), kind: "group", x: 0, y: 0, width: 0, height: 0, fills: [], ...over };
}

const TEXT_STYLE: TextLite["style"] = {
  fontFamily: "Inter, sans-serif", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "left",
};

function textNode(id: string, orderKey: string, content = "hello", over: Partial<NodeLite> = {}): NodeLite {
  return {
    ...rectNode(id, orderKey),
    kind: "text", cornerRadius: 0, clipsContent: false,
    text: { content, style: { ...TEXT_STYLE } },
    ...over,
  };
}

function installScene(...nodes: NodeLite[]) {
  const scene = emptyScene("doc-1", "Untitled");
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
  // setScene and not setState({scene}): installs a COHERENT scene (view and
  // confirmed aligned, queue empty, history cleared) -- the reconciliation's
  // invariant, and the clean starting point for every test.
  useScene.getState().setScene(scene);
}

let sync: FakeSync;

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
    gesture: null,
    editingNodeId: null,
  });
  useScene.getState().setSync(sync);
});

afterEach(cleanup);

function field(letter: string): HTMLInputElement {
  return screen.getByRole("textbox", { name: letter }) as HTMLInputElement;
}

function label(letter: string): HTMLElement {
  return screen.getByText(letter, { selector: "label" });
}

// Drags label `letter` by `dx` px (in a single intermediate step) and
// releases. pointerId shared among the three events: it is how NumberField
// recognizes that they belong to the SAME drag.
function dragLabel(letter: string, dx: number) {
  const el = label(letter);
  const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
  fireEvent.pointerDown(el, { ...base, clientX: 0 });
  fireEvent.pointerMove(el, { ...base, clientX: Math.round(dx / 2) });
  fireEvent.pointerMove(el, { ...base, clientX: dx });
  fireEvent.pointerUp(el, { ...base, clientX: dx });
}

// --- Step 1: shown values, typing, dragging, empty selection --

describe("without selection", () => {
  it("the panel is empty/disabled: no geometric field", () => {
    installScene(rectNode("a", "a0"));
    render(<PropertiesPanel />);

    expect(screen.queryByRole("textbox", { name: "X" })).toBeNull();
    expect(screen.getByText("No selection")).toBeInTheDocument();
  });
});

describe("a selected node", () => {
  it("the X/Y/W/H fields show its values", () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(field("X")).toHaveValue("10");
    expect(field("Y")).toHaveValue("20");
    expect(field("W")).toHaveValue("30");
    expect(field("H")).toHaveValue("40");
  });

  // The overlay's handle gives the GESTURE; this field gives the NUMBER. Without it, a
  // rotated node has no place to say what angle it is at, and an
  // exact angle (90, 45, or 0 to set it straight) cannot be written.
  it("the Rot field shows the node's angle", () => {
    installScene(rectNode("a", "a0", { rotation: 45 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(field("Rot")).toHaveValue("45");
  });
});

describe("the Rot field", () => {
  it("writes the angle with ONE SetProperties on the rotation mask alone", async () => {
    installScene(rectNode("a", "a0", { rotation: 0 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("Rot"));
    await user.type(field("Rot"), "90{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.mask?.paths).toEqual(["rotation"]);
      expect(op.kind.value.patch?.rotation).toBe(90);
    }
    expect(useScene.getState().scene!.nodes.at("a").rotation).toBe(90);
    expect(useScene.getState().undoStack).toHaveLength(1); // one field, one gesture
  });

  it("accepts a NEGATIVE angle (-30 is typed more readily than 330)", async () => {
    installScene(rectNode("a", "a0", { rotation: 0 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("Rot"));
    await user.type(field("Rot"), "-30{Enter}");

    expect(useScene.getState().scene!.nodes.at("a").rotation).toBe(-30);
  });

  it("on a selection with different angles it says Mixed instead of inventing one", () => {
    installScene(rectNode("a", "a0", { rotation: 0 }), rectNode("b", "a1", { rotation: 90 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    expect(field("Rot")).toHaveValue("");
    expect(field("Rot")).toHaveAttribute("placeholder", "Mixed");
  });
});

describe("typing and confirming", () => {
  it("emits ONE SetProperties with the mask of the edited field alone", async () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(field("X"));
    await user.type(field("X"), "99{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.id).toBe("a");
      expect(op.kind.value.mask?.paths).toEqual(["x"]);
      expect(op.kind.value.patch?.x).toBe(99);
      // No other field touched: the mask is the only proof that counts, but the
      // confirmed value must not even appear outside x.
      expect(op.kind.value.patch?.y).toBe(0);
    }
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(99);
    // One gesture, one undo entry -- like every other panel change.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("confirming the SAME value sends no op", async () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.click(field("Y"));
    await user.keyboard("{Enter}");

    expect(sync.sent).toHaveLength(0);
  });
});

describe("dragging the label", () => {
  it("produces a single gesture (one undo entry, one send), not one per pixel", () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("X", 25);

    // ONE single op on the wire -- not one per pointermove -- and ONE single
    // undo entry, exactly like selectTool.ts's move drag.
    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.mask?.paths).toEqual(["x"]);
      expect(op.kind.value.patch?.x).toBe(35); // 10 (start) + 25 (dx)
    }
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(35);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("the drag updates the shown value as a PREVIEW, before the release", () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    const el = label("X");
    const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
    fireEvent.pointerDown(el, { ...base, clientX: 0 });
    fireEvent.pointerMove(el, { ...base, clientX: 12 });

    // Local preview: the document changes (applyLocal), but NOTHING has left
    // for the server yet -- the gesture is still open.
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(22);
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().gesture).not.toBeNull();

    fireEvent.pointerUp(el, { ...base, clientX: 12 });
    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("a click on the label without exceeding the threshold opens no gesture", () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("X", 1); // below SCRUB_SLOP_PX

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(10);
    expect(useScene.getState().undoStack.length).toBe(undoBefore);
    expect(useScene.getState().gesture).toBeNull();
  });
});

// --- Step 3: no NaN must be able to reach the document ------------

describe("invalid values", () => {
  it("an emptied and confirmed field emits no Op", async () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("X"));
    await user.keyboard("{Enter}");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(10);
    expect(Number.isNaN(useScene.getState().scene?.nodes.at("a").x)).toBe(false);
    // The field goes back to showing the real value: nothing stays stuck empty.
    expect(field("X")).toHaveValue("10");
  });

  it("a value that does not parse at all (e.g. '-' alone) emits no Op", async () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("X"));
    await user.type(field("X"), "-{Enter}");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(10);
    expect(field("X")).toHaveValue("10");
  });

  it("no NaN ever reaches scene.nodes regardless of the path", () => {
    // Direct guard on the model: any future bug in NumberField's filter
    // must not be able to write an x/y/width/height NaN into the
    // document -- it is the concrete consequence the brief describes (a node
    // with x=NaN becomes invisible and unrecoverable from the UI).
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    const node = useScene.getState().scene?.nodes.at("a");
    expect(node).toBeDefined();
    for (const v of [node!.x, node!.y, node!.width, node!.height]) {
      expect(Number.isNaN(v)).toBe(false);
    }
  });
});

// Silences the react-stately controlled/uncontrolled warning should it ever
// reappear by regression: a test that catches it is more useful
// than one that silently ignores it.
describe("no react-stately control warning", () => {
  it("going from a single selection to no selection does not print the controlled/uncontrolled warning", () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    const { rerender } = render(<PropertiesPanel />);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      useScene.getState().setSelection([]);
      rerender(<PropertiesPanel />);
      useScene.getState().setSelection(["a"]);
      rerender(<PropertiesPanel />);
      const controlledWarning = warn.mock.calls.some((args) =>
        String(args[0]).includes("controlled"));
      expect(controlledWarning).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

// --- Task 10: appearance (fill, opacity, corner radius) ----------

function maskOf(op: Op): readonly string[] {
  if (op.kind.case !== "setProps") throw new Error("not a setProps op");
  return op.kind.value.mask?.paths ?? [];
}

describe("fill", () => {
  it("shows the current tint in hexadecimal", () => {
    installScene(rectNode("a", "a0", { fills: [{ r: 1, g: 0.5, b: 0, a: 1 }] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    // 1 / 0.5 / 0 float -> FF 80 00. The conversion lives only in the field.
    expect(screen.getByRole("textbox", { name: "Fill" })).toHaveValue("#FF8000");
  });

  it("emits ONE SetProperties mask `fills` with RGBA float 0..1", async () => {
    installScene(rectNode("a", "a0", { fills: [{ r: 0, g: 0, b: 0, a: 1 }] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    const input = screen.getByRole("textbox", { name: "Fill" });
    await user.clear(input);
    await user.type(input, "#FF8000{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(maskOf(op)).toEqual(["fills"]);
      const paint = op.kind.value.patch?.fills[0];
      expect(paint?.kind.case).toBe("solid");
      if (paint?.kind.case === "solid") {
        const c = paint.kind.value.color;
        // FLOAT 0..1, not 0..255: it is the model, not the UI's shape.
        expect(c?.r).toBeCloseTo(1, 5);
        expect(c?.g).toBeCloseTo(128 / 255, 5);
        expect(c?.b).toBeCloseTo(0, 5);
        // The previous tint's alpha survives: the hex does not carry it.
        expect(c?.a).toBe(1);
      }
    }
    expect(useScene.getState().scene?.nodes.at("a").fills[0].r).toBeCloseTo(1, 5);
    // One gesture, one undo entry.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("keeps the NODE's alpha, not any", async () => {
    installScene(rectNode("a", "a0", { fills: [{ r: 0, g: 0, b: 0, a: 0.25 }] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    const input = screen.getByRole("textbox", { name: "Fill" });
    await user.clear(input);
    await user.type(input, "#00FF00{Enter}");

    // The color HAS changed (without this, the alpha assert would pass even
    // if the field had emitted NOTHING) but the alpha has not.
    const fill = useScene.getState().scene?.nodes.at("a").fills[0];
    expect(fill?.g).toBeCloseTo(1, 5);
    expect(fill?.a).toBe(0.25);
  });

  it("re-confirming the SAME color sends no op", async () => {
    installScene(rectNode("a", "a0", { fills: [{ r: 1, g: 0, b: 0, a: 1 }] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    const input = screen.getByRole("textbox", { name: "Fill" });
    await user.click(input);
    await user.keyboard("{Enter}");

    expect(sync.sent).toHaveLength(0);
  });
});

// The track of a react-aria-components Slider measures ITSELF with
// getBoundingClientRect to convert dragged pixels into a value; in jsdom
// every element measures 0x0, so without this stub the conversion would give
// NaN. It is the equivalent, for the slider, of the setPointerCapture that jsdom does not
// implement (see the try/catch in fields/NumberField.tsx).
function stubTrackWidth(px: number): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      width: px, height: 8, top: 0, left: 0, right: px, bottom: 8, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

// The div that carries the drag handlers (useMove) is the PARENT of the
// VisuallyHidden wrapper that contains the range input: the input is only the
// keyboard and accessibility channel. If react-aria-components changed this
// structure, the error here would say so right away instead of making the drag fail
// obscurely.
function sliderThumb(name: string): HTMLElement {
  const input = screen.getByRole("slider", { name });
  const thumb = input.parentElement?.parentElement;
  if (!thumb) throw new Error("unexpected SliderThumb structure");
  return thumb;
}

// Drags slider `name`'s thumb by `dx` px, in two intermediate steps.
// useMove opens the drag on the thumb's pointerdown and then listens on the
// WINDOW, so move and up must be sent there.
function dragSlider(name: string, dx: number) {
  const thumb = sliderThumb(name);
  const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
  fireEvent.pointerDown(thumb, { ...base, clientX: 0, pageX: 0 });
  fireEvent.pointerMove(window, { ...base, clientX: dx / 2, pageX: dx / 2 });
  fireEvent.pointerMove(window, { ...base, clientX: dx, pageX: dx });
  fireEvent.pointerUp(window, { ...base, clientX: dx, pageX: dx });
}

describe("opacity", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = stubTrackWidth(100);
  });
  afterEach(() => restore());

  it("shows the current opacity as a percentage", () => {
    installScene(rectNode("a", "a0", { opacity: 0.4 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(screen.getByRole("slider", { name: "Opacity" })).toHaveValue("0.4");
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("ANNOUNCES the same percentage that is read next to the slider", () => {
    installScene(rectNode("a", "a0", { opacity: 0.4 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    // aria-valuetext is what a screen reader reads INSTEAD of the raw
    // aria-valuenow number (0.4): it must be the same thing that is seen,
    // otherwise whoever listens and whoever looks read two different values.
    const slider = screen.getByRole("slider", { name: "Opacity" });
    expect(slider).toHaveAttribute("aria-valuetext", "40%");
    expect(screen.getByText("40%")).toBeInTheDocument();
    // HOMOGENEOUS selection: no "mixed" state anywhere.
    expect(sliderThumb("Opacity").closest("[data-mixed]")).toBeNull();
  });

  it("a drag is ONE gesture: one op on the wire, one undo entry", () => {
    installScene(rectNode("a", "a0", { opacity: 1 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    // -50px on a 100-wide track = -50% opacity: 1 -> 0.5.
    dragSlider("Opacity", -50);

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(maskOf(op)).toEqual(["opacity"]);
      expect(op.kind.value.patch?.opacity).toBeCloseTo(0.5, 5);
    }
    expect(useScene.getState().scene?.nodes.at("a").opacity).toBeCloseTo(0.5, 5);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("during the drag it updates as a PREVIEW, without sending anything", () => {
    installScene(rectNode("a", "a0", { opacity: 1 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    const thumb = sliderThumb("Opacity");
    const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
    fireEvent.pointerDown(thumb, { ...base, clientX: 0, pageX: 0 });
    fireEvent.pointerMove(window, { ...base, clientX: -20, pageX: -20 });

    expect(useScene.getState().scene?.nodes.at("a").opacity).toBeCloseTo(0.8, 5);
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().gesture).not.toBeNull();

    fireEvent.pointerUp(window, { ...base, clientX: -20, pageX: -20 });
    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("a click on the slider without moving it opens no gesture", () => {
    installScene(rectNode("a", "a0", { opacity: 1 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragSlider("Opacity", 0);

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack.length).toBe(undoBefore);
    expect(useScene.getState().gesture).toBeNull();
  });
});

// Selection with DIFFERENT opacities: the slider has no value to show.
// A slider however always has a position, and the accessible value of an
// <input type=range> is its number: giving it a plausible one (1, that is
// 100%) means ANNOUNCING a value that does not exist -- and showing it, with the
// thumb at the end of the track, while the text next to it says the opposite. These
// tests block that regression: "mixed" must reach whoever looks AND whoever
// listens, and it must be the SAME word.
describe("mixed opacity", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = stubTrackWidth(100);
  });
  afterEach(() => restore());

  function installMixed() {
    installScene(rectNode("a", "a0", { opacity: 0.2 }), rectNode("b", "a1", { opacity: 0.9 }));
    useScene.getState().setSelection(["a", "b"]);
  }

  it("the ANNOUNCED value says mixed, not an invented percentage", () => {
    installMixed();
    render(<PropertiesPanel />);

    const slider = screen.getByRole("slider", { name: "Opacity" });
    expect(slider).toHaveAttribute("aria-valuetext", "Mixed");
    // No percentage, anywhere in the panel: neither announced nor
    // written. "100%" would be exactly the invented value.
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("shown and announced are the SAME word", () => {
    installMixed();
    render(<PropertiesPanel />);

    const shown = screen.getByText("Mixed");
    const slider = screen.getByRole("slider", { name: "Opacity" });
    expect(slider.getAttribute("aria-valuetext")).toBe(shown.textContent);
  });

  it("the slider is drawn EMPTY: no fake position", () => {
    installMixed();
    render(<PropertiesPanel />);

    // The "mixed" state sits in the DOM (on the track, which also carries the thumb),
    // not in a string of classes: it is from there that the CSS removes the fill
    // from the rail and the thumb, as ColorField/NumberField empty themselves.
    expect(sliderThumb("Opacity").closest("[data-mixed]")).not.toBeNull();
  });

  it("it stays usable: dragging it assigns the same opacity to all, in ONE gesture", () => {
    installMixed();
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragSlider("Opacity", -50);

    // One op per node but ONE single gesture: one undo entry, like for every other
    // multiple change in the panel.
    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) expect(maskOf(op)).toEqual(["opacity"]);
    const scene = useScene.getState().scene;
    expect(scene?.nodes.at("a").opacity).toBeCloseTo(0.5, 5);
    expect(scene?.nodes.at("b").opacity).toBeCloseTo(0.5, 5);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
    // Once a value is assigned, "mixed" disappears from both channels.
    expect(screen.getByRole("slider", { name: "Opacity" })).toHaveAttribute("aria-valuetext", "50%");
    expect(sliderThumb("Opacity").closest("[data-mixed]")).toBeNull();
  });

  it("changing selection the 'Mixed' does not stay hanging", () => {
    installScene(
      rectNode("a", "a0", { opacity: 0.2 }),
      rectNode("b", "a1", { opacity: 0.9 }),
      // Opacity 1: EXACTLY the fallback value the slider uses in the
      // mixed case to have a position. The number React sees therefore
      // does NOT change going from mixed to single, and an attribute written
      // only once would stay stuck on "Mixed" -- announcing "mixed" for a
      // node with a precise opacity. It is the reason the announced value
      // is rewritten on every render.
      rectNode("c", "a2", { opacity: 1 }),
    );
    useScene.getState().setSelection(["a", "b"]);
    const { rerender } = render(<PropertiesPanel />);
    expect(screen.getByRole("slider", { name: "Opacity" })).toHaveAttribute("aria-valuetext", "Mixed");

    useScene.getState().setSelection(["c"]);
    rerender(<PropertiesPanel />);

    expect(screen.getByRole("slider", { name: "Opacity" })).toHaveAttribute("aria-valuetext", "100%");
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.queryByText("Mixed")).toBeNull();
    expect(sliderThumb("Opacity").closest("[data-mixed]")).toBeNull();
  });
});

describe("corner radius", () => {
  it("appears ONLY for rectangles", () => {
    installScene(rectNode("a", "a0"), ellipseNode("e", "a1"), textNode("t", "a2"));

    useScene.getState().setSelection(["a"]);
    const { rerender } = render(<PropertiesPanel />);
    expect(screen.getByRole("textbox", { name: "R" })).toBeInTheDocument();

    useScene.getState().setSelection(["e"]);
    rerender(<PropertiesPanel />);
    expect(screen.queryByRole("textbox", { name: "R" })).toBeNull();

    useScene.getState().setSelection(["t"]);
    rerender(<PropertiesPanel />);
    expect(screen.queryByRole("textbox", { name: "R" })).toBeNull();

    // Mixed rectangle+ellipse selection: there is no radius to show.
    useScene.getState().setSelection(["a", "e"]);
    rerender(<PropertiesPanel />);
    expect(screen.queryByRole("textbox", { name: "R" })).toBeNull();
  });

  it("emits the `corner_radius` mask and survives the protojson round-trip", async () => {
    installScene(rectNode("a", "a0", { cornerRadius: 0 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(screen.getByRole("textbox", { name: "R" }));
    await user.type(screen.getByRole("textbox", { name: "R" }), "12{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(maskOf(op)).toEqual(["corner_radius"]);

    // THE multi-word path test: on the wire the FieldMask travels in
    // lowerCamelCase ("cornerRadius"), and fieldMaskToJson THROWS if the
    // conversion is not reversible. A hand-written "cornerRadius" in
    // MASK_PATHS would make THIS line fail, not a distant test.
    const wire = toJson(OpSchema, op) as { setProps?: { mask?: string } };
    expect(wire.setProps?.mask).toBe("cornerRadius");
    const back = fromJson(OpSchema, wire);
    expect(maskOf(back)).toEqual(["corner_radius"]);
    if (back.kind.case === "setProps") {
      const patch = back.kind.value.patch;
      expect(patch?.shape.case).toBe("rect");
      if (patch?.shape.case === "rect") expect(patch.shape.value.cornerRadius).toBe(12);
    }

    expect(useScene.getState().scene?.nodes.at("a").cornerRadius).toBe(12);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("dragging its label stays ONE gesture", () => {
    installScene(rectNode("a", "a0", { cornerRadius: 2 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("R", 6);

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["corner_radius"]);
    expect(useScene.getState().scene?.nodes.at("a").cornerRadius).toBe(8);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
  });
});

// --- Task 11: multiple selection with mixed values ---------------------------
//
// The gesture architecture (commit/scrub already operate on ALL of store.selection,
// not on a single id) and the MIXED summary (selectors.ts::selectionSummary)
// exist since Task 9/10: these tests block the behavior the brief
// explicitly requires, some of which were so far proven only for
// opacity (which has its dedicated channel, the slider). Here the same
// guarantee extends to the NumberField/ColorField/RadioGroup fields: a
// different value among the selected nodes is shown EMPTY with a "Mixed" placeholder
// (never "0", which the user would read as the real value), the same value
// everywhere is shown for what it is, and confirming a value in the mixed field
// writes it on EVERY selected node in a SINGLE gesture.

describe("multiple selection — mixed geometric fields", () => {
  it("a field with different values is shown EMPTY with placeholder 'Mixed', not 0", () => {
    installScene(rectNode("a", "a0", { x: 10 }), rectNode("b", "a1", { x: 50 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    const x = field("X");
    expect(x).toHaveValue("");
    expect(x).not.toHaveValue("0");
    expect(x).toHaveAttribute("placeholder", "Mixed");
  });

  it("a field with the SAME value on all nodes shows it, without a placeholder", () => {
    installScene(rectNode("a", "a0", { y: 7 }), rectNode("b", "a1", { y: 7 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    const y = field("Y");
    expect(y).toHaveValue("7");
    expect(y).not.toHaveAttribute("placeholder");
  });

  it("typing in a mixed field applies it to ALL the selected nodes in ONE gesture", async () => {
    installScene(rectNode("a", "a0", { x: 10 }), rectNode("b", "a1", { x: 50 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(field("X"));
    await user.type(field("X"), "99{Enter}");

    // One op PER NODE, but a single gesture: each op's patch carries the same
    // absolute typed value, not a translation relative to each node's
    // starting position.
    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) {
      expect(op.kind.case).toBe("setProps");
      if (op.kind.case === "setProps") {
        expect(op.kind.value.mask?.paths).toEqual(["x"]);
        expect(op.kind.value.patch?.x).toBe(99);
      }
    }
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(99);
    expect(useScene.getState().scene?.nodes.at("b").x).toBe(99);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
    // A value now exists for the whole selection: "mixed" disappears.
    expect(field("X")).toHaveValue("99");
    expect(field("X")).not.toHaveAttribute("placeholder");
  });

  it("dragging the label of a mixed field opens no gesture: there is no starting value to scrub from", () => {
    installScene(rectNode("a", "a0", { x: 10 }), rectNode("b", "a1", { x: 50 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("X", 25);

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(10);
    expect(useScene.getState().scene?.nodes.at("b").x).toBe(50);
    expect(useScene.getState().undoStack.length).toBe(undoBefore);
    expect(useScene.getState().gesture).toBeNull();
  });
});

describe("multiple selection — corner radius", () => {
  it("different values among rectangles are shown EMPTY with a placeholder, the field stays VISIBLE (same kind)", () => {
    installScene(rectNode("a", "a0", { cornerRadius: 2 }), rectNode("b", "a1", { cornerRadius: 8 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    const r = screen.getByRole("textbox", { name: "R" });
    expect(r).toHaveValue("");
    expect(r).toHaveAttribute("placeholder", "Mixed");
  });

  it("confirming a mixed radius applies it to ALL the selected rectangles in ONE gesture", async () => {
    installScene(rectNode("a", "a0", { cornerRadius: 2 }), rectNode("b", "a1", { cornerRadius: 8 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(screen.getByRole("textbox", { name: "R" }));
    await user.type(screen.getByRole("textbox", { name: "R" }), "5{Enter}");

    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) expect(maskOf(op)).toEqual(["corner_radius"]);
    expect(useScene.getState().scene?.nodes.at("a").cornerRadius).toBe(5);
    expect(useScene.getState().scene?.nodes.at("b").cornerRadius).toBe(5);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("a selection that mixes rectangles and non-rectangles does not show the field: no radius holds for ALL the types", () => {
    installScene(rectNode("a", "a0", { cornerRadius: 2 }), ellipseNode("e", "a1"));
    useScene.getState().setSelection(["a", "e"]);
    render(<PropertiesPanel />);

    expect(screen.queryByRole("textbox", { name: "R" })).toBeNull();
  });
});

describe("multiple selection — fill", () => {
  it("different tints are shown EMPTY with placeholder 'Mixed', not a random color", () => {
    installScene(
      rectNode("a", "a0", { fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
      rectNode("b", "a1", { fills: [{ r: 0, g: 1, b: 0, a: 0.5 }] }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    const input = screen.getByRole("textbox", { name: "Fill" });
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Mixed");
  });

  it("confirming a color on a mixed fill applies it to ALL in ONE gesture, each with its OWN alpha", async () => {
    installScene(
      rectNode("a", "a0", { fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
      rectNode("b", "a1", { fills: [{ r: 0, g: 1, b: 0, a: 0.5 }] }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    const input = screen.getByRole("textbox", { name: "Fill" });
    await user.clear(input);
    await user.type(input, "#0000FF{Enter}");

    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) expect(maskOf(op)).toEqual(["fills"]);
    const scene = useScene.getState().scene;
    expect(scene?.nodes.at("a").fills[0].b).toBeCloseTo(1, 5);
    expect(scene?.nodes.at("a").fills[0].a).toBe(1);
    expect(scene?.nodes.at("b").fills[0].b).toBeCloseTo(1, 5);
    // Each node's alpha survives: the field does not carry it.
    expect(scene?.nodes.at("b").fills[0].a).toBe(0.5);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });
});

describe("multiple selection — text style", () => {
  it("a different weight among the texts shows no selected choice", () => {
    installScene(
      textNode("t1", "a0", "one", { text: { content: "one", style: { ...TEXT_STYLE, fontWeight: "400" } } }),
      textNode("t2", "a1", "two", { text: { content: "two", style: { ...TEXT_STYLE, fontWeight: "700" } } }),
    );
    useScene.getState().setSelection(["t1", "t2"]);
    render(<PropertiesPanel />);

    expect(screen.getByRole("radio", { name: "Normal" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Bold" })).not.toBeChecked();
  });

  it("choosing a weight applies it to ALL the selected texts in ONE gesture, keeping each one's content", async () => {
    installScene(
      textNode("t1", "a0", "one", { text: { content: "one", style: { ...TEXT_STYLE, fontWeight: "400" } } }),
      textNode("t2", "a1", "two", { text: { content: "two", style: { ...TEXT_STYLE, fontWeight: "700" } } }),
    );
    useScene.getState().setSelection(["t1", "t2"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.click(screen.getByRole("radio", { name: "Bold" }));

    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) expect(op.kind.case).toBe("setText");
    const scene = useScene.getState().scene;
    expect(scene?.nodes.at("t1").text?.style.fontWeight).toBe("700");
    expect(scene?.nodes.at("t2").text?.style.fontWeight).toBe("700");
    expect(scene?.nodes.at("t1").text?.content).toBe("one");
    expect(scene?.nodes.at("t2").text?.content).toBe("two");
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });
});

// --- Step 3: for text nodes, the style controls ------------------------

describe("text style", () => {
  it("appears ONLY for text nodes", () => {
    installScene(rectNode("a", "a0"), textNode("t", "a1"));

    useScene.getState().setSelection(["a"]);
    const { rerender } = render(<PropertiesPanel />);
    expect(screen.queryByRole("textbox", { name: "Size" })).toBeNull();

    useScene.getState().setSelection(["t"]);
    rerender(<PropertiesPanel />);
    expect(screen.getByRole("textbox", { name: "Size" })).toHaveValue("16");
    expect(screen.getByRole("radio", { name: "Normal" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Left" })).toBeChecked();
  });

  it("the size emits ONE SetText with stylePresent and the content unchanged", async () => {
    installScene(textNode("t", "a0", "hello"));
    useScene.getState().setSelection(["t"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(screen.getByRole("textbox", { name: "Size" }));
    await user.type(screen.getByRole("textbox", { name: "Size" }), "32{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setText");
    if (op.kind.case === "setText") {
      expect(op.kind.value.id).toBe("t");
      // The content is ALWAYS written (core.applySetText): omitting it would
      // erase it.
      expect(op.kind.value.content).toBe("hello");
      expect(op.kind.value.stylePresent).toBe(true);
      expect(op.kind.value.style?.fontSize).toBe(32);
      // The other style fields stay the node's.
      expect(op.kind.value.style?.fontWeight).toBe("400");
      expect(op.kind.value.style?.fontFamily).toBe("Inter, sans-serif");
    }
    expect(useScene.getState().scene?.nodes.at("t").text?.style.fontSize).toBe(32);
    expect(useScene.getState().scene?.nodes.at("t").text?.content).toBe("hello");
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("the weight emits SetText with stylePresent", async () => {
    installScene(textNode("t", "a0", "hello"));
    useScene.getState().setSelection(["t"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Bold" }));

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setText");
    if (op.kind.case === "setText") {
      expect(op.kind.value.stylePresent).toBe(true);
      expect(op.kind.value.style?.fontWeight).toBe("700");
      expect(op.kind.value.style?.fontSize).toBe(16);
    }
    expect(useScene.getState().scene?.nodes.at("t").text?.style.fontWeight).toBe("700");
  });

  it("the alignment emits SetText with stylePresent", async () => {
    installScene(textNode("t", "a0", "hello"));
    useScene.getState().setSelection(["t"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    // Inside the "Alignment" group: since M2 there is also a stroke "Position"
    // with its own "Center" (the group, not the option, is what tells them
    // apart -- see STROKE_ALIGNMENTS in PropertiesPanel.tsx).
    await user.click(radioIn("Alignment", "Center"));

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setText");
    if (op.kind.case === "setText") {
      expect(op.kind.value.stylePresent).toBe(true);
      // TextAlign.CENTER === 2 in the generated code; the model reads it back as "center".
      expect(op.kind.value.style?.align).toBe(2);
    }
    expect(useScene.getState().scene?.nodes.at("t").text?.style.align).toBe("center");
  });

  it("on several texts it is ONE gesture, and each node keeps its OWN content", async () => {
    installScene(
      textNode("t1", "a0", "one"),
      textNode("t2", "a1", "two", { text: { content: "two", style: { ...TEXT_STYLE, fontWeight: "700" } } }),
    );
    useScene.getState().setSelection(["t1", "t2"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(screen.getByRole("textbox", { name: "Size" }));
    await user.type(screen.getByRole("textbox", { name: "Size" }), "20{Enter}");

    expect(sync.sent).toHaveLength(2);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    const scene = useScene.getState().scene;
    expect(scene?.nodes.at("t1").text).toEqual({ content: "one", style: { ...TEXT_STYLE, fontSize: 20 } });
    // t2's different weight is not flattened by a size change.
    expect(scene?.nodes.at("t2").text).toEqual({
      content: "two", style: { ...TEXT_STYLE, fontSize: 20, fontWeight: "700" },
    });
  });
});

// --- M2, track 2: the STROKE ------------------------------------------------
//
// Same shape as the fill/opacity controls: color in hexadecimal at the
// UI edge, absolute values on the whole selection, and the gesture rule (one
// drag = ONE gesture, so one op on the wire and one undo entry).

function strokeOf(weight: number, align: StrokeAlignLite, color = { r: 0, g: 0, b: 0, a: 1 }): StrokeLite {
  return { color, weight, align };
}

// The radio `name` INSIDE group `group`: "Center" exists both among the stroke
// positions and among the text alignments, and on a text node
// with a stroke the two groups coexist in the panel.
function radioIn(group: string, name: string): HTMLElement {
  return within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });
}

describe("stroke", () => {
  it("shows color, thickness and position of the first stroke", () => {
    installScene(rectNode("a", "a0", { strokes: [strokeOf(4, "outside", { r: 1, g: 0.5, b: 0, a: 1 })] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(screen.getByRole("textbox", { name: "Stroke" })).toHaveValue("#FF8000");
    expect(field("Thickness")).toHaveValue("4");
    expect(radioIn("Position", "Outside")).toBeChecked();
  });

  it("a node WITHOUT strokes shows the empty field, thickness 0 and position at the center", () => {
    installScene(rectNode("a", "a0", { strokes: [] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(screen.getByRole("textbox", { name: "Stroke" })).toHaveValue("");
    expect(field("Thickness")).toHaveValue("0");
    expect(radioIn("Position", "Center")).toBeChecked();
  });

  it("writing a color on a node without strokes CREATES a visible one (1 px, centered)", async () => {
    installScene(rectNode("a", "a0", { strokes: [] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    const input = screen.getByRole("textbox", { name: "Stroke" });
    await user.clear(input);
    await user.type(input, "#FF0000{Enter}");

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["strokes"]);
    const strokes = useScene.getState().scene?.nodes.at("a").strokes ?? [];
    expect(strokes).toHaveLength(1);
    expect(strokes[0].color.r).toBeCloseTo(1, 5);
    // A fallback weight > 0: a stroke created with weight 0 would not be seen, and
    // the user would have written a color with no visible effect.
    expect(strokes[0].weight).toBe(1);
    expect(strokes[0].align).toBe("center");
    // One gesture, one undo entry.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  // Alpha does NOT go through the hex field (see fields/ColorField.tsx): it is
  // put back by strokeOps taking it from the NODE's stroke. Twin of "keeps
  // the NODE's alpha, not any" for the fill.
  it("changing the color keeps the NODE's alpha", async () => {
    installScene(rectNode("a", "a0", { strokes: [strokeOf(4, "inside", { r: 0, g: 0, b: 0, a: 0.25 })] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    const input = screen.getByRole("textbox", { name: "Stroke" });
    await user.clear(input);
    await user.type(input, "#00FF00{Enter}");

    // The color HAS changed (without this, the alpha assert would pass even
    // if the field had emitted NOTHING) but the alpha has not -- nor have weight
    // and position.
    const s = useScene.getState().scene?.nodes.at("a").strokes[0];
    expect(s?.color.g).toBeCloseTo(1, 5);
    expect(s?.color.a).toBe(0.25);
    expect(s?.weight).toBe(4);
    expect(s?.align).toBe("inside");
  });

  // The case the selection summary cannot serve: on different strokes
  // `summary.strokes` is MIXED, that is NO value to read an alpha from.
  // Taking it from there (or from its fallback 1) would silently destroy A's
  // 0.3 -- a change the user did not ask for and does not see until they look
  // at the canvas.
  it("on different strokes the color goes to all but each keeps its OWN alpha", async () => {
    installScene(
      rectNode("a", "a0", { strokes: [strokeOf(2, "center", { r: 1, g: 0, b: 0, a: 0.3 })] }),
      rectNode("b", "a1", { strokes: [strokeOf(9, "outside", { r: 0, g: 0, b: 1, a: 1 })] }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    const input = screen.getByRole("textbox", { name: "Stroke" });
    expect(input).toHaveValue("");
    await user.type(input, "#00FF00{Enter}");

    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) expect(maskOf(op)).toEqual(["strokes"]);
    const scene = useScene.getState().scene;
    expect(scene?.nodes.at("a").strokes[0].color.g).toBeCloseTo(1, 5);
    expect(scene?.nodes.at("b").strokes[0].color.g).toBeCloseTo(1, 5);
    expect(scene?.nodes.at("a").strokes[0].color.a).toBe(0.3);
    expect(scene?.nodes.at("b").strokes[0].color.a).toBe(1);
    // ...and the rest of each one's stroke stays theirs.
    expect(scene?.nodes.at("a").strokes[0].weight).toBe(2);
    expect(scene?.nodes.at("b").strokes[0].align).toBe("outside");
    // Two ops, ONE gesture: a single undo entry.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("changing the thickness keeps the stroke's color and position", async () => {
    installScene(rectNode("a", "a0", { strokes: [strokeOf(4, "inside", { r: 0, g: 1, b: 0, a: 0.5 })] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("Thickness"));
    await user.type(field("Thickness"), "12{Enter}");

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["strokes"]);
    expect(useScene.getState().scene?.nodes.at("a").strokes).toEqual([
      { color: { r: 0, g: 1, b: 0, a: 0.5 }, weight: 12, align: "inside" },
    ]);
  });

  it("the position keeps color and thickness", async () => {
    installScene(rectNode("a", "a0", { strokes: [strokeOf(4, "center", { r: 0, g: 0, b: 1, a: 1 })] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.click(radioIn("Position", "Inside"));

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["strokes"]);
    expect(useScene.getState().scene?.nodes.at("a").strokes).toEqual([
      { color: { r: 0, g: 0, b: 1, a: 1 }, weight: 4, align: "inside" },
    ]);
  });

  it("dragging the Thickness label is ONE gesture, not one per pixel", () => {
    installScene(rectNode("a", "a0", { strokes: [strokeOf(2, "center")] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("Thickness", 10);

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["strokes"]);
    expect(useScene.getState().scene?.nodes.at("a").strokes[0].weight).toBe(12);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("a stroke beyond the first is not lost", async () => {
    installScene(rectNode("a", "a0", {
      strokes: [strokeOf(2, "center"), strokeOf(8, "outside", { r: 1, g: 0, b: 0, a: 1 })],
    }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("Thickness"));
    await user.type(field("Thickness"), "5{Enter}");

    const strokes = useScene.getState().scene?.nodes.at("a").strokes ?? [];
    expect(strokes).toHaveLength(2);
    expect(strokes[0].weight).toBe(5);
    expect(strokes[1]).toEqual(strokeOf(8, "outside", { r: 1, g: 0, b: 0, a: 1 }));
  });

  it("on a selection with different strokes it says Mixed, and writing into it assigns to all", async () => {
    installScene(
      rectNode("a", "a0", { strokes: [strokeOf(2, "center")] }),
      rectNode("b", "a1", { strokes: [strokeOf(9, "outside")] }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    expect(field("Thickness")).toHaveValue("");
    expect(field("Thickness")).toHaveAttribute("placeholder", "Mixed");
    expect(screen.getByRole("textbox", { name: "Stroke" })).toHaveValue("");

    await user.type(field("Thickness"), "3{Enter}");

    // Two ops (one per node) but ONE single gesture: one undo entry.
    expect(sync.sent).toHaveLength(2);
    const scene = useScene.getState().scene;
    expect(scene?.nodes.at("a").strokes[0].weight).toBe(3);
    expect(scene?.nodes.at("b").strokes[0].weight).toBe(3);
    // ...and each node keeps ITS OWN position: changing the weight does not
    // flatten the rest.
    expect(scene?.nodes.at("a").strokes[0].align).toBe("center");
    expect(scene?.nodes.at("b").strokes[0].align).toBe("outside");
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
  });

  it("the stroke is there on an ellipse and on a text too (it is not inside the shape oneof)", () => {
    installScene(ellipseNode("e", "a0", { strokes: [strokeOf(3, "center")] }));
    useScene.getState().setSelection(["e"]);
    const { unmount } = render(<PropertiesPanel />);
    expect(field("Thickness")).toHaveValue("3");
    unmount();

    installScene(textNode("t", "a0", "hello", { strokes: [strokeOf(5, "center")] }));
    useScene.getState().setSelection(["t"]);
    render(<PropertiesPanel />);
    expect(field("Thickness")).toHaveValue("5");
  });
});

// --- ALIGNMENT (M2, track 2, task 3) ------------------------------------
//
// The alignment MATH is tested where it lives, as a pure function
// (selection/align.test.ts). Here we only verify that the panel is the way to
// reach it: that the buttons exist, that they have a readable name and that they
// really move the selection with ONE gesture.
describe("alignment", () => {
  it("does not show the buttons without a selection", () => {
    installScene(rectNode("a", "a0"));
    render(<PropertiesPanel />);
    expect(screen.queryByRole("button", { name: "Align left" })).toBeNull();
  });

  it("aligns the multiple selection to its common bounding box, in a single gesture", () => {
    installScene(
      rectNode("a", "a0", { x: 0, y: 0, width: 50, height: 50 }),
      rectNode("b", "a1", { x: 100, y: 30, width: 50, height: 50 }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Align left" }));

    const scene = useScene.getState().scene;
    expect(scene?.nodes.at("a").x).toBe(0);
    expect(scene?.nodes.at("b").x).toBe(0);
    expect(scene?.nodes.at("b").y).toBe(30); // the axis that does not concern it does not move
    expect(sync.sent).toHaveLength(1); // only "b" moved
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("distributes three nodes with a single button", () => {
    installScene(
      rectNode("a", "a0", { x: 0, y: 0, width: 10, height: 10 }),
      rectNode("b", "a1", { x: 15, y: 0, width: 10, height: 10 }),
      rectNode("c", "a2", { x: 90, y: 0, width: 10, height: 10 }),
    );
    useScene.getState().setSelection(["a", "b", "c"]);
    render(<PropertiesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Distribute horizontally" }));

    expect(useScene.getState().scene?.nodes.at("b").x).toBe(45);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  // A SINGLE NODE: the buttons are DISABLED and the node does not move. There is
  // no page to align it against (selection/align.ts), and a live
  // button that does nothing is indistinguishable from a broken one.
  it("with a single node the bar is not there (nothing to align) and nothing moves", () => {
    installScene(rectNode("a", "a0", { x: 500, y: 500, width: 50, height: 50 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(screen.queryByRole("group", { name: "Align" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Align left" })).not.toBeInTheDocument();
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(500); // where it was
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("with TWO nodes the six alignments turn on, the distributions do not", () => {
    installScene(rectNode("a", "a0"), rectNode("b", "a1", { x: 100 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    for (const name of [
      "Align left", "Center horizontally", "Align right",
      "Align top", "Center vertically", "Align bottom",
    ]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
    expect(screen.getByRole("button", { name: "Distribute horizontally" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Distribute vertically" })).toBeDisabled();
  });

  it("with THREE nodes everything turns on", () => {
    installScene(rectNode("a", "a0"), rectNode("b", "a1", { x: 100 }), rectNode("c", "a2", { x: 200 }));
    useScene.getState().setSelection(["a", "b", "c"]);
    render(<PropertiesPanel />);
    expect(screen.getByRole("button", { name: "Distribute horizontally" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Distribute vertically" })).toBeEnabled();
  });

  it("every command has its button with a readable name", () => {
    installScene(rectNode("a", "a0"), rectNode("b", "a1", { x: 100 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    for (const name of [
      "Align left", "Center horizontally", "Align right",
      "Distribute horizontally",
      "Align top", "Center vertically", "Align bottom",
      "Distribute vertically",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});

// --- Groups: the panel says the same thing the overlay draws ----------
//
// A group has no geometry of its own (store/groups.ts): its frame is the
// union of the children and its x/y are the TRANSLATION that contributes to them.
// The panel instead showed the raw fields -- W=0 H=0 on a group that is
// perfectly visible, and an X that is not the frame's left edge.
//   - W/H disappear as soon as the selection contains a group: there is no box to
//     rewrite, and the op would go out anyway (accepted by both
//     implementations of apply, invisible on canvas, a wasted undo entry);
//   - X/Y stay and for a group mean what they mean for all the
//     others: the top-left corner of the frame, in the parent's space.

function groupWithChild() {
  installScene(
    groupNode("g", "a1"),
    rectNode("c", "a0", { parentId: "g", x: 10, y: 20, width: 30, height: 40 }),
    rectNode("solo", "a2", { x: 200, y: 200 }),
  );
}

describe("groups — geometric fields", () => {
  it("a group does not show W/H: it has no box of its own to rewrite", () => {
    groupWithChild();

    useScene.getState().setSelection(["g"]);
    const { rerender } = render(<PropertiesPanel />);
    expect(field("X")).toBeInTheDocument();
    expect(field("Y")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "W" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "H" })).toBeNull();

    // The child is a rectangle like any other: the four fields are back.
    useScene.getState().setSelection(["c"]);
    rerender(<PropertiesPanel />);
    expect(screen.getByRole("textbox", { name: "W" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "H" })).toBeInTheDocument();
  });

  it("not even in a MIXED group+rectangle selection: the op would reach the group too", () => {
    groupWithChild();
    useScene.getState().setSelection(["g", "solo"]);
    render(<PropertiesPanel />);

    expect(screen.queryByRole("textbox", { name: "W" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "H" })).toBeNull();
    expect(field("X")).toBeInTheDocument();
  });

  it("X/Y show the FRAME's origin, not the group's (0,0) translation", () => {
    groupWithChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("g").x).toBe(0); // the group's translation IS zero...
    // ...but the frame the overlay draws sits at (10,20), and it is what the
    // panel must say.
    const frame = contentWorldBounds(scene, scene.nodes.at("g"))!;
    expect(field("X")).toHaveValue(String(frame.x));
    expect(field("Y")).toHaveValue(String(frame.y));
    expect(field("X")).toHaveValue("10");
    expect(field("Y")).toHaveValue("20");
  });

  it("typing X on a group brings the frame's LEFT EDGE there: ONE op, ONE undo entry", async () => {
    groupWithChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(field("X"));
    await user.type(field("X"), "99{Enter}");

    // A single op, and ABSOLUTE like every other setProps: the delta is resolved
    // when the op is built, it does not travel on the wire -- otherwise a rebase
    // (or a redo) would apply it a second time.
    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(maskOf(op)).toEqual(["x"]);
    if (op.kind.case === "setProps") expect(op.kind.value.patch?.x).toBe(89); // 0 + (99 - 10)

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("g").x).toBe(89);
    expect(scene.nodes.at("c").x).toBe(10); // the child does not move in its own space
    expect(contentWorldBounds(scene, scene.nodes.at("g"))!.x).toBe(99);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();

    // And it is undone like any other change: the frame goes back to 10.
    useScene.getState().undo();
    const after = useScene.getState().scene!;
    expect(after.nodes.at("g").x).toBe(0);
    expect(contentWorldBounds(after, after.nodes.at("g"))!.x).toBe(10);
  });

  it("confirming the X the field already shows sends no op", async () => {
    groupWithChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.click(field("X"));
    await user.keyboard("{Enter}");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.at("g").x).toBe(0);
  });

  it("dragging a group's X label stays ONE gesture and brings the frame where the field says", () => {
    groupWithChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("X", 25); // from the frame at 10 -> 35

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["x"]);
    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("g").x).toBe(25);
    // The preview's intermediate steps do not add up: the frame ends up
    // exactly where the field says, not at 10+12+25.
    expect(contentWorldBounds(scene, scene.nodes.at("g"))!.x).toBe(35);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  // A HIDDEN child is not content: the renderer does not draw it (and does not
  // hit it, and the marquee does not take it). The panel's X is the left
  // edge of the FRAME, and the frame is what is seen: if the hidden one also counted,
  // the number shown would be its edge, and typing into it
  // would bring IT to that X leaving the content visible elsewhere.
  function groupWithHiddenChild() {
    installScene(
      groupNode("g", "a1"),
      rectNode("hidden", "a0", { parentId: "g", x: 10, y: 20, width: 30, height: 40, visible: false }),
      rectNode("visible", "a1", { parentId: "g", x: 100, y: 0, width: 20, height: 20 }),
    );
  }

  it("X/Y show the edge of the VISIBLE content: a hidden child does not widen the frame", () => {
    groupWithHiddenChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);

    // With the hidden child inside the union, X would say 10 and Y would say 0.
    expect(field("X")).toHaveValue("100");
    expect(field("Y")).toHaveValue("0");
  });

  it("typing X on that group brings the VISIBLE content to that X", async () => {
    groupWithHiddenChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("X"));
    await user.type(field("X"), "99{Enter}");

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["x"]);
    // 0 + (99 - 100): the group's translation shifts by -1, not by +89
    // (which is what the hidden child's edge would give).
    if (sync.sent[0].kind.case === "setProps") expect(sync.sent[0].kind.value.patch?.x).toBe(-1);

    const scene = useScene.getState().scene!;
    expect(contentWorldBounds(scene, scene.nodes.at("g"))!.x).toBe(99);
    // The visible child is really there: 100 + (-1).
    expect(scene.nodes.at("g").x + scene.nodes.at("visible").x).toBe(99);
  });

  it("a group with ALL children hidden behaves like an empty one: X is its translation", async () => {
    installScene(
      groupNode("g", "a1", { x: 3, y: 4 }),
      rectNode("h1", "a0", { parentId: "g", x: 10, y: 20, visible: false }),
      rectNode("h2", "a1", { parentId: "g", x: 100, y: 0, visible: false }),
    );
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    expect(field("X")).toHaveValue("3");

    // And X is written ABSOLUTE, like for any group without a frame.
    await user.clear(field("X"));
    await user.type(field("X"), "50{Enter}");

    expect(sync.sent).toHaveLength(1);
    if (sync.sent[0].kind.case === "setProps") expect(sync.sent[0].kind.value.patch?.x).toBe(50);
    expect(useScene.getState().scene?.nodes.at("g").x).toBe(50);
  });

  it("an EMPTY group has no frame: X/Y stay its translation, written as is", async () => {
    installScene(groupNode("g", "a0", { x: 3, y: 4 }));
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    expect(field("X")).toHaveValue("3");

    await user.clear(field("X"));
    await user.type(field("X"), "50{Enter}");

    expect(sync.sent).toHaveLength(1);
    if (sync.sent[0].kind.case === "setProps") expect(sync.sent[0].kind.value.patch?.x).toBe(50);
    expect(useScene.getState().scene?.nodes.at("g").x).toBe(50);
  });
});

// --- M4: INSTANCE OVERRIDES ---------------------------------------------
//
// For a SINGLE selected instance the panel shows an "Override" section:
// one row for every MASTER node that is a text or has a fill, with its
// EFFECTIVE value (the instance's override if there is one, otherwise the
// master's value). Writing into it emits ONE SetInstanceOverride; "Reset" emits an
// EMPTY one (removal, goes back to inheriting). The two halves (fills/text) are
// independent: editing one keeps the other.

// Installs a master (frame `m` with a red rect "Background" and a text
// "Label") registered as component cmp1, plus an instance `inst` that
// renders it. `overrides` seeds the instance's overrides.
function installInstance(overrides: InstanceOverrideLite[] = []) {
  const scene = emptyScene("doc-1", "Untitled");
  const m: NodeLite = {
    ...rectNode("m", "a1"), kind: "frame", fills: [], x: 0, y: 0, width: 100, height: 100,
  };
  const mr: NodeLite = {
    ...rectNode("mr", "a1", { parentId: "m", name: "Background", fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
  };
  const mt: NodeLite = { ...textNode("mt", "a2", "Hello", { parentId: "m", name: "Label" }) };
  const inst: NodeLite = {
    ...rectNode("inst", "a9"), kind: "instance", instance: { componentId: "cmp1", overrides },
  };
  for (const n of [m, mr, mt, inst]) scene.nodes = scene.nodes.set(n.id, n);
  scene.components["cmp1"] = { rootNodeId: "m", name: "Frame" };
  useScene.getState().setScene(scene);
  useScene.getState().setSelection(["inst"]);
}

function overrideOf(op: Op) {
  if (op.kind.case !== "setInstanceOverride") throw new Error("not a setInstanceOverride op");
  return op.kind.value;
}

describe("instance overrides", () => {
  it("for an instance it shows the Override section with one row per overridable node of the master", () => {
    installInstance();
    render(<PropertiesPanel />);

    expect(screen.getByText("Override")).toBeInTheDocument();
    // EFFECTIVE value inherited from the master: the rect's red and the text.
    expect(screen.getByRole("textbox", { name: "Background" })).toHaveValue("#FF0000");
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue("Hello");
  });

  it("editing the fill of a master node emits ONE SetInstanceOverride and updates the shown value", async () => {
    installInstance();
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    const input = screen.getByRole("textbox", { name: "Background" });
    await user.clear(input);
    await user.type(input, "#00FF00{Enter}");

    expect(sync.sent).toHaveLength(1);
    const o = overrideOf(sync.sent[0]);
    expect(o.instanceId).toBe("inst");
    expect(o.override?.masterNodeId).toBe("mr");
    expect(o.override?.fillsPresent).toBe(true);
    // The text is NOT touched: text_present stays false.
    expect(o.override?.textPresent).toBe(false);
    if (o.override?.fills[0]?.kind.case === "solid") {
      expect(o.override.fills[0].kind.value.color?.g).toBeCloseTo(1, 5);
    }
    // The model now has the override, and the field shows the new value.
    const inst = useScene.getState().scene!.nodes.at("inst");
    expect(inst.instance?.overrides).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Background" })).toHaveValue("#00FF00");
    // One gesture, one undo entry.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("editing the text of a master node emits ONE SetInstanceOverride with text_present", async () => {
    installInstance();
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    const input = screen.getByRole("textbox", { name: "Label" });
    await user.clear(input);
    await user.type(input, "New{Enter}");

    expect(sync.sent).toHaveLength(1);
    const o = overrideOf(sync.sent[0]);
    expect(o.override?.masterNodeId).toBe("mt");
    expect(o.override?.textPresent).toBe(true);
    expect(o.override?.text).toBe("New");
    expect(o.override?.fillsPresent).toBe(false);
    expect(useScene.getState().scene!.nodes.at("inst").instance?.overrides[0].text).toBe("New");
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue("New");
  });

  it("Reset is disabled without an override and active with an override; pressing it emits a REMOVAL", async () => {
    // Seeds a fill override on "mr".
    installInstance([{ masterNodeId: "mr", fills: [{ r: 0, g: 0, b: 1, a: 1 }] }]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    // The field shows the OVERRIDDEN value (blue), not the master's.
    expect(screen.getByRole("textbox", { name: "Background" })).toHaveValue("#0000FF");
    // Reset active for "mr" (there is an override), disabled for "mt" (there is none).
    const resetBackground = screen.getByRole("button", { name: "Reset Background" });
    expect(resetBackground).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reset Label" })).toBeDisabled();

    await user.click(resetBackground);

    expect(sync.sent).toHaveLength(1);
    const o = overrideOf(sync.sent[0]);
    expect(o.override?.masterNodeId).toBe("mr");
    // EMPTY override = removal: both *_present false.
    expect(o.override?.fillsPresent).toBe(false);
    expect(o.override?.textPresent).toBe(false);
    // The override is gone, and the field goes back to the master's value (red).
    expect(useScene.getState().scene!.nodes.at("inst").instance?.overrides).toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "Background" })).toHaveValue("#FF0000");
  });

  it("an override is undone with Ctrl+Z (a single gesture)", async () => {
    installInstance();
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    const input = screen.getByRole("textbox", { name: "Background" });
    await user.clear(input);
    await user.type(input, "#00FF00{Enter}");
    expect(useScene.getState().scene!.nodes.at("inst").instance?.overrides).toHaveLength(1);

    useScene.getState().undo();

    expect(useScene.getState().scene!.nodes.at("inst").instance?.overrides).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(1);
  });
});
