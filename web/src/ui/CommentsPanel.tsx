import { useMemo, useState } from "react";
import { useScene } from "../store/store";
import { useCommentsUi } from "../store/commentsUi";
import { loadNickname } from "../store/presence";
import { threadsOf } from "../store/comments";
import { makeDeleteCommentOp, makeSetCommentOp, uuid } from "../tools/ops";
import { submit as submitOps } from "../flow/commands";
import { screenName } from "../flow/screens";
import type { CommentLite, SceneState } from "../store/types";
import { EmptyState, IconButton } from "./ds";

// THE COMMENTS PANEL: the threads of the current page (plus the orphaned ones, whose node
// is gone), a composer for the pin being placed, and reply / resolve / delete on each
// thread. Comments are document: every action is one op, sent at once (no undo entry --
// a comment is a conversation, not a design edit).

// One gesture per action, like every other edit: confirmation, rejection and reconnects
// are handled by the store. The inverse of a comment op is none, so nothing is added to undo.
const send = (op: ReturnType<typeof makeSetCommentOp>) => submitOps([op]);

const now = () => Math.floor(Date.now() / 1000);

function when(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Composer({
  placeholder, label, onSend, autoFocus,
}: { placeholder: string; label: string; onSend: (text: string) => void; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (t === "") return;
    onSend(t);
    setText("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        aria-label={label}
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
        }}
        className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg outline-none placeholder:text-fg-subtle focus-visible:shadow-[var(--ring)]"
      />
      <button
        type="button"
        disabled={text.trim() === ""}
        onClick={send}
        className="h-7 self-end rounded-md bg-accent px-3 text-[12px] font-medium text-accent-fg outline-none disabled:opacity-40 focus-visible:shadow-[var(--ring)]"
      >
        Send
      </button>
    </div>
  );
}

function Message({ c }: { c: CommentLite }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-semibold text-fg">{c.author || "Someone"}</span>
        <span className="text-[11px] text-fg-subtle">{when(c.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-[12px] text-fg-muted">{c.text}</p>
    </div>
  );
}

function targetName(scene: SceneState, root: CommentLite, orphan: boolean): string {
  if (orphan) return "deleted element";
  if (root.nodeId !== "") return screenName(scene, root.nodeId);
  return "page";
}

export function CommentsPanel() {
  const scene = useScene((s) => s.scene);
  const pageId = useScene((s) => s.currentPageId);
  const draft = useCommentsUi((c) => c.draft);
  const activeId = useCommentsUi((c) => c.activeId);
  const showResolved = useCommentsUi((c) => c.showResolved);
  const threads = useMemo(
    () => (scene ? threadsOf(scene, pageId ?? scene.pages[0]?.id ?? "") : []),
    [scene?.comments, scene?.nodes, scene?.pages, pageId],
  );
  if (!scene) return null;
  const visible = threads.filter((t) => showResolved || !t.root.resolved || t.root.id === activeId);
  const hiddenCount = threads.length - visible.length;
  const author = loadNickname();

  const create = (text: string) => {
    if (!draft) return;
    const id = uuid();
    send(makeSetCommentOp({
      id, parentId: "", nodeId: draft.nodeId, pageId: draft.pageId, x: draft.x, y: draft.y,
      author, text, createdAt: now(), resolved: false,
    }));
    useCommentsUi.getState().setDraft(null);
    useCommentsUi.getState().setActive(id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2 text-[11px] text-fg-subtle">
        <span>{threads.length === 1 ? "1 thread" : `${threads.length} threads`}</span>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={showResolved} onChange={(e) => useCommentsUi.getState().setShowResolved(e.target.checked)} />
          Show resolved
        </label>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {draft && (
          <div className="rounded-lg border border-accent p-2">
            <Composer label="New comment" placeholder="Add a comment… (Ctrl+Enter to send)" autoFocus onSend={create} />
          </div>
        )}
        {visible.length === 0 && !draft && (
          <EmptyState icon="comment" title="No comments" hint="Pick the comment tool (C) and click on the canvas to start a thread." />
        )}
        {visible.map(({ root, replies, orphan }) => {
          const open = root.id === activeId;
          return (
            <div
              key={root.id}
              className={`flex flex-col gap-2 rounded-lg border p-2 ${open ? "border-accent" : "border-line"} ${root.resolved ? "opacity-70" : ""}`}
            >
              <button
                type="button"
                className="flex flex-col gap-1 text-left outline-none focus-visible:shadow-[var(--ring)]"
                aria-expanded={open}
                onClick={() => useCommentsUi.getState().setActive(open ? null : root.id)}
              >
                <span className="text-[11px] text-fg-subtle">
                  {targetName(scene, root, orphan)}
                  {root.resolved && " · resolved"}
                  {replies.length > 0 && ` · ${replies.length === 1 ? "1 reply" : `${replies.length} replies`}`}
                </span>
                <Message c={root} />
              </button>
              {open && (
                <>
                  {replies.map((r) => (
                    <div key={r.id} className="ml-2 border-l border-line pl-2">
                      <Message c={r} />
                    </div>
                  ))}
                  <Composer
                    label={`Reply to ${root.author || "thread"}`}
                    placeholder="Reply…"
                    onSend={(text) =>
                      send(makeSetCommentOp({
                        id: uuid(), parentId: root.id, nodeId: "", pageId: "", x: 0, y: 0,
                        author, text, createdAt: now(), resolved: false,
                      }))
                    }
                  />
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => send(makeSetCommentOp({ ...root, resolved: !root.resolved }))}
                      className="rounded-md px-2 py-1 text-[12px] text-fg-muted outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)]"
                    >
                      {root.resolved ? "Reopen" : "Resolve"}
                    </button>
                    <IconButton
                      icon="trash" label="Delete thread" size={24}
                      onPress={() => { send(makeDeleteCommentOp(root.id)); useCommentsUi.getState().setActive(null); }}
                    />
                  </div>
                </>
              )}
            </div>
          );
        })}
        {hiddenCount > 0 && <p className="px-1 text-[11px] text-fg-subtle">{hiddenCount} resolved hidden</p>}
      </div>
    </div>
  );
}
