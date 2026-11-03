import { useScene } from "@/store/store";
import { currentT } from "@/i18n";
import type { FillLite, NodeLite } from "@/store/types";
import { Button, cls, Section } from "@/ui/ds";
import { CHECKER } from "@/ui/ds/props-controls";
import {
  applyEffectStyleOps, applyPaintStyleOps, createEffectStyleOps, createPaintStyleOps, deleteEffectStyleOps, deletePaintStyleOps,
  paintStyleIdOf, type PaintTarget,
} from "@/ui/styleOps";

// Names the shared controls cannot translate on their own (options, text nodes). See docs/localization.md.
const tr = (key: string, vars?: Record<string, string | number>) => currentT().tx(key, vars);

// SHARED PAINT AND EFFECT STYLES in the properties panel (docs/shapes.md): pick a style from the document's list,
// make a new one from what the node has, detach (the node keeps what was drawn) or delete. A node that uses a
// paint style is drawn with the style's paints, so the panel shows them read-only until it is detached.
// Every choice is ONE gesture = one undo step.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

const MIXED = "__mixed";

function same<T>(values: readonly T[]): T | typeof MIXED {
  return values.every((v) => Object.is(v, values[0])) ? values[0] : MIXED;
}

const css = (c: FillLite) => `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)} / ${c.a})`;

/** The selected nodes, or null when the selection is empty or has a node that is gone. */
function useSelected(): { nodes: NodeLite[]; ids: string[] } | null {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length === 0) return null;
  const nodes = selection.map((id) => scene.nodes.at(id)).filter((n): n is NodeLite => n !== undefined);
  return nodes.length === selection.length ? { nodes, ids: [...selection] } : null;
}

/** True when every selected node draws `target` with a (still existing) shared paint style. */
export function usesPaintStyleFor(scene: { paintStyles: Record<string, unknown> } | null, nodes: readonly NodeLite[], target: PaintTarget): boolean {
  return !!scene && nodes.length > 0 && nodes.every((n) => {
    const id = paintStyleIdOf(n, target);
    return id !== undefined && !!scene.paintStyles[id];
  });
}

/** The style row of the Fill or Stroke section: the picker, New / Delete, and the style's paints when attached. */
export function PaintStyleControls({ target }: { target: PaintTarget }) {
  const scene = useScene((s) => s.scene);
  const sel = useSelected();
  if (!scene || !sel) return null;
  const styles = Object.values(scene.paintStyles).sort((a, b) => a.name.localeCompare(b.name));
  const label = target === "fill" ? tr("Fill style") : tr("Stroke style");
  const current = same(sel.nodes.map((n) => paintStyleIdOf(n, target) ?? ""));
  const single = sel.nodes.length === 1 ? sel.nodes[0] : null;
  const attachedId = current !== MIXED && current !== "" ? current : null;
  const attached = attachedId ? scene.paintStyles[attachedId] : undefined;
  // Nothing to show or choose: no styles yet and nothing to make one from.
  const canMake = single && !attachedId && (target === "fill" ? single.fills.length > 0 : single.strokes.length > 0);
  if (styles.length === 0 && !canMake) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <select
        aria-label={label} className={cls.select} value={current}
        onChange={(e) => run(applyPaintStyleOps(scene, sel.ids, target, e.target.value))}
      >
        {current === MIXED && <option value={MIXED} disabled>{tr("Mixed")}</option>}
        <option value="">{tr("No style")}</option>
        {styles.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      {attached && (
        <div className="flex gap-1" role="img" aria-label={`${attached.name}: ${attached.paints.length} paint${attached.paints.length === 1 ? "" : "s"}`}>
          {attached.paints.map((p, i) => (
            <span key={i} className="relative h-5 min-w-0 flex-1 overflow-hidden rounded shadow-[inset_0_0_0_1px_var(--line-strong)]">
              <span className="absolute inset-0" style={{ background: CHECKER }} />
              <span className="absolute inset-0" style={{ background: css(p) }} />
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {canMake && (
          <Button onPress={() => {
            const made = createPaintStyleOps(single, target, `${target === "fill" ? "Fill" : "Stroke"} ${styles.length + 1}`);
            if (made) run(made.ops);
          }}>New style</Button>
        )}
        {attachedId && (
          <>
            <Button onPress={() => run(applyPaintStyleOps(scene, sel.ids, target, ""))}>Detach</Button>
            <Button variant="danger" onPress={() => run(deletePaintStyleOps(scene, attachedId))}>Delete style</Button>
          </>
        )}
      </div>
    </div>
  );
}

/** The effect-style section: picker, New / Delete, Detach. Renders nothing when there is nothing to pick or make. */
export function EffectStyleControls() {
  const scene = useScene((s) => s.scene);
  const sel = useSelected();
  if (!scene || !sel) return null;
  const styles = Object.values(scene.effectStyles).sort((a, b) => a.name.localeCompare(b.name));
  const current = same(sel.nodes.map((n) => n.effectStyleId ?? ""));
  const single = sel.nodes.length === 1 ? sel.nodes[0] : null;
  const attachedId = current !== MIXED && current !== "" ? current : null;
  const canMake = single && !attachedId && (single.effects?.length ?? 0) > 0;
  if (styles.length === 0 && !canMake) return null;
  return (
    <Section title={tr("Effect style")}>
      <div className="flex flex-col gap-1.5">
        <select
          aria-label={tr("Effect style")} className={cls.select} value={current}
          onChange={(e) => run(applyEffectStyleOps(scene, sel.ids, e.target.value))}
        >
          {current === MIXED && <option value={MIXED} disabled>{tr("Mixed")}</option>}
          <option value="">{tr("No style")}</option>
          {styles.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <div className="flex flex-wrap gap-1.5">
          {canMake && (
            <Button onPress={() => {
              const made = createEffectStyleOps(single, `Effects ${styles.length + 1}`);
              if (made) run(made.ops);
            }}>New style</Button>
          )}
          {attachedId && (
            <>
              <Button onPress={() => run(applyEffectStyleOps(scene, sel.ids, ""))}>Detach</Button>
              <Button variant="danger" onPress={() => run(deleteEffectStyleOps(scene, attachedId))}>Delete style</Button>
            </>
          )}
        </div>
      </div>
    </Section>
  );
}
