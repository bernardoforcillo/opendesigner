// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";
import { ConnectorControls } from "./ConnectorControls";

afterEach(cleanup);

const sync = {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  },
};

const rect = (id: string, x: number): NodeLite => ({
  id, parentId: "page1", orderKey: `a${id}`, name: id, visible: true, opacity: 1, x, y: 0, width: 50, height: 30, rotation: 0,
  fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});

describe("ConnectorControls", () => {
  it("connects two selected nodes, then edits the connector", () => {
    useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, sync: null });
    useScene.getState().setScene({ ...emptyScene("d", "t"), nodes: nodesOf({ a: rect("a", 0), b: rect("b", 200) }) });
    useScene.setState({ sync: sync as never, selection: ["a", "b"] });
    render(<ConnectorControls />);
    fireEvent.click(screen.getByRole("button", { name: "Connect with arrow" }));
    const sel = useScene.getState().selection;
    expect(sel).toHaveLength(1);
    const made = useScene.getState().scene!.nodes.at(sel[0])!;
    expect(made.meta?.["connector.from"]).toBe("a");
    fireEvent.click(screen.getByRole("button", { name: "Elbow" }));
    expect(useScene.getState().scene!.nodes.at(sel[0])!.meta?.["connector.route"]).toBe("elbow");
  });
});
