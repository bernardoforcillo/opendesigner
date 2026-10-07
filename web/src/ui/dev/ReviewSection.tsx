import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ReviewDesignRequestSchema } from "../../gen/opendesigner/v1/opendesigner_pb";
import type { ReviewIssue } from "../../gen/opendesigner/v1/opendesigner_pb";
import { docClient } from "../../rpc/client";
import { useScene } from "../../store/store";
import { Badge, Button, cls } from "../ds";

// DESIGN REVIEW (Develop → left panel): runs the server's mechanical review -- text contrast,
// tap targets, design tokens -- and lists what it found; a click selects the node. It reads
// the document as the server has it, so run it after the last edit has been confirmed.

export function ReviewSection() {
  const docId = useScene((s) => s.scene?.id ?? "");
  const [issues, setIssues] = useState<ReviewIssue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await docClient.reviewDesign(create(ReviewDesignRequestSchema, { docId }));
      setIssues(r.issues);
    } catch (e) {
      setError(e instanceof Error ? e.message : "the review failed");
    } finally {
      setBusy(false);
    }
  };

  const pick = (id: string) => {
    const st = useScene.getState();
    if (st.scene?.nodes.has(id)) st.setSelection([id]);
  };

  return (
    <section className="border-t border-line pb-2" aria-label="Design review">
      <div className="flex items-center gap-2 px-3 pb-1 pt-3">
        <h3 className={cls.sectionTitle}>Design review</h3>
        <span className="ml-auto" />
        {issues !== null && (issues.length === 0 ? <Badge tone="ok">Clean</Badge> : <Badge tone="danger">{issues.length}</Badge>)}
        <Button isDisabled={busy || docId === ""} onPress={() => void run()}>{busy ? "Reviewing…" : issues === null ? "Review" : "Review again"}</Button>
      </div>
      {error && <p role="alert" className="px-3 text-[12px] text-danger">{error}</p>}
      {issues !== null && issues.length === 0 && (
        <p className="px-3 text-[12px] text-fg-subtle">Contrast, tap targets and tokens all check out.</p>
      )}
      <ul aria-label="Review issues">
        {(issues ?? []).map((i, k) => (
          <li key={`${i.nodeId}-${i.rule}-${k}`}>
            <button
              type="button"
              onClick={() => pick(i.nodeId)}
              className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]"
            >
              <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
                <span className={i.severity === "error" ? "font-semibold text-danger" : "font-semibold text-warn"}>{i.rule}</span>
                <span className="truncate">{i.nodeName || "(unnamed)"}</span>
              </span>
              <span className="text-[12px] text-fg-muted">{i.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
