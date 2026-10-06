import { useEffect, useRef, useState } from "react";
import { Dialog, DialogTrigger, Popover } from "react-aria-components";
import { Button, Icon, IconButton, cls } from "./ds";
import { useScene } from "../store/store";
import { makeCreatePageOp, makeDeletePageOp, makeRenamePageOp, uuid } from "../tools/ops";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

// PAGE SELECTOR (nesting track, client part). The canvas shows ONE
// page at a time (canvasRenderer.ts::rootsOf reads currentPageId); this
// bar is where it is chosen, pages are added/deleted and renamed.
//
// Look: a compact button with the CURRENT page and a chevron, which opens a
// popover with the list (select, rename and delete per row, "Add a
// page" at the bottom). Next to it, "New page" and "Delete page" are always
// within click reach (they act on the current one).
//
// currentPageId is VIEW STATE and is read/written from the SAME store as the
// canvas (store.ts::setCurrentPage): a single state, nothing to sync by
// hand between bar and renderer. The page ops (CreatePage/DeletePage/
// RenamePage) already exist in proto + core + applyOp.ts: here they are only WIRED,
// through the same gesture path as the tools and panels.

// One op = one gesture = one send over the network (the M1b brief's rule, the same one
// the tools and LayersPanel follow): even a single page action goes through
// beginGesture/endGesture, so it travels on the wire like any other change.
function submit(op: Op): void {
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture([op]);
}

const RENAME_LABEL = "Page name";

// Inline rename field, twin of LayersPanel's (same reason it is a separate
// component: the session has its own state -- the typed text
// and whether it is already closed -- which must be born and die with the field).
function PageRenameField({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  // Closes ONCE only: Enter/Escape close, and the blur that comes right
  // after (the field is about to unmount) must not commit a second time.
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  function settle(commit: boolean) {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  }

  return (
    <input
      ref={ref}
      aria-label={RENAME_LABEL}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => settle(true)}
      onKeyDown={(e) => {
        // NO key leaves here: global shortcuts (undo/redo on window,
        // Escape/Delete on toolManager) must not act while a name is typed.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          settle(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          settle(false);
        }
      }}
      // flex-1: takes the space of the page button it replaces, so the
      // bar does not "jump" when rename opens.
      className={`${cls.input} flex-1 select-text border-accent bg-surface focus-visible:shadow-none!`}
    />
  );
}

