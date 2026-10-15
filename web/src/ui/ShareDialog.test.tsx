// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";

const client = vi.hoisted(() => ({
  getAccess: vi.fn(), enableAccess: vi.fn(), disableAccess: vi.fn(), createShareLink: vi.fn(), revokeShareLink: vi.fn(),
}));
vi.mock("../rpc/client", () => ({ docClient: client }));

import { ShareDialog } from "./ShareDialog";
import { storedToken } from "../rpc/access";

const link = (id: string, role: string, label: string) => ({ id, role, label, createdAt: 1700000000n });

beforeEach(() => {
  localStorage.clear();
  useScene.getState().setScene(emptyScene("doc-1", "My doc"));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ShareDialog", () => {
  it("an open document: says so, and protects it, keeping the owner link in this browser", async () => {
    client.getAccess.mockResolvedValueOnce({ enabled: false, role: "open", links: [] });
    client.enableAccess.mockResolvedValue({ ownerToken: "owner-secret" });
    client.getAccess.mockResolvedValueOnce({ enabled: true, role: "owner", links: [link("l1", "owner", "Owner")] });
    render(<ShareDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Protect with share links" }));
    await waitFor(() => expect(storedToken("doc-1")).toBe("owner-secret"));
    const list = await screen.findByRole("list", { name: "Share links" });
    expect(within(list).getByText("Owner")).toBeInTheDocument();
  });

  it("an owner makes a link (shown once), and revokes one", async () => {
    client.getAccess.mockResolvedValue({ enabled: true, role: "owner", links: [link("l1", "owner", "Owner"), link("l2", "view", "Client")] });
    client.createShareLink.mockResolvedValue({ link: link("l3", "comment", "QA"), token: "tok-3" });
    client.revokeShareLink.mockResolvedValue({});
    render(<ShareDialog isOpen onOpenChange={() => {}} />);
    await screen.findByRole("list", { name: "Share links" });
    fireEvent.change(screen.getByLabelText("Link role"), { target: { value: "comment" } });
    fireEvent.change(screen.getByLabelText("Link label"), { target: { value: " QA " } });
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(client.createShareLink).toHaveBeenCalledWith({ docId: "doc-1", role: "comment", label: "QA" }));
    const url = (await screen.findByLabelText("New link")) as HTMLInputElement;
    expect(url.value).toMatch(/\/doc\/doc-1\?k=tok-3$/);
    fireEvent.click(screen.getByRole("button", { name: "Revoke Client" }));
    await waitFor(() => expect(client.revokeShareLink).toHaveBeenCalledWith({ docId: "doc-1", linkId: "l2" }));
  });

  it("someone with a lesser link only sees what they have; a refusal is shown", async () => {
    client.getAccess.mockResolvedValue({ enabled: true, role: "view", links: [] });
    render(<ShareDialog isOpen onOpenChange={() => {}} />);
    expect(await screen.findByText(/access to this protected document/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create link" })).toBeNull();
    cleanup();
    client.getAccess.mockResolvedValue({ enabled: false, role: "open", links: [] });
    client.enableAccess.mockRejectedValue(new Error("[permission_denied] only the machine running the server can protect a document"));
    render(<ShareDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Protect with share links" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("only the machine running the server");
  });
});
