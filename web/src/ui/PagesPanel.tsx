import { useMemo, useState } from "react";
import { Button } from "./ds";
import { useScene } from "../store/store";
import { resolveScene } from "../store/variables";
import { makeCreatePageWithMasterOp, uuid } from "../tools/ops";
import { duplicatePageOps, movePageBy } from "../tools/pageOps";
import { isRightPage, pageNumbers } from "../store/pageNumbers";
import { setupOf } from "../store/docSettings";
import type { FillLite, NodeLite, PageLite } from "../store/types";
import { PageSetupDialog } from "./PageSetupDialog";

// THE PAGES PANEL (Publishing): every page of the document as a thumbnail with its number, the master
// it applies and its size; click to open it. Masters are listed apart, under the pages. It shows the
// same document as the page list in the bar (ui/PageBar.tsx), but all at once, like the pages panel of a
// layout tool. Pages are numbered as the master's <#> token counts them (sections and numbering styles
// included): masters are not pages. With facing pages the pages are laid out as spreads, odd pages right.

const css = (f: FillLite | undefined): string => (f ? `rgb(${Math.round(f.r * 255)} ${Math.round(f.g * 255)} ${Math.round(f.b * 255)})` : "none");

/** A page in miniature: its sheet, margins and what is on it (master content included), text as bars. */
export function PageThumb({ page, nodes }: { page: PageLite; nodes: readonly NodeLite[] }) {
  const w = page.width ?? 400, h = page.height ?? 560;
  const bar = (n: NodeLite) => {
    const size = n.text?.style.fontSize ?? 12;
    const rows = Math.max(1, Math.min(Math.round(n.height / (size * 1.5)), 24));
    const first = n.text?.content.split("\n")[0].length ?? 4;
    return Array.from({ length: rows }, (_, i) => (
      <rect key={`${n.id}-${i}`} x={n.x} y={n.y + i * size * 1.5} width={i === 0 && rows === 1 ? Math.min(n.width, first * size * 0.52) : n.width * (i % 4 === 3 ? 0.6 : 1)} height={Math.max(size * 0.5, 3)} rx={2} fill={css(n.fills[0])} opacity={0.4} />
    ));
  };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" aria-hidden="true">
      <rect width={w} height={h} fill="#fff" />
      {nodes.map((n) => {
        if (n.kind === "text") return <g key={n.id}>{n.text?.content ? bar(n) : null}</g>;
        const fill = n.fills.length > 0 ? css(n.fills[0]) : "none";
        if (n.kind === "ellipse") return <ellipse key={n.id} cx={n.x + n.width / 2} cy={n.y + n.height / 2} rx={n.width / 2} ry={n.height / 2} fill={fill} />;
        return <rect key={n.id} x={n.x} y={n.y} width={n.width} height={n.height} fill={fill} />;
      })}
      {(page.marginLeft || page.marginTop || page.marginRight || page.marginBottom) ? (
        <rect x={page.marginLeft ?? 0} y={page.marginTop ?? 0} width={Math.max(0, w - (page.marginLeft ?? 0) - (page.marginRight ?? 0))} height={Math.max(0, h - (page.marginTop ?? 0) - (page.marginBottom ?? 0))} fill="none" stroke="#d6409f" strokeWidth={Math.max(1, w / 200)} opacity={0.5} />
      ) : null}
    </svg>
  );
}