// `compact`: the selector inside the left panel's tab row --
// no row of its own, no + and trash buttons (new page and deletion
// are already in the list the button opens).
export function PageBar({ compact = false }: { compact?: boolean } = {}) {
  const scene = useScene((s) => s.scene);
  const currentPageId = useScene((s) => s.currentPageId);
  // The page whose name is being renamed, or null. Only one at a time.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The list popover is CONTROLLED: it must be closed by hand after choosing a
  // page or starting a rename (the rename lives in the bar).
  const [open, setOpen] = useState(false);

  // Without a document there is no page to show: the bar disappears
  // entirely instead of drawing itself empty (same fallback as LayersPanel with a
  // null scene).
  if (!scene) return null;
  const pages = scene.pages;
  const current = pages.find((p) => p.id === currentPageId) ?? pages[0];
  const pageLabel = (name: string) => (name.trim() !== "" ? name : "Unnamed page");

  function createPage() {
    // id known BEFORE the submit: we move onto it right away, without waiting for
    // the echo (the op was already applied optimistically by endGesture).
    const id = uuid();
    submit(makeCreatePageOp(id, `Page ${pages.length + 1}`));
    useScene.getState().setCurrentPage(id);
    setOpen(false);
  }

  // The cascade, the refusal of the last page etc. belong to the core: here we only avoid
  // SENDING an op already known to be rejected (the last page cannot be
  // deleted), which is also why the buttons are disabled below.
  function deletePage(id: string | null) {
    if (pages.length <= 1 || id === null) return;
    submit(makeDeletePageOp(id));
  }

  function commitRename(id: string, raw: string) {
    setRenamingId(null);
    const name = raw.trim();
    const page = pages.find((p) => p.id === id);
    // No op for an unchanged or empty name (like LayersPanel's commitRename):
    // an op "that changes nothing" would cost an empty network round trip.
    if (!page || name === "" || name === page.name) return;
    submit(makeRenamePageOp(id, name));
  }

  return (
    <div
      role="group"
      aria-label="Pages"
      className={compact ? "flex w-[112px] shrink-0 items-center" : "flex h-10 shrink-0 items-center gap-1 border-b border-line px-2"}
    >
      {current && renamingId === current.id ? (
        <PageRenameField
          initial={current.name}
          placeholder={current.name || "Page"}
          onCommit={(value) => commitRename(current.id, value)}
          onCancel={() => setRenamingId(null)}
        />
      ) : (
        <DialogTrigger isOpen={open} onOpenChange={setOpen}>
          {/* The double click sits on the WRAPPER and not on the Button: react-aria-
              components does not forward onDoubleClick to the <button>, but the event
              bubbles up to it anyway. A single click opens the list; a
              double click opens the rename of the current page. */}
          <div
            className="min-w-0 flex-1"
            onDoubleClick={() => {
              if (!current) return;
              setOpen(false);
              setRenamingId(current.id);
            }}
          >
            <Button
              className={
                "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium text-fg " +
                "outline-none transition-colors hover:bg-surface-3 focus-visible:shadow-[var(--ring)] data-[pressed]:bg-surface-3"
              }
            >
              <Icon name="page" size={14} className="shrink-0 text-fg-subtle" />
              <span className="min-w-0 flex-1 truncate">{current ? pageLabel(current.name) : "Page"}</span>
              <Icon name="chevronDown" size={14} className="shrink-0 text-fg-subtle" />
            </Button>
          </div>
          <Popover
            placement="bottom start"
            offset={4}
            className="z-50 w-60 rounded-lg border border-line bg-raised text-fg shadow-pop outline-none"
          >
            <Dialog aria-label="Page list" className="flex flex-col outline-none">
              <ul className="flex max-h-64 flex-col gap-px overflow-auto p-1">
                {pages.map((p) => {
                  const active = p.id === currentPageId;
                  return (
                    <li key={p.id} className="group/page flex items-center gap-0.5">
                      <Button
                        aria-current={active ? "page" : undefined}
                        onPress={() => {
                          useScene.getState().setCurrentPage(p.id);
                          setOpen(false);
                        }}
                        className={[
                          "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none",
                          "data-[focus-visible]:shadow-[var(--ring)]",
                          active ? "bg-accent-soft font-medium text-accent" : "text-fg hover:bg-surface-3",
                        ].join(" ")}
                      >
                        <Icon name="check" size={13} className={active ? "shrink-0" : "shrink-0 opacity-0"} />
                        <span className="min-w-0 flex-1 truncate">{pageLabel(p.name)}</span>
                      </Button>
                      <span className="flex shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover/page:opacity-100">
                        <IconButton
                          icon="pen"
                          label={`Rename ${pageLabel(p.name)}`}
                          size={24}
                          onPress={() => {
                            setOpen(false);
                            // Rename lives in the bar and concerns the current page:
                            // we first move to the chosen page.
                            useScene.getState().setCurrentPage(p.id);
                            setRenamingId(p.id);
                          }}
                        />
                        <IconButton
                          icon="trash"
                          label={`Delete ${pageLabel(p.name)}`}
                          size={24}
                          isDisabled={pages.length <= 1}
                          onPress={() => deletePage(p.id)}
                        />
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="border-t border-line p-1">
                <Button
                  onPress={createPage}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg-muted outline-none hover:bg-surface-3 hover:text-fg data-[focus-visible]:shadow-[var(--ring)]"
                >
                  <Icon name="plus" size={13} />
                  Add a page
                </Button>
              </div>
            </Dialog>
          </Popover>
        </DialogTrigger>
      )}
      {!compact && <IconButton icon="plus" label="New page" onPress={createPage} />}
      {!compact && (
        <IconButton
          icon="trash"
          label="Delete page"
          // The LAST page cannot be deleted (ErrLastPage in the core): the button is
          // disabled instead of sending an op known to be rejected.
          isDisabled={pages.length <= 1}
          onPress={() => deletePage(currentPageId)}
        />
      )}
    </div>
  );
}
