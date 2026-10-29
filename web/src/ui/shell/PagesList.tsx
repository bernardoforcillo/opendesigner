import { useState } from "react";
import { IconButton } from "@/ui/ds";
import { useScene } from "@/store/store";
import { makeCreatePageWithMasterOp, makeRenamePageOp, uuid } from "@/tools/ops";
import { setupOf } from "@/store/docSettings";
import { PageRenameField } from "@/ui/PageBar";

// THE PAGES LIST (Figma-style workspace, left panel): the document's pages as a list above the layers, the
// way a design tool shows them -- click to open one, double-click to rename, + to add. It is the always-visible
// form of the page selector (PageBar): the same ops, the same current page in the store. Masters are not pages
// of a design and are left to the Publishing workspace.
export function PagesList() {
  const scene = useScene((s) => s.scene);
  const currentPageId = useScene((s) => s.currentPageId);
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!scene) return null;
  const pages = scene.pages.filter((p) => !p.isMaster);
  const current = pages.find((p) => p.id === currentPageId) ?? pages[0];

  function submit(...ops: Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0]) {
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture(ops);
  }
  function add() {
    const id = uuid();
    submit(makeCreatePageWithMasterOp(id, `Page ${pages.length + 1}`, { ...setupOf(current), masterId: current && !current.isMaster ? current.masterId : undefined }));
    useScene.getState().setCurrentPage(id);
  }
  function commit(id: string, raw: string) {
    setRenaming(null);
    const name = raw.trim();
    const page = pages.find((p) => p.id === id);
    if (!page || name === "" || name === page.name) return;
    submit(makeRenamePageOp(id, name));
  }

  return (
    <section aria-label="Pages" className="flex max-h-48 shrink-0 flex-col border-b border-line">
      <div className="flex h-9 items-center gap-1 pl-3 pr-1.5">
        <h3 className="flex-1 text-[12px] font-semibold text-fg">Pages</h3>
        <IconButton icon="plus" label="Add a page" size={24} onPress={add} />
      </div>
      <ul className="min-h-0 overflow-y-auto px-1.5 pb-1.5">
        {pages.map((p) => {
          const active = p.id === current?.id;
          return (
            <li key={p.id}>
              {renaming === p.id ? (
                <PageRenameField initial={p.name} placeholder={p.name || "Page"} onCommit={(v) => commit(p.id, v)} onCancel={() => setRenaming(null)} />
              ) : (
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => useScene.getState().setCurrentPage(p.id)}
                  onDoubleClick={() => setRenaming(p.id)}
                  className={
                    "flex h-7 w-full items-center rounded-md px-2 text-left text-[13px] outline-none focus-visible:shadow-[var(--ring)] " +
                    (active ? "bg-accent-soft font-medium text-accent" : "text-fg hover:bg-surface-3")
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{p.name.trim() !== "" ? p.name : "Unnamed page"}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
