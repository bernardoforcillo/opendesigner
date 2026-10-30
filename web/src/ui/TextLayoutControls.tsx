import { useScene } from "@/store/store";
import { currentT } from "@/i18n";
import { DEFAULT_WRAP_OFFSET, isWrapper, wrapOffsetOf, wrapOps } from "@/store/wrap";
import { META_TEXT_PATH, textOnPathOps } from "@/store/textPath";
import { addColumnOps, addRowOps, cellOf, deleteColumnOps, deleteRowOps, mergeCellsOps, readTable, resizeTableOps, selectionCellRange, spanOf, splitCellOps, tableIdOf } from "@/tools/tableOps";
import { anchorOps, anchorsOf, releaseAnchorOps } from "@/store/anchored";
import { Button } from "@/ui/ds";
import { NumberField } from "@/ui/fields/NumberField";

// Names the shared controls cannot translate on their own (options, text nodes). See docs/localization.md.
const tr = (key: string, vars?: Record<string, string | number>) => currentT().tx(key, vars);

// CONTROLS of the properties panel for the layout of text around and along things:
//  - Text wrap: an object that text flows around (store/wrap.ts);
//  - Text on a path: a text and a vector selected together run the text along the outline (store/textPath.ts);
//  - Table: rows and columns of the table the selection is in (tools/tableOps.ts).

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

const Box = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section aria-label={title} className="flex flex-col gap-1.5 border-b border-line px-3 py-2.5">
    <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">{title}</h3>
    {children}
  </section>
);

export function WrapControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length === 0) return null;
  const nodes = selection.map((id) => scene.nodes.get(id)).filter((n) => !!n);
  if (nodes.length !== selection.length || nodes.some((n) => n!.kind === "text" || n!.kind === "group")) return null;
  const on = nodes.every((n) => isWrapper(n!));
  const offset = nodes.length === 1 ? wrapOffsetOf(nodes[0]!) : DEFAULT_WRAP_OFFSET;
  return (
    <Box title="Text wrap">
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" aria-label="Wrap text around this object" checked={on} onChange={(e) => run(wrapOps(scene, selection, e.target.checked ? "box" : "", offset))} />
        Text flows around it
      </label>
      {on && <NumberField label="Gap" minValue={0} value={offset} onCommit={(v) => run(wrapOps(scene, selection, "box", v))} />}
    </Box>
  );
}

export function TextOnPathControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene) return null;
  const texts = selection.filter((id) => scene.nodes.get(id)?.kind === "text");
  const vectors = selection.filter((id) => scene.nodes.get(id)?.kind === "vector");
  const onPath = texts.filter((id) => scene.nodes.get(id)?.meta?.[META_TEXT_PATH]);
  if (texts.length === 1 && vectors.length === 1 && selection.length === 2) {
    return (
      <Box title="Text on a path">
        <Button onPress={() => run(textOnPathOps(scene, texts[0], vectors[0]))}>Run the text along the path</Button>
      </Box>
    );
  }
  if (texts.length === 1 && selection.length === 1 && onPath.length === 1) {
    return (
      <Box title="Text on a path">
        <Button onPress={() => run(textOnPathOps(scene, texts[0], ""))}>Release from the path</Button>
      </Box>
    );
  }
  return null;
}

export function AnchorControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene) return null;
  const texts = selection.filter((id) => scene.nodes.get(id)?.kind === "text");
  const others = selection.filter((id) => scene.nodes.get(id)?.kind !== "text");
  if (texts.length === 1 && others.length === 1 && selection.length === 2) {
    return (
      <Box title="Anchored object">
        <Button onPress={() => run(anchorOps(scene, texts[0], others[0]))}>Anchor the object in the text</Button>
        <p className="text-[12px] text-fg-subtle">It goes at the end of the text; move its [@…] marker in the text to place it.</p>
      </Box>
    );
  }
  if (texts.length === 1 && selection.length === 1) {
    const text = scene.nodes.get(texts[0])!;
    const anchors = anchorsOf(scene, text);
    if (anchors.length === 0) return null;
    return (
      <Box title="Anchored objects">
        {anchors.map((a) => (
          <div key={a.at} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[13px]">{a.node.name || a.node.kind}</span>
            <Button onPress={() => run(releaseAnchorOps(scene, text.id, a.at, a.end))}>Release</Button>
          </div>
        ))}
      </Box>
    );
  }
  return null;
}

export function TableControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length === 0) return null;
  // Several cells of one table: the one thing to do with them is merge them into one.
  if (selection.length > 1) {
    const range = selectionCellRange(scene, selection);
    if (!range) return null;
    const ops = mergeCellsOps(scene, range);
    return (
      <Box title={tr("Table")}>
        <p className="text-[12px] text-fg-subtle">{(range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1)} cells selected</p>
        <Button isDisabled={ops.length === 0} onPress={() => run(ops)}>Merge cells</Button>
        {ops.length === 0 && <p className="text-[12px] text-fg-subtle">A merged cell that sticks out of the block is in the way: select the whole of it, or split it first.</p>}
      </Box>
    );
  }
  const tableId = tableIdOf(scene, selection[0]);
  const table = tableId ? readTable(scene, tableId) : null;
  if (!tableId || !table) return null;
  const cell = cellOf(scene, selection[0]);
  const [r, c] = cell ?? [table.rows.length - 1, table.cols.length - 1];
  const [rs, cs] = cell ? spanOf(table.cells.get(`${r},${c}`)) : [1, 1];
  return (
    <Box title={tr("Table")}>
      <p className="text-[12px] text-fg-subtle">{table.rows.length} rows × {table.cols.length} columns{cell ? ` · cell ${r + 1}, ${c + 1}${rs > 1 || cs > 1 ? ` (merged, ${rs} × ${cs})` : ""}` : " · select a cell for row and column actions"}</p>
      {(rs > 1 || cs > 1) && <Button onPress={() => run(splitCellOps(scene, tableId, r, c))}>Split cell</Button>}
      <div className="grid grid-cols-2 gap-1.5">
        <Button isDisabled={!cell} onPress={() => run(addRowOps(scene, tableId, r - 1))}>Row above</Button>
        <Button isDisabled={!cell} onPress={() => run(addRowOps(scene, tableId, r))}>Row below</Button>
        <Button isDisabled={!cell} onPress={() => run(addColumnOps(scene, tableId, c - 1))}>Column left</Button>
        <Button isDisabled={!cell} onPress={() => run(addColumnOps(scene, tableId, c))}>Column right</Button>
        <Button variant="danger" isDisabled={!cell || table.rows.length <= 1} onPress={() => run(deleteRowOps(scene, tableId, r))}>Delete row</Button>
        <Button variant="danger" isDisabled={!cell || table.cols.length <= 1} onPress={() => run(deleteColumnOps(scene, tableId, c))}>Delete column</Button>
      </div>
      {cell && (
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField label="Column width" minValue={8} value={table.cols[c]} onCommit={(v) => run(resizeTableOps(scene, tableId, "col", c, v))} />
          <NumberField label="Row height" minValue={8} value={table.rows[r]} onCommit={(v) => run(resizeTableOps(scene, tableId, "row", r, v))} />
        </div>
      )}
    </Box>
  );
}
