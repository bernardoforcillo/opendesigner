import { useEffect, useRef, useState } from "react";
import { Button as RacButton, Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import { Icon } from "../ui/ds";
import { pathForDoc, relativeTime } from "./route";
import { useAppNavigate } from "./nav";

// A DOCUMENT'S CARD in the Home. The whole card is a REAL link (`/doc/<id>`):
// it opens with a click, with Enter, in a new tab with the middle button, and
// can be copied from the browser's context menu. Rename and Delete live in a
// separate menu, on top of the link (never inside: an <a> cannot contain buttons).

export interface DocSummary {
  id: string; name: string; updatedAt: number; screens: number; flows: number;
}

/**
 * The thumbnail: the document's content is not read (it would cost an open
 * per card), a diagram is DRAWN from what the list already knows -- as many screens
 * as it has (up to four), connected by an arrow if it has flows.
 */
export function DocThumb({ screens, flows }: { screens: number; flows: number }) {
  if (screens === 0) {
    return (
      <div className="flex h-full items-center justify-center text-fg-subtle">
        <div className="flex h-[54px] w-[30px] items-center justify-center rounded-[5px] border border-dashed border-line-strong">
          <Icon name="plus" size={10} />
        </div>
      </div>
    );
  }
  const shown = Math.min(screens, 4);
  return (
    <div className="flex h-full items-center justify-center gap-2.5">
      {Array.from({ length: shown }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <div className="flex h-[58px] w-[28px] flex-col gap-[3px] rounded-[5px] border border-line-strong bg-surface p-[3px]">
            <span className="h-[5px] w-3/5 rounded-full bg-fg-subtle/50" />
            <span className="h-[3px] w-full rounded-full bg-line-strong" />
            <span className="h-[3px] w-4/5 rounded-full bg-line-strong" />
            <span className={`mt-auto h-[7px] w-full rounded-[2px] ${i === 0 ? "bg-accent" : "bg-accent/40"}`} />
          </div>
          {flows > 0 && i < shown - 1 && <Icon name="chevronRight" size={10} className="text-flow" />}
        </div>
      ))}
      {screens > shown && <span className="text-[11px] font-medium tabular-nums text-fg-subtle">+{screens - shown}</span>}
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DocCard({
  doc, now, onRename, onDelete,
}: {
  doc: DocSummary; now: number;
  /** Returns a promise: the card stays in edit mode until the server responds. */
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (doc: DocSummary) => void;
}) {
  const navigate = useAppNavigate();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(doc.name);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) { input.current?.focus(); input.current?.select(); }
  }, [renaming]);

  async function commit() {
    const name = draft.trim();
    if (name === "" || name === doc.name) { setRenaming(false); setDraft(doc.name); setError(null); return; }
    try {
      await onRename(doc.id, name);
      setRenaming(false); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const meta = [plural(doc.screens, "screen", "screens"), plural(doc.flows, "flow", "flows")].join(" · ");

  return (
    <article className="group relative overflow-hidden rounded-xl border border-line bg-surface transition-shadow hover:shadow-[var(--shadow-bar)]">
      <a
        href={pathForDoc(doc.id)}
        aria-label={`Open ${doc.name}`}
        className="block outline-none focus-visible:shadow-[var(--ring)]"
        // While renaming the link must not steal clicks or Enter.
        onClick={(e) => {
          if (renaming) { e.preventDefault(); return; }
          // A plain click navigates inside the app (no page reload); modified
          // clicks (new tab, new window, download) keep the browser's behaviour.
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          navigate(pathForDoc(doc.id));
        }}
      >
        <div className="h-[116px] border-b border-line bg-surface-2"><DocThumb screens={doc.screens} flows={doc.flows} /></div>
        <div className="px-3 pb-3 pt-2.5">
          {renaming ? <div className="h-[18px]" /> : <h3 className="truncate text-[13px] font-semibold text-fg">{doc.name}</h3>}
          <p className="mt-0.5 truncate text-[12px] text-fg-subtle">
            <span title={doc.updatedAt ? new Date(doc.updatedAt * 1000).toLocaleString("en-US") : undefined}>Edited {relativeTime(doc.updatedAt, now)}</span>
          </p>
          <p className="truncate text-[12px] text-fg-muted">{meta}</p>
        </div>
      </a>

      {renaming && (
        <div className="absolute inset-x-2 top-[122px]">
          <input
            ref={input}
            aria-label="Document name"
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              else if (e.key === "Escape") { setRenaming(false); setDraft(doc.name); setError(null); }
            }}
            onBlur={() => void commit()}
            className="h-7 w-full rounded-md border border-accent bg-surface px-2 text-[13px] font-semibold text-fg outline-none"
          />
          {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
        </div>
      )}

      <MenuTrigger>
        <RacButton
          aria-label={`Actions for ${doc.name}`}
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-surface/90 text-fg-muted opacity-0 shadow-[0_0_0_1px_var(--line)] outline-none transition-opacity hover:text-fg focus-visible:opacity-100 focus-visible:shadow-[var(--ring)] group-hover:opacity-100 data-[pressed]:opacity-100"
        >
          <Icon name="more" size={16} />
        </RacButton>
        <Popover placement="bottom end" offset={4} className="z-50 min-w-[160px] rounded-xl bg-raised p-1 text-[13px] text-fg shadow-pop">
          <Menu className="outline-none" onAction={(k) => {
            if (k === "rename") { setDraft(doc.name); setRenaming(true); }
            else if (k === "delete") onDelete(doc);
          }}>
            <MenuItem id="rename" className={ITEM}><Icon name="pen" size={14} /> Rename</MenuItem>
            <MenuItem id="delete" className={`${ITEM} text-danger`}><Icon name="trash" size={14} /> Delete</MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
    </article>
  );
}

const ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none " +
  "data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3";
