import { useCallback, useEffect, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import type { AccessLink, GetAccessResponse } from "../gen/opendesigner/v1/opendesigner_pb";
import { docClient } from "../rpc/client";
import { setActiveDoc, shareUrl, storeToken, useAccess, type Role } from "../rpc/access";
import { useScene } from "../store/store";
import { Button, cls } from "./ds";

// SHARE (document menu → Share…). A document is open to anyone on the network until it is protected;
// then it is reached only through links, each with a role (view, comment, edit, owner). A link is
// shown ONCE, when it is made: the server keeps only its hash. No accounts: the link is the permission.

const ROLES = [
  ["view", "can view"],
  ["comment", "can comment"],
  ["edit", "can edit"],
  ["owner", "can manage links"],
] as const;

function when(sec: bigint): string {
  return new Date(Number(sec) * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ShareDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const docId = useScene((s) => s.scene?.id ?? "");
  const [access, setAccess] = useState<GetAccessResponse | null>(null);
  const [role, setRole] = useState<(typeof ROLES)[number][0]>("view");
  const [label, setLabel] = useState("");
  const [made, setMade] = useState<{ link: AccessLink; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (docId === "") return;
    try {
      const r = await docClient.getAccess({ docId });
      setAccess(r);
      useAccess.getState().setRole(r.role as Role);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not read the access settings");
    }
  }, [docId]);

  useEffect(() => {
    if (isOpen) { setError(null); setMade(null); void refresh(); }
  }, [isOpen, refresh]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message.replace(/^\[\w+\]\s*/, "") : "the request failed"); } finally { setBusy(false); }
  };

  const protect = () => guard(async () => {
    const r = await docClient.enableAccess({ docId });
    // This browser is now the owner: keep the owner link so it keeps working.
    storeToken(docId, r.ownerToken);
    setActiveDoc(docId);
    await refresh();
  });

  const unprotect = () => guard(async () => {
    await docClient.disableAccess({ docId });
    storeToken(docId, "");
    setActiveDoc(docId);
    setMade(null);
    await refresh();
  });

  const create = () => guard(async () => {
    const r = await docClient.createShareLink({ docId, role, label: label.trim() });
    if (r.link) setMade({ link: r.link, url: shareUrl(docId, r.token) });
    setLabel("");
    await refresh();
  });

  const revoke = (l: AccessLink) => guard(async () => {
    await docClient.revokeShareLink({ docId, linkId: l.id });
    await refresh();
  });

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { window.prompt("Copy this link:", text); }
  };

  const owner = access?.enabled === true && access.role === "owner";
  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[540px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Share" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Share</h2>
          {access === null ? (
            <p className="text-fg-subtle">Loading…</p>
          ) : !access.enabled ? (
            <>
              <p className="text-fg-subtle">
                This document is <strong>open</strong>: anyone who can reach this server can read and edit it (fine on a trusted network). Protect it to
                reach it only through share links, each one view-only, comment-only, edit or owner.
              </p>
              <div><Button variant="primary" isDisabled={busy} onPress={() => void protect()}>Protect with share links</Button></div>
            </>
          ) : !owner ? (
            <p>You have <strong>{access.role}</strong> access to this protected document through your link.</p>
          ) : (
            <>
              <p className="text-fg-subtle">
                This document is <strong>protected</strong>. Only these links reach it. A link is shown once, when it is made; revoke it to
                cut it off at once. This browser holds the owner link.
              </p>
              <ul aria-label="Share links" className="flex flex-col gap-1">
                {access.links.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{l.label || "Untitled link"}</span>
                      <span className="block text-[11px] text-fg-subtle">{ROLES.find(([r]) => r === l.role)?.[1] ?? l.role} · made {when(l.createdAt)}</span>
                    </span>
                    <button type="button" aria-label={`Revoke ${l.label || "link"}`} disabled={busy} className="text-fg-subtle hover:text-danger" onClick={() => void revoke(l)}>Revoke</button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <select aria-label="Link role" className="h-8 rounded-md border border-line bg-surface px-2" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                  {ROLES.map(([r, text]) => <option key={r} value={r}>Anyone with the link {text}</option>)}
                </select>
                <input aria-label="Link label" className={`${cls.input} min-w-0 flex-1`} placeholder="Label (e.g. Client review)" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
                <Button variant="primary" isDisabled={busy} onPress={() => void create()}>Create link</Button>
              </div>
              {made && (
                <div role="status" className="flex flex-col gap-1 rounded-md bg-ok-soft p-2">
                  <span className="text-[12px] text-ok">Copy it now: it is not shown again.</span>
                  <div className="flex gap-2">
                    <input aria-label="New link" readOnly className={`${cls.input} min-w-0 flex-1 font-mono text-[12px]`} value={made.url} onFocus={(e) => e.currentTarget.select()} />
                    <Button onPress={() => void copy(made.url)}>Copy</Button>
                  </div>
                </div>
              )}
              <div><button type="button" disabled={busy} className="text-fg-subtle hover:text-danger" onClick={() => void unprotect()}>Remove protection (open to everyone again)</button></div>
            </>
          )}
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-end border-t border-line pt-3"><Button onPress={() => onOpenChange(false)}>Done</Button></div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
