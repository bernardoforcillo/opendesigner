import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Icon } from "../ds";
import { useScene } from "../../store/store";
import { docClient } from "../../rpc/client";

/**
 * Renames the open document: first on the server (which makes it durable), then
 * in the store, both in the view and in the confirmed base -- the view is
 * rebuilt from that one on every record, and a name written only on the view
 * would go back to the old one at the next op.
 */
export async function renameOpenDocument(name: string, client: Pick<typeof docClient, "renameDocument"> = docClient): Promise<void> {
  const scene = useScene.getState().scene;
  if (!scene) return;
  await client.renameDocument({ docId: scene.id, name });
  useScene.setState((st) => ({
    scene: st.scene ? { ...st.scene, name } : st.scene,
    confirmed: st.confirmed ? { ...st.confirmed, name } : st.confirmed,
  }));
}

// Whether the name is being edited: turned on by a click on the name and by the
// menu's "Rename document" item (shell/DocMenu.tsx), which lives elsewhere.
export const useDocNameEditing = create<{ editing: boolean; setEditing: (v: boolean) => void }>((set) => ({
  editing: false,
  setEditing: (editing) => set({ editing }),
}));

// THE DOCUMENT NAME, in the middle of the TopBar: a title that becomes a field
// (Enter confirms, Esc cancels, losing focus confirms).
export function DocName() {
  const docName = useScene((s) => s.scene?.name ?? "");
  const editing = useDocNameEditing((s) => s.editing);
  const setEditing = useDocNameEditing((s) => s.setEditing);
  const [draft, setDraft] = useState(docName);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!editing) return;
    done.current = false;
    setDraft(docName);
    setError(null);
    const grab = () => { input.current?.focus(); input.current?.select(); };
    grab();
    // Opened from the menu, the closing menu hands focus back to its button:
    // take it back, but only if it really went elsewhere (someone already
    // typing must not see the text reselected).
    const t = setTimeout(() => { if (document.activeElement !== input.current) grab(); }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  async function commit() {
    if (done.current) return;
    const name = draft.trim();
    if (name === "" || name === docName) { done.current = true; setEditing(false); return; }
    done.current = true;
    try {
      await renameOpenDocument(name);
      setEditing(false);
    } catch (e) {
      done.current = false;
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        aria-label="Rename document"
        title="Rename document"
        onClick={() => setEditing(true)}
        className="group flex h-8 max-w-[320px] items-center gap-1.5 rounded-md px-2 text-[13px] font-semibold outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]"
      >
        <span className="min-w-0 truncate">{docName === "" ? "Untitled" : docName}</span>
        <Icon name="pen" size={12} className="shrink-0 text-fg-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
    );
  }
  return (
    <div className="relative">
      <input
        ref={input}
        aria-label="Document name"
        value={draft}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Keys must not reach the editor's shortcuts.
          e.stopPropagation();
          if (e.key === "Enter") void commit();
          else if (e.key === "Escape") { done.current = true; setEditing(false); }
        }}
        onBlur={() => void commit()}
        className="h-8 w-[260px] rounded-md border border-accent bg-surface px-2 text-center text-[13px] font-semibold text-fg outline-none"
      />
      {error && (
        <p role="alert" className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md bg-raised px-2 py-1 text-[12px] text-danger shadow-pop">
          {error}
        </p>
      )}
    </div>
  );
}
