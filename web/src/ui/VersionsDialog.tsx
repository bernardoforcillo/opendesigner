import { useCallback, useEffect, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { create } from "@bufbuild/protobuf";
import {
  BranchRequestSchema, CreateVersionRequestSchema, DeleteVersionRequestSchema, GetBranchOriginRequestSchema, ListVersionsRequestSchema,
  MergeBranchRequestSchema, ReviewMergeRequestSchema,
} from "../gen/opendesigner/v1/opendesigner_pb";
import type { GetBranchOriginResponse, ReviewMergeResponse, VersionInfo } from "../gen/opendesigner/v1/opendesigner_pb";
import { docClient } from "../rpc/client";
import { useScene } from "../store/store";
import { useAppNavigate } from "../home/nav";
import { pathForDoc } from "../home/route";
import { Button, cls, EmptyState } from "./ds";

// THE VERSIONS DIALOG (document menu → Versions…): named, frozen copies of the document.
// A version is never edited; "Open as copy" branches it into a NEW document (with the
// assets it uses) to look at or build on, leaving this one untouched.

function when(sec: bigint): string {
  return new Date(Number(sec) * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function VersionsDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const docId = useScene((s) => s.scene?.id ?? "");
  const docName = useScene((s) => s.scene?.name ?? "");
  const navigate = useAppNavigate();
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Merging back: only for a document that is a branch.
  const [origin, setOrigin] = useState<GetBranchOriginResponse | null>(null);
  const [review, setReview] = useState<ReviewMergeResponse | null>(null);
  const [preferBranch, setPreferBranch] = useState(false);
  const [merged, setMerged] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (docId === "") return;
    try {
      const r = await docClient.listVersions(create(ListVersionsRequestSchema, { docId }));
      setVersions(r.versions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not list the versions");
    }
  }, [docId]);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setReview(null);
    setMerged(null);
    void refresh();
    if (docId !== "") {
      docClient.getBranchOrigin(create(GetBranchOriginRequestSchema, { docId })).then(setOrigin, () => setOrigin(null));
    }
  }, [isOpen, refresh, docId]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "the request failed"); } finally { setBusy(false); }
  };

  const save = () => guard(async () => {
    await docClient.createVersion(create(CreateVersionRequestSchema, { docId, name: name.trim() }));
    setName("");
    await refresh();
  });

  const branch = (v: VersionInfo | null) => guard(async () => {
    const label = v ? `${docName} — ${v.name}` : `${docName} (copy)`;
    const info = await docClient.branchDocument(create(BranchRequestSchema, { docId, versionId: v?.id ?? "", name: label }));
    onOpenChange(false);
    navigate(pathForDoc(info.id));
  });

  const reviewMerge = () => guard(async () => {
    setMerged(null);
    setReview(await docClient.reviewMerge(create(ReviewMergeRequestSchema, { docId })));
  });

  const mergeBack = () => guard(async () => {
    const r = await docClient.mergeBranch(create(MergeBranchRequestSchema, { docId, preferBranch }));
    setReview(null);
    setMerged(
      `${r.applied} change${r.applied === 1 ? "" : "s"} merged into ${origin?.sourceName ?? "the original"}` +
      (r.skippedConflicts > 0 ? `; ${r.skippedConflicts} conflict${r.skippedConflicts === 1 ? "" : "s"} left as the original has them` : "") + ".",
    );
  });

  const remove = (v: VersionInfo) => guard(async () => {
    await docClient.deleteVersion(create(DeleteVersionRequestSchema, { docId, versionId: v.id }));
    await refresh();
  });

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[520px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Versions" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Versions</h2>
          <p className="text-fg-subtle">
            Save a named copy of the document as it is now. A version never changes; open it as a copy to look at it or
            to branch from it without touching this document.
          </p>

          <div className="flex gap-2">
            <input
              aria-label="Version name" className={`${cls.input} flex-1`} value={name} maxLength={120}
              placeholder="e.g. Before the redesign" onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim() !== "" && !busy) void save(); }}
            />
            <Button variant="primary" isDisabled={busy || name.trim() === ""} onPress={() => void save()}>Save version</Button>
          </div>

          {versions !== null && versions.length === 0 ? (
            <EmptyState icon="page" title="No versions yet" hint="Name the current state to keep it." />
          ) : (
            <ul aria-label="Saved versions" className="flex flex-col gap-1">
              {(versions ?? []).map((v) => (
                <li key={v.id} className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{v.name}</span>
                    <span className="block text-[11px] text-fg-subtle">{when(v.createdAt)}</span>
                  </span>
                  <Button isDisabled={busy} onPress={() => void branch(v)} aria-label={`Open ${v.name} as a copy`}>Open as copy</Button>
                  <button
                    type="button" aria-label={`Delete version ${v.name}`} disabled={busy}
                    className="text-fg-subtle hover:text-danger" onClick={() => void remove(v)}
                  >×</button>
                </li>
              ))}
            </ul>
          )}

          {origin?.isBranch && (
            <section aria-label="Merge back" className="flex flex-col gap-2 border-t border-line pt-3">
              <h3 className="font-semibold">Merge back</h3>
              <p className="text-fg-subtle">
                This document is a branch of <strong>{origin.sourceName}</strong>
                {origin.sourceExists ? "." : ", which no longer exists."} Review what it changed, then merge it back: the original gets the
                changes as ordinary edits (one undo step each), and what you both changed the same way is left as the original has it unless you choose otherwise.
              </p>
              {origin.sourceExists && (
                <div className="flex items-center gap-2">
                  <Button isDisabled={busy} onPress={() => void reviewMerge()}>Review changes</Button>
                  {origin.sourceExists && <Button isDisabled={busy} onPress={() => navigate(pathForDoc(origin.sourceDocId))}>Open the original</Button>}
                </div>
              )}
              {merged && <p role="status" className="text-ok">{merged}</p>}
              {review && (
                <>
                  {review.changes.length === 0 ? (
                    <p>Nothing to merge: the branch has no changes the original does not have.</p>
                  ) : (
                    <ul aria-label="Changes to merge" className="flex max-h-48 flex-col gap-0.5 overflow-auto">
                      {review.changes.map((c, i) => (
                        <li key={i} className={`flex items-baseline gap-2 rounded px-2 py-1 ${c.conflict ? "bg-warn-soft text-warn" : "bg-surface-2"}`}>
                          <span className="w-16 shrink-0 text-[11px] uppercase tracking-wide">{c.kind}</span>
                          <span className="min-w-0 flex-1 truncate">{c.name || c.id} <span className="text-fg-subtle">({c.entity})</span></span>
                          {c.paths.length > 0 && <span className="shrink-0 text-[11px] text-fg-subtle">{c.paths.join(", ")}</span>}
                          {c.conflict && <span className="shrink-0 text-[11px] font-semibold">conflict</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {review.warnings.map((w, i) => <p key={i} className="text-[12px] text-fg-subtle">Not merged: {w}</p>)}
                  {review.changes.some((c) => c.conflict) && (
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={preferBranch} onChange={(e) => setPreferBranch(e.target.checked)} />
                      On a conflict, use the branch's version
                    </label>
                  )}
                  {review.changes.length > 0 && (
                    <Button variant="primary" isDisabled={busy} onPress={() => void mergeBack()}>
                      Merge into {review.sourceName}
                    </Button>
                  )}
                </>
              )}
            </section>
          )}

          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-between border-t border-line pt-3">
            <Button isDisabled={busy} onPress={() => void branch(null)}>Branch the current state</Button>
            <Button onPress={() => onOpenChange(false)}>Done</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
