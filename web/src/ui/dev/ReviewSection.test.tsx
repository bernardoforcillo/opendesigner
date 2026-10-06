import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useScene } from "../../store/store";
import { nodesOf } from "../../store/nodeMap";
import { emptyScene } from "../../store/types";

const client = vi.hoisted(() => ({ reviewDesign: vi.fn() }));
vi.mock("../../rpc/client", () => ({ docClient: client }));

import { ReviewSection } from "./ReviewSection";

beforeEach(() => {
  useScene.setState({ selection: [] });
  useScene.getState().setScene({
    ...emptyScene("doc-1", "D"),
    nodes: nodesOf({
      t: {
        id: "t", parentId: "page1", orderKey: "a0", name: "Greeting", visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0,
        fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
      },
    }),
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ReviewSection", () => {
  it("runs the review, lists the issues and selects the node of the one clicked", async () => {
    client.reviewDesign.mockResolvedValue({
      issues: [{ rule: "contrast", severity: "error", nodeId: "t", nodeName: "Greeting", message: "text contrast is 1.7:1" }],
    });
    render(<ReviewSection />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const item = await screen.findByText("text contrast is 1.7:1");
    expect(client.reviewDesign).toHaveBeenCalledWith(expect.objectContaining({ docId: "doc-1" }));
    fireEvent.click(item);
    expect(useScene.getState().selection).toEqual(["t"]);
    expect(screen.getByRole("button", { name: "Review again" })).toBeInTheDocument();
  });

  it("says so when the design is clean, and shows a failure", async () => {
    client.reviewDesign.mockResolvedValueOnce({ issues: [] });
    render(<ReviewSection />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("Clean")).toBeInTheDocument();
    client.reviewDesign.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Review again" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("offline"));
  });
});
