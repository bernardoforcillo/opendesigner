import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";

const versions = [{ id: "v2", name: "Second", createdAt: 1700000100n, seq: 5n }, { id: "v1", name: "First", createdAt: 1700000000n, seq: 2n }];
const client = vi.hoisted(() => ({
  listVersions: vi.fn(),
  createVersion: vi.fn(),
  deleteVersion: vi.fn(),
  branchDocument: vi.fn(),
  getBranchOrigin: vi.fn(),
  reviewMerge: vi.fn(),
  mergeBranch: vi.fn(),
}));
vi.mock("../rpc/client", () => ({ docClient: client }));
const navigate = vi.fn();
vi.mock("../home/nav", () => ({ useAppNavigate: () => navigate }));

import { VersionsDialog } from "./VersionsDialog";

beforeEach(() => {
  client.listVersions.mockResolvedValue({ versions });
  client.createVersion.mockResolvedValue({ id: "v3", name: "Third" });
  client.deleteVersion.mockResolvedValue({});
  client.branchDocument.mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", name: "copy" });
  client.getBranchOrigin.mockResolvedValue({ isBranch: false });
  useScene.getState().setScene(emptyScene("doc-1", "My doc"));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("VersionsDialog", () => {
  it("lists the saved versions, newest first", async () => {
    render(<VersionsDialog isOpen onOpenChange={() => {}} />);
    const list = await screen.findByRole("list", { name: "Saved versions" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Second"), expect.stringContaining("First"),
    ]);
    expect(client.listVersions).toHaveBeenCalledWith(expect.objectContaining({ docId: "doc-1" }));
  });

  it("saves the current state under a name and refreshes the list", async () => {
    render(<VersionsDialog isOpen onOpenChange={() => {}} />);
    await screen.findByRole("list", { name: "Saved versions" });
    const save = screen.getByRole("button", { name: "Save version" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Version name"), { target: { value: " Third " } });
    fireEvent.click(save);
    await waitFor(() => expect(client.createVersion).toHaveBeenCalledWith(expect.objectContaining({ docId: "doc-1", name: "Third" })));
    await waitFor(() => expect(client.listVersions).toHaveBeenCalledTimes(2));
  });

  it("opens a version as a copy: branches it and goes to the new document", async () => {
    const onOpenChange = vi.fn();
    render(<VersionsDialog isOpen onOpenChange={onOpenChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open First as a copy" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/doc/11111111-1111-1111-1111-111111111111"));
    expect(client.branchDocument).toHaveBeenCalledWith(expect.objectContaining({ docId: "doc-1", versionId: "v1", name: "My doc — First" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("branches the current state, deletes a version, and shows a failure", async () => {
    render(<VersionsDialog isOpen onOpenChange={() => {}} />);
    await screen.findByRole("list", { name: "Saved versions" });
    fireEvent.click(screen.getByRole("button", { name: "Delete version Second" }));
    await waitFor(() => expect(client.deleteVersion).toHaveBeenCalledWith(expect.objectContaining({ versionId: "v2" })));
    client.branchDocument.mockRejectedValueOnce(new Error("document not found"));
    fireEvent.click(screen.getByRole("button", { name: "Branch the current state" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("document not found");
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("VersionsDialog — merging a branch back", () => {
  const origin = { isBranch: true, sourceDocId: "22222222-2222-2222-2222-222222222222", sourceName: "Main", sourceExists: true };

  it("is not offered for a document that is not a branch", async () => {
    render(<VersionsDialog isOpen onOpenChange={() => {}} />);
    await screen.findByRole("list", { name: "Saved versions" });
    expect(screen.queryByRole("region", { name: "Merge back" })).toBeNull();
  });

  it("reviews the changes, flags conflicts, and merges into the original", async () => {
    client.getBranchOrigin.mockResolvedValue(origin);
    client.reviewMerge.mockResolvedValue({
      sourceDocId: origin.sourceDocId, sourceName: "Main", warnings: ["\"x\": its shape changed on the branch and is not merged"],
      changes: [
        { entity: "node", id: "a", name: "Card", kind: "changed", paths: ["x"], conflict: false, conflictPaths: [] },
        { entity: "node", id: "b", name: "Button", kind: "changed", paths: ["fills"], conflict: true, conflictPaths: ["fills"] },
      ],
    });
    client.mergeBranch.mockResolvedValue({ applied: 1, skippedConflicts: 1 });
    render(<VersionsDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
    const list = await screen.findByRole("list", { name: "Changes to merge" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("conflict")).toBeInTheDocument();
    expect(screen.getByText(/is not merged/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Merge into Main" }));
    await waitFor(() => expect(client.mergeBranch).toHaveBeenCalledWith(expect.objectContaining({ docId: "doc-1", preferBranch: false })));
    expect(await screen.findByRole("status")).toHaveTextContent("1 change merged into Main; 1 conflict left as the original has them.");
  });

  it("can prefer the branch on conflicts", async () => {
    client.getBranchOrigin.mockResolvedValue(origin);
    client.reviewMerge.mockResolvedValue({
      sourceDocId: origin.sourceDocId, sourceName: "Main", warnings: [],
      changes: [{ entity: "node", id: "b", name: "Button", kind: "changed", paths: ["x"], conflict: true, conflictPaths: ["x"] }],
    });
    client.mergeBranch.mockResolvedValue({ applied: 1, skippedConflicts: 0 });
    render(<VersionsDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
    fireEvent.click(await screen.findByLabelText(/use the branch's version/));
    fireEvent.click(screen.getByRole("button", { name: "Merge into Main" }));
    await waitFor(() => expect(client.mergeBranch).toHaveBeenCalledWith(expect.objectContaining({ preferBranch: true })));
  });
});
