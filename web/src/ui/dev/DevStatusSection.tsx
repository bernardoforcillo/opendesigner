import { useMemo, useState } from "react";
import { useScene } from "@/store/store";
import { loadNickname } from "@/store/presence";
import { ANNOTATION_CATEGORIES, annotationsOf, categoryColor, MAX_ANNOTATION_RUNES, MAX_READY_NOTE_RUNES, readyOfScene } from "@/store/devMode";
import { submit } from "@/flow/commands";
import {
  annotateOps, deleteAnnotationOps, devFrameOf, groupChanges, humanProperty, markReadyOps, unmarkOps, useReadyComparison,
} from "@/dev/devStatus";
import { Badge, Button, cls } from "@/ui/ds";

// "DEV STATUS" (top of Ship, right column of Develop): hand a frame over to development and leave
// the developer what the picture does not say.
//
//  - Ready for dev: mark the frame (the server keeps a snapshot), mark it again after changes
//    (a new baseline) or take the mark off. While it is ready, "Compare changes" lists what differs
//    from the snapshot, layer by layer and property by property.
//  - Annotations on the selected layer: a note with a colour-coded category. They show here and are
//    written as comments into the exported code.
// Every action is one op (ops without an inverse: none of this enters the undo stack).

const when = (sec: number) => (sec ? new Date(sec * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

function Changes({ frameId, markedAt }: { frameId: string; markedAt: number }) {
  const cmp = useReadyComparison(frameId, true, markedAt);
  const groups = useMemo(() => groupChanges(cmp.result?.changes ?? []), [cmp.result]);
  const total = cmp.result?.changes.length ?? 0;
  const pick = (id: string) => {
    const st = useScene.getState();
    if (st.scene?.nodes.has(id)) st.setSelection([id]);
  };
  return (
    <div className="mt-2" data-testid="compare-changes">
      <div className="mb-1 flex items-center gap-2">
        <h4 className={cls.label}>Compare changes</h4>
        <span className="ml-auto" />
        {cmp.status === "loading" && <span role="status" className="text-[11px] text-fg-subtle">Comparing…</span>}
        {cmp.result && (total === 0 ? <Badge tone="ok">Unchanged</Badge> : <Badge tone="warn">{total} {total === 1 ? "change" : "changes"}</Badge>)}
      </div>
      {cmp.status === "error" && <p role="alert" className="rounded-md bg-danger-soft px-2 py-1 text-[12px] text-danger">Cannot compare: {cmp.error}</p>}
      {cmp.result && total === 0 && <p className="text-[12px] text-fg-subtle">The frame is as it was when it was marked.</p>}
      <ul className="flex flex-col gap-1.5">
        {groups.map((g) => (
          <li key={g.nodeId}>
            <button
              type="button"
              onClick={() => pick(g.nodeId)}
              className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]"
            >
              <span className="truncate font-medium text-fg">{g.nodeName || "(unnamed)"}</span>
              {g.kind !== "changed" && <Badge tone={g.kind === "added" ? "ok" : "danger"}>{g.kind}</Badge>}
            </button>
            {g.rows.length > 0 && (
              <ul className="pl-2">
                {g.rows.map((r) => (
                  <li key={r.property} className="flex flex-wrap items-baseline gap-x-1.5 text-[12px] leading-5">
                    <span className="text-fg-muted">{humanProperty(r.property)}</span>
                    <span className="font-mono text-[11px] text-fg-subtle line-through decoration-fg-subtle/60">{r.before === "" ? "unset" : r.before}</span>
                    <span aria-hidden="true" className="text-fg-subtle">→</span>
                    <span className="font-mono text-[11px] text-fg">{r.after === "" ? "unset" : r.after}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Annotations({ nodeId }: { nodeId: string }) {
  const scene = useScene((s) => s.scene);
  const [category, setCategory] = useState<string>("note");
  const [text, setText] = useState("");
  if (!scene) return null;
  const list = annotationsOf(scene, nodeId);
  const node = scene.nodes.get(nodeId);
  const add = () => {
    const ops = annotateOps(nodeId, category, text, loadNickname());
    if (ops.length === 0) return;
    submit(ops);
    setText("");
  };
  return (
    <div className="mt-3" data-testid="annotations">
      <h4 className={`${cls.label} mb-1`}>Annotations · {node?.name || "(unnamed)"}</h4>
      <ul aria-label="Annotations" className="mb-2 flex flex-col gap-1">
        {list.map((a) => (
          <li key={a.id} className="group flex items-start gap-1.5 rounded-md bg-surface-2 px-2 py-1.5" data-category={a.category}>
            <span aria-hidden="true" className="mt-1 size-2 shrink-0 rounded-full" style={{ background: categoryColor(a.category) }} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium capitalize text-fg-subtle">{a.category}{a.author ? ` · ${a.author}` : ""}</p>
              <p className="whitespace-pre-wrap break-words text-[12px] leading-snug text-fg">{a.text}</p>
            </div>
            <button
              type="button"
              aria-label={`Delete the ${a.category} annotation`}
              onClick={() => submit(deleteAnnotationOps(scene, a.id))}
              className="rounded px-1 text-[12px] text-fg-subtle opacity-0 outline-none hover:text-danger focus-visible:opacity-100 focus-visible:shadow-[var(--ring)] group-hover:opacity-100"
            >
              ×
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="text-[12px] text-fg-subtle">Nothing yet. Tell the developer what the picture does not.</li>}
      </ul>
      <div role="radiogroup" aria-label="Category" className="mb-1.5 flex flex-wrap gap-1">
        {ANNOTATION_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={category === c.id}
            onClick={() => setCategory(c.id)}
            className={`flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] outline-none focus-visible:shadow-[var(--ring)] ${category === c.id ? "border-transparent text-white" : "border-line text-fg-muted hover:bg-surface-3"}`}
            style={category === c.id ? { background: c.color } : undefined}
          >
            <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: category === c.id ? "#fff" : c.color }} />
            {c.label}
          </button>
        ))}
      </div>
      <textarea
        aria-label="Annotation text"
        value={text}
        rows={2}
        maxLength={MAX_ANNOTATION_RUNES}
        placeholder="What should the developer know?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } }}
        className={`${cls.input} h-auto py-1.5 font-sans`}
      />
      <Button className="mt-1.5 h-6 w-full text-[12px]" isDisabled={text.trim() === ""} onPress={add}>Add annotation</Button>
    </div>
  );
}

export function DevStatusSection() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const [note, setNote] = useState("");
  if (!scene || selection.length === 0) {
    return (
      <section className="border-b border-line p-3" aria-label="Dev status" data-testid="dev-status">
        <h3 className={`${cls.sectionTitle} mb-1`}>Dev status</h3>
        <p className="text-[12px] text-fg-subtle">Select a frame to mark it ready for dev, or any layer to annotate it.</p>
      </section>
    );
  }
  const frameId = devFrameOf(scene, selection);
  const frame = frameId ? scene.nodes.get(frameId) : undefined;
  const ready = frameId ? readyOfScene(scene)[frameId] : undefined;
  const layerId = selection[0];
  return (
    <section className="border-b border-line p-3" aria-label="Dev status" data-testid="dev-status">
      <div className="mb-2 flex items-center gap-2">
        <h3 className={cls.sectionTitle}>Dev status</h3>
        <span className="ml-auto" />
        {frame && (ready ? <Badge tone="ok">Ready</Badge> : <Badge>Not marked</Badge>)}
      </div>
      {frame && frameId ? (
        <div>
          <p className="mb-1.5 truncate text-[12px] text-fg-muted">{frame.name || "(unnamed)"}</p>
          {ready ? (
            <p className="mb-1.5 text-[12px] leading-snug text-fg-subtle">
              Marked {when(ready.markedAt)}{ready.markedBy ? ` by ${ready.markedBy}` : ""}{ready.note ? `: ${ready.note}` : ""}
            </p>
          ) : null}
          <input
            aria-label="Note for the developer"
            value={note}
            maxLength={MAX_READY_NOTE_RUNES}
            placeholder={ready ? "Note for the new baseline (optional)" : "Note for the developer (optional)"}
            onChange={(e) => setNote(e.target.value)}
            className={`${cls.input} mb-1.5 font-sans`}
          />
          <div className="flex gap-1.5">
            <Button
              variant="primary"
              className="h-7 flex-1 text-[12px]"
              onPress={() => { submit(markReadyOps(frameId, note, loadNickname())); setNote(""); }}
            >
              {ready ? "Mark ready again" : "Mark ready for dev"}
            </Button>
            {ready && (
              <Button className="h-7 text-[12px]" onPress={() => submit(unmarkOps(scene, frameId))}>Unmark</Button>
            )}
          </div>
          {ready && <Changes frameId={frameId} markedAt={ready.markedAt} />}
        </div>
      ) : (
        <p className="text-[12px] text-fg-subtle">The selection is not inside a frame: only frames can be marked ready.</p>
      )}
      <Annotations key={layerId} nodeId={layerId} />
    </section>
  );
}
