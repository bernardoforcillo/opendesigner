import { useScene } from "@/store/store";
import { applyObjectStyleOps, createObjectStyleOps, redefineObjectStyleOps, stylable } from "@/tools/objectStyles";
import { layerOf, moveToLayerOps } from "@/tools/layers";
import { effectivePpi, fitImageOps, pickImageFile, ppiStatus, relinkImage } from "@/tools/imageLinks";
import { Button, cls } from "@/ui/ds";

// CONTROLS of the properties panel for shared looks and links:
//  - Object style: apply a shared look to the selection, make one from it, redefine it;
//  - Layer: put the selection on a layer shared by all pages;
//  - Link (image): the file it came from, its effective resolution, fitting, relinking.
// The dialogs for managing them all are in the document menu (Object styles…, Layers…, Links…).

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

const MIXED = "__mixed";

const Box = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-1.5 border-b border-line px-3 py-2.5">
    <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">{title}</h3>
    {children}
  </section>
);

export function ObjectStyleControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length === 0) return null;
  const nodes = selection.map((id) => scene.nodes.get(id));
  if (!nodes.every(stylable)) return null;
  const ids = nodes.map((n) => n!.objectStyleId ?? "");
  const value = ids.every((v) => v === ids[0]) ? ids[0] : MIXED;
  const styles = Object.values(scene.objectStyles).sort((a, b) => a.name.localeCompare(b.name));
  const single = nodes.length === 1 ? nodes[0]! : null;
  if (styles.length === 0 && !single) return null;
  return (
    <Box title="Object style">
      <select aria-label="Object style" className={cls.select} value={value}
        onChange={(e) => run(applyObjectStyleOps(scene, selection, e.target.value === "" ? null : e.target.value))}>
        {value === MIXED && <option value={MIXED} disabled>Mixed</option>}
        <option value="">No object style</option>
        {styles.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      {single && (
        <div className="flex flex-wrap gap-1.5">
          {!single.objectStyleId && (
            <Button onPress={() => {
              const made = createObjectStyleOps(scene, single.id, `Style ${styles.length + 1}`);
              if (made) run(made.ops);
            }}>New style from this</Button>
          )}
          {single.objectStyleId && scene.objectStyles[single.objectStyleId] && (
            <Button onPress={() => run(redefineObjectStyleOps(scene, single.objectStyleId!, single.id))}>Redefine style</Button>
          )}
        </div>
      )}
    </Box>
  );
}

export function LayerControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length === 0 || scene.layers.length === 0) return null;
  const cur = layerOf(scene, selection);
  return (
    <Box title="Layer">
      <select aria-label="Layer" className={cls.select} value={cur === undefined ? MIXED : (cur ?? "")}
        onChange={(e) => run(moveToLayerOps(scene, selection, e.target.value === "" ? null : e.target.value))}>
        {cur === undefined && <option value={MIXED} disabled>Mixed</option>}
        <option value="">No layer</option>
        {scene.layers.map((l) => <option key={l.id} value={l.id}>{l.name}{l.hidden ? " (hidden)" : l.locked ? " (locked)" : ""}</option>)}
      </select>
    </Box>
  );
}

export function ImageLinkControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length !== 1) return null;
  const n = scene.nodes.get(selection[0]);
  if (!n || n.kind !== "image") return null;
  const ppi = effectivePpi(n);
  const status = ppiStatus(ppi);
  const known = (n.image?.pixelWidth ?? 0) > 0;
  return (
    <Box title="Link">
      <p className="truncate text-[12px]" title={n.image?.originalName}>{n.image?.originalName || "Unknown file"}</p>
      <p className="text-[12px] text-fg-subtle">
        {known ? `${n.image!.pixelWidth} × ${n.image!.pixelHeight} px` : "Size in pixels unknown"}
        {ppi !== null ? ` · ${Math.round(ppi)} ppi` : ""}
      </p>
      {status === "low" && <p role="status" className="text-[12px] text-danger">Low resolution for print: under 150 ppi at this size.</p>}
      <div className="grid grid-cols-2 gap-1.5">
        <Button isDisabled={!known} onPress={() => run(fitImageOps(scene, selection, "proportions"))}>Restore shape</Button>
        <Button isDisabled={!known} onPress={() => run(fitImageOps(scene, selection, "actual"))}>Actual size</Button>
        <Button isDisabled={!known} onPress={() => run(fitImageOps(scene, selection, "print"))}>Print size (300 ppi)</Button>
        <Button onPress={() => { void pickImageFile().then((f) => { if (f) void relinkImage(n.id, f); }); }}>Relink…</Button>
      </div>
    </Box>
  );
}
