import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StoryDialog } from "@/ui/StoryDialog";
import { nodesOf } from "@/store/nodeMap";
import { META_NEXT } from "@/store/threads";
import { useScene } from "@/store/store";
import { emptyScene, type NodeLite } from "@/store/types";

const STYLE = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 1.25, align: "left" as const };
const frame = (id: string, content: string, meta?: Record<string, string>): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 40, rotation: 0,
  fills: [], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text: { content, style: STYLE }, ...(meta ? { meta } : {}),
});

beforeEach(() => {
  useScene.getState().setScene({ ...emptyScene("d", "u"), nodes: nodesOf({ a: frame("a", "first story", { [META_NEXT]: "b" }), b: frame("b", "") }) });
  useScene.setState({ selection: ["b"], gesture: null, undoStack: [], redoStack: [] });
});

describe("StoryDialog", () => {
  it("shows the story of the chain and saves it into the first frame", () => {
    render(<StoryDialog id="b" isOpen onOpenChange={() => {}} />);
    const field = screen.getByRole("textbox", { name: "Story text" }) as HTMLTextAreaElement;
    expect(field.value).toBe("first story");
    expect(screen.getByText(/2 frames/)).toBeTruthy();
    fireEvent.change(field, { target: { value: "first story, edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(useScene.getState().scene!.nodes.at("a")!.text!.content).toBe("first story, edited");
  });
});