export function PagesPanel() {
  const scene = useScene((s) => s.scene);
  const currentPageId = useScene((s) => s.currentPageId);
  const [setupOpen, setSetupOpen] = useState(false);
  // The drawn document: master content in place, text flowed. Top-level nodes only, for the thumbnails.
  const resolved = useMemo(() => (scene ? resolveScene(scene) : null), [scene]);
  const byPage = useMemo(() => {
    const m = new Map<string, NodeLite[]>();
    if (resolved) {
      const sorted = [...resolved.nodes.values()].sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
      for (const n of sorted) if (n.visible) m.set(n.parentId, [...(m.get(n.parentId) ?? []), n]);
    }
    return m;
  }, [resolved]);
  if (!scene) return null;

  const pages = scene.pages;
  const normal = pages.filter((p) => !p.isMaster);
  const masters = pages.filter((p) => p.isMaster);
  const current = pages.find((p) => p.id === currentPageId) ?? pages[0];
  const numbers = pageNumbers(pages);
  const facing = scene.settings?.facingPages === true;
  // Spreads: a left-hand page with the right-hand page after it; the first page of a section is often alone.
  const spreads: PageLite[][] = [];
  for (const p of normal) {
    const last = spreads[spreads.length - 1];
    if (isRightPage(numbers.get(p.id)) && last?.length === 1 && !isRightPage(numbers.get(last[0].id))) last.push(p);
    else spreads.push([p]);
  }

  function submit(...ops: Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0]) {
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture(ops);
  }
  function add(master: boolean) {
    const id = uuid();
    const letter = String.fromCharCode(65 + (masters.length % 26));
    submit(
      makeCreatePageWithMasterOp(id, master ? `${letter}-Master` : `Page ${normal.length + 1}`, {
        ...setupOf(current), ...(master ? { isMaster: true } : current && !current.isMaster && current.masterId ? { masterId: current.masterId } : {}),
      }),
    );
    useScene.getState().setCurrentPage(id);
  }

  function duplicate() {
    if (!current) return;
    const id = uuid();
    submit(...duplicatePageOps(scene!, current.id, id));
    useScene.getState().setCurrentPage(id);
  }
  function move(delta: number) {
    if (current) submit(...movePageBy(pages, current.id, delta));
  }

  const card = (p: PageLite, label: string) => {
    const w = p.width ?? 400, h = p.height ?? 560;
    const master = p.masterId ? pages.find((m) => m.id === p.masterId) : undefined;
    const active = p.id === current?.id;
    return (
      <div key={p.id}>
        <button
          type="button"
          aria-label={`Open ${p.name || "page"}`}
          aria-current={active ? "page" : undefined}
          onClick={() => useScene.getState().setCurrentPage(p.id)}
          className={"flex w-full flex-col items-center gap-1 rounded-md p-1.5 outline-none focus-visible:shadow-[var(--ring)] " + (active ? "bg-accent-soft" : "hover:bg-surface-3")}
        >
          <span className="flex h-[112px] w-full items-center justify-center">
            <span className="block max-h-full max-w-full overflow-hidden border border-line-strong bg-white shadow-sm" style={{ aspectRatio: `${w} / ${h}`, height: w > h ? undefined : "100%", width: w > h ? "100%" : undefined }}>
              <PageThumb page={p} nodes={byPage.get(p.id) ?? []} />
            </span>
          </span>
          <span className="flex w-full items-baseline justify-center gap-1.5 text-[11px]">
            <span className="font-semibold tabular-nums text-fg">{label}</span>
            <span className="truncate text-fg-muted">{p.name}</span>
            {master && <span className="shrink-0 rounded-sm bg-surface-3 px-1 font-mono text-[10px] text-fg-subtle">{master.name.slice(0, 1)}</span>}
          </span>
        </button>
      </div>
    );
  };
  const item = (p: PageLite, label: string) => <li key={p.id}>{card(p, label)}</li>;

  return (
    <div className="flex h-full min-h-0 flex-col" role="region" aria-label="Pages">
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <ul aria-label="Pages" className="flex flex-col gap-1">
          {facing
            ? spreads.map((row) => (
              <li key={row[0].id} aria-label={`Spread ${row.map((p) => numbers.get(p.id)?.label).join("–")}`} className="grid grid-cols-2 gap-1">
                {isRightPage(numbers.get(row[0].id)) && <div aria-hidden="true" />}
                {row.map((p) => card(p, numbers.get(p.id)?.label ?? ""))}
              </li>
            ))
            : normal.map((p) => item(p, numbers.get(p.id)?.label ?? ""))}
        </ul>
        {masters.length > 0 && (
          <>
            <h3 className="mt-3 px-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">Masters</h3>
            <ul aria-label="Masters" className="mt-1 flex flex-col gap-1">
              {masters.map((p) => item(p, p.name.slice(0, 1)))}
            </ul>
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5 border-t border-line p-2">
        <Button icon="plus" onPress={() => add(false)}>Page</Button>
        <Button icon="plus" onPress={() => add(true)}>Master</Button>
        <Button icon="page" onPress={() => setSetupOpen(true)}>Setup…</Button>
        <Button onPress={duplicate} isDisabled={!current}>Duplicate</Button>
        <Button aria-label="Move page earlier" onPress={() => move(-1)} isDisabled={!current || pages.indexOf(current) === 0}>Earlier</Button>
        <Button aria-label="Move page later" onPress={() => move(1)} isDisabled={!current || pages.indexOf(current) === pages.length - 1}>Later</Button>
      </div>
      <PageSetupDialog isOpen={setupOpen} onOpenChange={setSetupOpen} />
    </div>
  );
}
