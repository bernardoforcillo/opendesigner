import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Code, ConnectError } from "@connectrpc/connect";

const client = vi.hoisted(() => ({ renderBoard: vi.fn() }));
vi.mock("../rpc/client", () => ({ docClient: client }));
const insert = vi.hoisted(() => ({ insertDiagram: vi.fn() }));
vi.mock("../diagram/insert", () => insert);
vi.mock("../tools/svgImport", () => ({ viewportCenter: () => ({ x: 100, y: 200 }) }));

import { BoardDialog } from "./BoardDialog";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("BoardDialog", () => {
  it("offers the objects and the templates", () => {
    render(<BoardDialog isOpen onOpenChange={() => {}} />);
    for (const n of ["Sticky note", "Table", "Kanban board", "Mind map", "Brainstorm", "Retrospective", "User flow", "Customer journey"]) {
      expect(screen.getByText(n)).toBeInTheDocument();
    }
  });

  it("draws the object (with the chosen color and table size) and inserts it at the center of the view", async () => {
    const res = { nodes: [], width: 10, height: 10 };
    client.renderBoard.mockResolvedValue(res);
    insert.insertDiagram.mockReturnValue("root");
    const onOpenChange = vi.fn();
    render(<BoardDialog isOpen onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Sticky color pink" }));
    fireEvent.click(screen.getByText("Sticky note"));
    await waitFor(() => expect(insert.insertDiagram).toHaveBeenCalledWith(res, { x: 100, y: 200 }));
    expect(client.renderBoard).toHaveBeenCalledWith(expect.objectContaining({ kind: "sticky", color: "pink", rows: 0, columns: 0 }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.change(screen.getByLabelText("Table rows"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Table columns"), { target: { value: "2" } });
    fireEvent.click(screen.getByText("Table"));
    await waitFor(() => expect(client.renderBoard).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "table", rows: 5, columns: 2 })));
  });

  it("shows the server's reason, or a generic one, and keeps the dialog open", async () => {
    client.renderBoard.mockRejectedValueOnce(new ConnectError("too many items", Code.InvalidArgument));
    const onOpenChange = vi.fn();
    render(<BoardDialog isOpen onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText("Mind map"));
    expect(await screen.findByRole("alert")).toHaveTextContent("too many items");
    client.renderBoard.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByText("Kanban board"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not responding"));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
