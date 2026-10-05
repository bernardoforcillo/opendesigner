import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { NodeSchema, RenderDiagramResponseSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";

const renderDiagramRpc = vi.fn();
vi.mock("../rpc/client", () => ({ docClient: { renderDiagram: (...a: unknown[]) => renderDiagramRpc(...a) } }));

import { DiagramDialog } from "./DiagramDialog";

const reply = (source: string) => {
  const root = create(NodeSchema, {
    id: crypto.randomUUID(), name: "Diagramma", visible: true, opacity: 1, width: 100, height: 60,
    shape: { case: "group", value: {} }, meta: { "diagram.source": source, "diagram.kind": "sequence" },
  });
  return create(RenderDiagramResponseSchema, { nodes: [root], kind: "sequence", width: 100, height: 60 });
};

afterEach(cleanup);

beforeEach(() => {
  renderDiagramRpc.mockReset();
  useScene.setState({ gesture: null, lastError: null, notice: null, selection: [], camera: { x: 0, y: 0, zoom: 1 } });
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
});

describe("DiagramDialog", () => {
  it("un esempio riempie il testo; Crea lo manda al server e inserisce il diagramma", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDiagramRpc.mockImplementation(async ({ source }: { source: string }) => reply(source));
    render(<DiagramDialog isOpen onOpenChange={onOpenChange} />);
    expect(screen.getByRole("button", { name: "Crea" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Sequenza UML" }));
    expect((screen.getByLabelText("Codice Mermaid") as HTMLTextAreaElement).value).toContain("sequenceDiagram");
    await user.click(screen.getByRole("button", { name: "Crea" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(renderDiagramRpc.mock.calls[0][0].source).toContain("sequenceDiagram");
    expect(useScene.getState().scene!.nodes.size).toBe(1);
  });

  it("mostra il messaggio del server per un testo illeggibile e non inserisce niente", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDiagramRpc.mockRejectedValue(new ConnectError('il diagramma "gantt" non è supportato', Code.InvalidArgument));
    render(<DiagramDialog isOpen onOpenChange={onOpenChange} />);
    await user.type(screen.getByLabelText("Codice Mermaid"), "gantt");
    await user.click(screen.getByRole("button", { name: "Crea" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("non è supportato");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(useScene.getState().scene!.nodes.size).toBe(0);
  });

  it("con un diagramma selezionato si apre sul suo testo e Aggiorna lo ridisegna", async () => {
    const user = userEvent.setup();
    renderDiagramRpc.mockImplementation(async ({ source }: { source: string }) => reply(source));
    const { rerender } = render(<DiagramDialog isOpen={false} onOpenChange={() => {}} />);
    // primo diagramma
    rerender(<DiagramDialog isOpen onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Codice Mermaid"), "graph TD");
    await user.click(screen.getByRole("button", { name: "Crea" }));
    await waitFor(() => expect(useScene.getState().scene!.nodes.size).toBe(1));
    const id = useScene.getState().selection[0];
    // riapertura
    rerender(<DiagramDialog isOpen={false} onOpenChange={() => {}} />);
    rerender(<DiagramDialog isOpen onOpenChange={() => {}} />);
    expect((screen.getByLabelText("Codice Mermaid") as HTMLTextAreaElement).value).toBe("graph TD");
    expect(screen.getByRole("heading", { name: "Modifica diagramma" })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Codice Mermaid"));
    await user.type(screen.getByLabelText("Codice Mermaid"), "graph LR");
    await user.click(screen.getByRole("button", { name: "Aggiorna" }));
    await waitFor(() => expect(useScene.getState().scene!.nodes.has(id)).toBe(false));
    expect(useScene.getState().scene!.nodes.size).toBe(1);
  });
});
