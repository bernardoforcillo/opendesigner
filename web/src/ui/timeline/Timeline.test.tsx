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

// The timeline pieces under jsdom: what it shows, what it writes (one op per gesture),
// the keyboard inside the panel. Drawing on the canvas and real dragging
// are in the renderer / logic tests and in the browser verification.

// jsdom does not measure: the timeline falls back to 720 px of width, so the lane is (720 - labels - margins 16+28) px for the whole duration
const PPM = (720 - LABEL_W - 16 - 28) / 1000;

const clip = (over: Partial<ClipLite> = {}): ClipLite => ({
  id: "k", name: "Entrance", duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "A",
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

describe("TimelinePanel: opening", () => {
  it("closed it renders nothing", () => {
    useTimeline.setState({ open: false });
    const { container } = render(<TimelinePanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("open without an open clip: the empty state that says what to do, with the clip list", () => {
    render(<TimelinePanel />);
    expect(screen.getByRole("region", { name: "Timeline" })).toBeInTheDocument();
    expect(screen.getByText("Animate something: select a layer and press + Property")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Clip list" })).getByText("Entrance")).toBeInTheDocument();
  });

  it("with no clip in the document it says so and 'New clip' creates ONE with a single gesture", async () => {
    install(baseScene());
    useScene.getState().setSelection(["btn"]);
    render(<TimelinePanel />);
    expect(screen.getByText("No clips. Create one with +.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create a clip" }));
    expect(Object.keys(sc().clips)).toHaveLength(1);
    const c = Object.values(sc().clips)[0];
    expect(c.targetId).toBe("A");
    expect(tl().clipId).toBe(c.id);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("choosing a clip from the list opens it (and shows tracks and settings)", async () => {
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: /Entrance/ }));
    expect(tl().clipId).toBe("k");
    expect(screen.getByRole("button", { name: "Clip settings" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Opacity track of btn" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "X track of btn" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Keyframe at/ })).toHaveLength(4);
  });

  it("a clip without tracks shows the invitation to use + Property", () => {
    install({ ...baseScene(), clips: { k: clip({ tracks: [] }) } });
    tl().openClip("k");
    render(<TimelinePanel />);
    expect(screen.getByText("Animate something: select a layer and press + Property")).toBeInTheDocument();
  });
});

describe("clip settings: one SetClip per change", () => {
  beforeEach(() => tl().openClip("k"));
  // The settings live in a popover from the transport bar: they are opened first.
  const openSettings = () => userEvent.click(screen.getByRole("button", { name: "Clip settings" }));

  it("the trigger", async () => {
    render(<TimelinePanel />);
    await openSettings();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Trigger" }), "hover");
    expect(sc().clips.k.trigger).toBe("hover");
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("the name commits on Enter, only once", async () => {
    render(<TimelinePanel />);
    await openSettings();
    const input = screen.getByRole("textbox", { name: "Clip name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Appearance{Enter}");
    expect(sc().clips.k.name).toBe("Appearance");
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("the duration: keyframes beyond the new end move to the end", async () => {
    render(<TimelinePanel />);
    await openSettings();
    const field = screen.getByRole("textbox", { name: "Duration" });
    await userEvent.clear(field);
    await userEvent.type(field, "300{Enter}");
    expect(sc().clips.k.duration).toBe(300);
    expect(sc().clips.k.tracks[0].keyframes.map((k) => k.time)).toEqual([0, 300]);
  });

  it("infinite and yoyo", async () => {
    render(<TimelinePanel />);
    await openSettings();
    await userEvent.click(screen.getByRole("button", { name: "Repeat forever" }));
    expect(sc().clips.k.repeat).toBe(-1);
    await userEvent.click(screen.getByRole("button", { name: "Yoyo" }));
    expect(sc().clips.k.yoyo).toBe(true);
    expect(useScene.getState().undoStack).toHaveLength(2);
  });

  it("the target is one of the document's frames/groups", async () => {
    render(<TimelinePanel />);
    await openSettings();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Target" }), "B");
    expect(sc().clips.k.targetId).toBe("B");
  });

  it("duplicate and delete from the list", async () => {
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Duplicate the clip" }));
    expect(Object.keys(sc().clips)).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Delete the clip" }));
    expect(Object.keys(sc().clips)).toHaveLength(1);
    expect(tl().clipId).toBeNull();
  });
});

describe("keyframe: selection, inspector, keyboard", () => {
  beforeEach(() => tl().openClip("k"));
  const kf = (name: RegExp | string) => screen.getAllByRole("button", { name: new RegExp(`^Keyframe at ${name}`) })[0];

  it("clicking a keyframe selects it, moves the playhead there and shows the inspector", () => {
    render(<TimelinePanel />);
    fireEvent.pointerDown(kf("500 ms"), { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(kf("500 ms"), { button: 0, pointerId: 1, clientX: 100 });
    expect(tl().selection).toEqual([{ track: 0, key: 1 }]);
    expect(tl().playhead).toBe(500);
    const insp = screen.getByRole("complementary", { name: "Keyframe" });
    expect(within(insp).getByRole("textbox", { name: "Time" })).toHaveValue("500");
    // the last keyframe has no segment after it: no curve
    expect(within(insp).queryByRole("combobox", { name: "Easing" })).not.toBeInTheDocument();
    // the first does, and shows its curve
    fireEvent.pointerDown(kf("0 ms"), { button: 0, pointerId: 1, clientX: 20 });
    fireEvent.pointerUp(kf("0 ms"), { button: 0, pointerId: 1, clientX: 20 });
    expect(within(screen.getByRole("complementary", { name: "Keyframe" })).getByRole("combobox", { name: "Easing" })).toHaveValue("linear");
    expect(screen.getByRole("group", { name: "Easing curve" })).toBeInTheDocument();
  });

  it("the inspector changes value and easing with ONE op each", async () => {
    render(<TimelinePanel />);
    fireEvent.pointerDown(kf("500 ms"), { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(kf("500 ms"), { button: 0, pointerId: 1, clientX: 100 });
    const insp = screen.getByRole("complementary", { name: "Keyframe" });
    const v = within(insp).getByRole("textbox", { name: "Value" });
    await userEvent.clear(v);
    await userEvent.type(v, "0.4{Enter}");
    expect(sc().clips.k.tracks[0].keyframes[1].value).toBe(0.4);
    fireEvent.pointerDown(kf("0 ms"), { button: 0, pointerId: 1, clientX: 20 });
    fireEvent.pointerUp(kf("0 ms"), { button: 0, pointerId: 1, clientX: 20 });
    await userEvent.selectOptions(within(screen.getByRole("complementary", { name: "Keyframe" })).getByRole("combobox", { name: "Easing" }), "spring");
    expect(sc().clips.k.tracks[0].keyframes[0].easing).toBe("spring");
    expect(useScene.getState().undoStack).toHaveLength(2);
  });

  it("Delete removes the selected keyframes (ONE op) and NOT the layers selected on the canvas", () => {
    useScene.getState().setSelection(["btn"]);
    render(<TimelinePanel />);
    const b = kf("500 ms");
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(b, { button: 0, pointerId: 1, clientX: 100 });
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    fireEvent.keyDown(screen.getByRole("region", { name: "Timeline" }), { key: "Delete" });
    window.removeEventListener("keydown", onWindow);
    expect(onWindow).not.toHaveBeenCalled(); // the key does not reach the global listeners (which would delete the node)
    expect(sc().clips.k.tracks[0].keyframes.map((k) => k.time)).toEqual([0]);
    expect(sc().nodes.has("btn")).toBe(true);
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(tl().selection).toEqual([]);
  });

  it("Ctrl+D duplicates at the playhead; the arrows move by one grid step", () => {
    render(<TimelinePanel />);
    const b = kf("500 ms");
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(b, { button: 0, pointerId: 1, clientX: 100 });
    tl().setPlayhead(700);
    fireEvent.keyDown(screen.getByRole("region", { name: "Timeline" }), { key: "d", ctrlKey: true });
    expect(sc().clips.k.tracks[0].keyframes.map((k) => k.time)).toEqual([0, 500, 700]);
    // the selection is now the copy (at 700): right arrow = +10 ms
    const copy = screen.getAllByRole("button", { name: /^Keyframe at 700 ms/ })[0];
    fireEvent.keyDown(copy, { key: "ArrowRight" });
    expect(sc().clips.k.tracks[0].keyframes.map((k) => k.time)).toEqual([0, 500, 710]);
  });

  it("dragging a keyframe: draft during the gesture, ONE op on release, snapped to the grid", () => {
    render(<TimelinePanel />);
    const b = kf("500 ms");
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 200 });
    // +50 px = +107 ms at PPM px/ms: 500 + 107 = 607 -> grid 610
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 250 });
    expect(tl().draftClip?.tracks[0].keyframes[1].time).toBe(610);
    expect(useScene.getState().undoStack).toHaveLength(0); // no op during the drag
    expect(sc().clips.k.tracks[0].keyframes[1].time).toBe(500);
    fireEvent.pointerUp(b, { pointerId: 1, clientX: 250 });
    expect(sc().clips.k.tracks[0].keyframes[1].time).toBe(610);
    expect(tl().draftClip).toBeNull();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(tl().selection).toEqual([{ track: 0, key: 1 }]);
  });

  it("Shift releases snapping", () => {
    render(<TimelinePanel />);
    const b = kf("500 ms");
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 250, shiftKey: true });
    expect(tl().draftClip?.tracks[0].keyframes[1].time).toBe(607);
    fireEvent.pointerCancel(b, { pointerId: 1 });
    expect(tl().draftClip).toBeNull();
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("a wobble under the threshold is a click, not a drag", () => {
    render(<TimelinePanel />);
    const b = kf("500 ms");
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 201 });
    expect(tl().draftClip).toBeNull();
    fireEvent.pointerUp(b, { pointerId: 1, clientX: 201 });
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("a double click on a row adds a keyframe with the sampled value", () => {
    render(<TimelinePanel />);
    const lane = screen.getByRole("group", { name: "Opacity track of btn" });
    // x = 16 (PAD) + 250 ms * PPM; getBoundingClientRect in jsdom is all zeros
    fireEvent.doubleClick(lane, { clientX: 16 + 250 * PPM });
    const ks = sc().clips.k.tracks[0].keyframes;
    expect(ks.map((k) => k.time)).toEqual([0, 250, 500]);
    expect(ks[1].value).toBeGreaterThan(0.3); // easing "" (linear) between 0 and 1 with an easeOut curve after: sampled, not zero
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("the row's button adds a keyframe at the playhead", async () => {
    tl().setPlayhead(300);
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Add a keyframe at the playhead on X" }));
    expect(sc().clips.k.tracks[1].keyframes.map((k) => k.time)).toEqual([100, 300, 800]);
  });

  it("removing a track", async () => {
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Remove the X track" }));
    expect(sc().clips.k.tracks.map((t) => t.prop)).toEqual(["opacity"]);
  });
});

describe("transport", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    tl().openClip("k");
  });

  it("Space with focus inside the timeline toggles play/pause, and does not reach the global pan", () => {
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

  it("outside the timeline space stays the pan's: nobody listens on the window for this", () => {
    render(<TimelinePanel />);
    fireEvent.keyDown(window, { code: "Space", key: " " });
    expect(tl().playing).toBe(false);
  });

  it("buttons: play, pause, stop, loop, speed, record", async () => {
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(tl().playing).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(tl().playing).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Repeat in loop" }));
    expect(tl().loop).toBe(true);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Speed" }), "0.5");
    expect(tl().speed).toBe(0.5);
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(tl().record).toBe(true);
    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "true");
    // armed: the panel's border turns red, it is the indicator that is visible even at a glance
    expect(screen.getByRole("region", { name: "Timeline" }).className).toContain("border-danger");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(tl().playhead).toBe(0);
  });

  it("the ruler scrubs the playhead (snapped to 10 ms) and shows the current time", () => {
    render(<TimelinePanel />);
    const ruler = screen.getByRole("slider", { name: "Playhead" });
    fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX: 16 + 333 * PPM });
    expect(tl().playhead).toBe(330);
    expect(tl().posed).toBe(true);
    expect(screen.getByLabelText("Current time")).toHaveTextContent("0:00.330");
    fireEvent.keyDown(ruler, { key: "ArrowRight" });
    expect(tl().playhead).toBe(340);
  });

  it("Record is disabled without an open clip", () => {
    tl().openClip(null);
    render(<TimelinePanel />);
    expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
  });
});

describe("+ Property and presets", () => {
  it("+ Property on the selected layer adds the track to the open clip", async () => {
    tl().openClip("k");
    useScene.getState().setSelection(["btn"]);
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    // opacity and X are already there: disabled; Scale is free
    expect(await screen.findByRole("menuitem", { name: /Opacity/ })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("menuitem", { name: /Scale/ }));
    expect(sc().clips.k.tracks.map((t) => t.prop)).toEqual(["opacity", "x", "scale"]);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("without a selection the menu is off", () => {
    tl().openClip("k");
    render(<TimelinePanel />);
    expect(screen.getByRole("button", { name: "Add property" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Animate with a preset" })).toBeDisabled();
  });

  it("a preset creates a new clip with ONE gesture and opens it", async () => {
    useScene.getState().setSelection(["btn"]);
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Animate with a preset" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Fade in/ }));
    expect(Object.keys(sc().clips)).toHaveLength(2);
    const made = Object.values(sc().clips).find((c) => c.id !== "k")!;
    expect(made.name).toMatch(/Fade in/);
    expect(tl().clipId).toBe(made.id);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });
});

describe("resize and collapse", () => {
  it("the height changes with the arrows on the edge and is saved", () => {
    render(<TimelinePanel />);
    const h0 = tl().height;
    fireEvent.keyDown(screen.getByRole("separator", { name: "Timeline height" }), { key: "ArrowUp" });
    expect(tl().height).toBe(h0 + 24);
  });

  it("collapsing hides the body and leaves the header", async () => {
    render(<TimelinePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Collapse the timeline" }));
    expect(screen.queryByRole("toolbar", { name: "Transport" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand the timeline" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close the timeline" }));
    expect(tl().open).toBe(false);
  });
});
