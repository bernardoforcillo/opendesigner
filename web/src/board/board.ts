import { Code, ConnectError } from "@connectrpc/connect";
import type { RenderBoardResponse } from "../gen/opendesigner/v1/opendesigner_pb";
import { docClient } from "../rpc/client";

// WHITEBOARD OBJECTS IN THE EDITOR. The drawing is the server's (internal/board), the same
// function the create_board_object MCP tool uses; the nodes it returns go in through
// diagram/insert.ts::insertDiagram -- one gesture, one undo step, the new group selected.

export type BoardKind = "sticky" | "table" | "kanban" | "mindmap" | "brainstorm" | "retrospective" | "user-flow" | "customer-journey";

export interface BoardRequest {
  kind: BoardKind;
  items?: string[];
  rows?: number;
  columns?: number;
  color?: string;
}

/** What the dialog offers, in order. */
export const BOARD_OBJECTS: readonly { kind: BoardKind; label: string; hint: string; group: "Objects" | "Templates" }[] = [
  { kind: "sticky", label: "Sticky note", hint: "A note to write on", group: "Objects" },
  { kind: "table", label: "Table", hint: "4 rows, 3 columns", group: "Objects" },
  { kind: "kanban", label: "Kanban board", hint: "To do, Doing, Done", group: "Objects" },
  { kind: "mindmap", label: "Mind map", hint: "A center and its branches", group: "Objects" },
  { kind: "brainstorm", label: "Brainstorm", hint: "Ideas and wild ideas", group: "Templates" },
  { kind: "retrospective", label: "Retrospective", hint: "Went well, to improve, actions", group: "Templates" },
  { kind: "user-flow", label: "User flow", hint: "Five steps with arrows", group: "Templates" },
  { kind: "customer-journey", label: "Customer journey", hint: "Stages by actions, thoughts, pain points", group: "Templates" },
];

export const STICKY_COLORS = ["yellow", "pink", "green", "blue", "orange", "purple"] as const;

/** A message to show for a request the server refused or could not answer. */
export class BoardError extends Error {}

export interface BoardClient {
  renderBoard(req: BoardRequest): Promise<RenderBoardResponse>;
}

export async function renderBoard(req: BoardRequest, client: BoardClient = docClient as unknown as BoardClient): Promise<RenderBoardResponse> {
  try {
    return await client.renderBoard({ kind: req.kind, items: req.items ?? [], rows: req.rows ?? 0, columns: req.columns ?? 0, color: req.color ?? "" });
  } catch (err) {
    const ce = ConnectError.from(err);
    throw new BoardError(ce.code === Code.InvalidArgument ? ce.rawMessage : "the server is not responding: try again");
  }
}
