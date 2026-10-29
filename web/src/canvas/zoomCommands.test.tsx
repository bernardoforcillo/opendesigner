import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { cameraForBounds, fitView, runZoom, selectionView, useZoomShortcuts, zoomCommandFor } from "@/canvas/zoomCommands";
import { ZoomMenu } from "@/ui/shell/ZoomMenu";
import { useScene } from "@/store/store";
import { useSpreadView } from "@/store/spread";
import { NodeMap } from "@/store/nodeMap";
import { emptyScene, type NodeLite, type SceneState } from "@/store/types";

const rect = (id: string, x: number, y: number, w = 100, h = 50): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1, x, y, width: w, height: h, rotation: 0,
  fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});
const scene = (extra: Partial<SceneState> = {}): SceneState => ({ ...emptyScene("d", "D"), nodes: NodeMap.from({ a: rect("a", 0, 0), b: rect("b", 1000, 500) }), ...extra });

function Harness() { useZoomShortcuts(); return <canvas id="scene" />; }

beforeEach(() => {
  useScene.getState().setScene(scene());
  useScene.setState({ currentPageId: "page1", selection: [], camera: { x: 0, y: 0, zoom: 1 } });
  useSpreadView.getState().setOn(true);
});
afterEach(cleanup);

describe("camera maths", () => {
  it("frames bounds centred with a margin, never past the max zoom", () => {
    const cam = cameraForBounds({ x: 100, y: 100, width: 400, height: 200 }, 1000, 600, 100)!;
    expect(cam.zoom).toBeCloseTo(2); // (1000-200)/400
    // the middle of the bounds lands in the middle of the canvas
    expect(300 * cam.zoom + cam.x).toBeCloseTo(500);
    expect(200 * cam.zoom + cam.y).toBeCloseTo(300);
    expect(cameraForBounds({ x: 0, y: 0, width: 1, height: 1 }, 1000, 600, 0, 3)!.zoom).toBe(3);
    expect(cameraForBounds({ x: 0, y: 0, width: 10, height: 10 }, 0, 0)).toBeNull();
  });

  it("fits the content of an unsized page, and the sheet of a sized one", () => {
    const content = fitView(scene(), "page1", 1200, 800)!;
    expect(content.zoom).toBeLessThan(1);
    const sheet = fitView(scene({ pages: [{ id: "page1", name: "P", width: 400, height: 600 }] }), "page1", 1200, 800)!;
    expect(sheet.zoom).toBeCloseTo((800 - 64) / 600);
  });

  it("frames the selection, or nothing when it is empty", () => {
    expect(selectionView(scene(), [], 1000, 600)).toBeNull();
    const cam = selectionView(scene(), ["b"], 1000, 600)!;
    expect(1050 * cam.zoom + cam.x).toBeCloseTo(500);
  });
});

describe("zoomCommandFor", () => {
  const k = (o: Partial<KeyboardEvent>) => zoomCommandFor({ key: "", code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
  it("maps Figma's Shift+0/1/2 and the page-layout Ctrl/Cmd keys", () => {
    expect(k({ shiftKey: true, code: "Digit0", key: ")" })).toBe("100");
    expect(k({ shiftKey: true, code: "Digit1", key: "!" })).toBe("fit");
    expect(k({ shiftKey: true, code: "Digit2", key: "@" })).toBe("selection");
    expect(k({ ctrlKey: true, key: "0" })).toBe("fit");
    expect(k({ metaKey: true, key: "1" })).toBe("100");
    expect(k({ ctrlKey: true, key: "=" })).toBe("in");
    expect(k({ ctrlKey: true, key: "-" })).toBe("out");
  });
  it("ignores plain keys and Alt combinations", () => {
    expect(k({ key: "1", code: "Digit1" })).toBeNull();
    expect(k({ ctrlKey: true, altKey: true, key: "0" })).toBeNull();
  });
});

describe("runZoom and the shortcuts", () => {
  it("steps and resets the zoom around the canvas", () => {
    render(<Harness />);
    runZoom("in");
    expect(useScene.getState().camera.zoom).toBeCloseTo(1.25);
    runZoom("100");
    expect(useScene.getState().camera.zoom).toBeCloseTo(1);
    runZoom("out");
    expect(useScene.getState().camera.zoom).toBeCloseTo(0.8);
  });

  it("listens on the window and prevents the browser's own zoom", () => {
    render(<Harness />);
    const e = new KeyboardEvent("keydown", { key: "=", ctrlKey: true, cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(useScene.getState().camera.zoom).toBeCloseTo(1.25);
  });

  it("does not act while typing in a field", () => {
    render(<><Harness /><input aria-label="x" /></>);
    fireEvent.keyDown(screen.getByLabelText("x"), { key: "=", ctrlKey: true });
    expect(useScene.getState().camera.zoom).toBe(1);
  });
});

describe("ZoomMenu", () => {
  it("shows the zoom and opens the commands", () => {
    render(<><canvas id="scene" /><ZoomMenu /></>);
    const btn = screen.getByRole("button", { name: "Zoom" });
    expect(btn).toHaveTextContent("100%");
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("menuitem", { name: /Zoom in/ }));
    expect(useScene.getState().camera.zoom).toBeCloseTo(1.25);
  });
});
