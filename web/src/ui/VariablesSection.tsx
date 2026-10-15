import { useScene } from "../store/store";
import type { NodeLite, SceneState, VariableTypeLite } from "../store/types";
import { cls, Section } from "./ds";
import { MIXED, bindingOps, boundVariable, modeOps, pinnedMode, variablesOfType } from "./variableOps";

// THE VARIABLES SECTION of the properties panel: binds a property of the
// selection to a variable (design token) and pins a collection to a mode.
//
// A bound property takes its value from the variable for the node's active mode;
// the literal stored on the node stays as the fallback (detaching gives it back).
// Every choice is ONE gesture = one op per node = one undo step, like the other
// sections. The pure half (what op each choice builds) is variableOps.ts.

interface Row { key: string; label: string; type: VariableTypeLite; applies: (n: NodeLite) => boolean }

const ROWS: Row[] = [
  { key: "fills.0", label: "Fill", type: "color", applies: (n) => n.fills.length > 0 },
  { key: "strokes.0", label: "Stroke", type: "color", applies: (n) => n.strokes.length > 0 },
  { key: "strokes.0.weight", label: "Stroke width", type: "number", applies: (n) => n.strokes.length > 0 },
  { key: "opacity", label: "Opacity", type: "number", applies: () => true },
  { key: "rotation", label: "Rotation", type: "number", applies: () => true },
  { key: "corner_radius", label: "Radius", type: "number", applies: (n) => n.kind === "rect" },
];

function commit(ops: ReturnType<typeof bindingOps>) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

function Pick({ label, value, onChange, children }: {
  label: string; value: string; onChange: (v: string) => void; children: React.ReactNode;
}) {
  return (
    <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
      <span className={cls.label}>{label}</span>
      <select aria-label={label} className={cls.select} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

export function VariablesSection() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length === 0) return null;
  const ids = selection;
  const nodes = ids.map((id) => scene.nodes.at(id)).filter((n): n is NodeLite => !!n);
  const collections = Object.values(scene.collections ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  const hasVariables = Object.keys(scene.variables ?? {}).length > 0;

  return (
    <Section title="Variables" count={nodes.reduce((n, node) => n + Object.keys(node.bindings ?? {}).length, 0) || undefined}>
      {!hasVariables ? (
        <p className="text-[12px] text-fg-subtle">No variables yet. Create them from the document menu → Variables.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {ROWS.filter((r) => nodes.some(r.applies)).map((r) => (
            <BindRow key={r.key} row={r} scene={scene} ids={ids} />
          ))}
          {collections.filter((c) => c.modes.length > 1).map((c) => {
            const pinned = pinnedMode(scene, ids, c.id);
            return (
              <Pick
                key={c.id}
                label={c.name}
                value={pinned === MIXED ? "__mixed" : (pinned ?? "")}
                onChange={(v) => commit(modeOps(scene, ids, c.id, v === "" ? null : v))}
              >
                {pinned === MIXED && <option value="__mixed" disabled>Mixed</option>}
                <option value="">Inherit ({c.modes[0].name} by default)</option>
                {c.modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Pick>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function BindRow({ row, scene, ids }: { row: Row; scene: SceneState; ids: readonly string[] }) {
  const bound = boundVariable(scene, ids, row.key);
  const options = variablesOfType(scene, row.type);
  // A binding whose variable is gone is cleaned by the server (cascade); this
  // only guards the frame between the op and the echo.
  const value = bound === MIXED ? "__mixed" : (bound !== null && scene.variables[bound] ? bound : "");
  return (
    <Pick label={row.label} value={value} onChange={(v) => commit(bindingOps(scene, ids, row.key, v === "" ? null : v))}>
      {bound === MIXED && <option value="__mixed" disabled>Mixed</option>}
      <option value="">None</option>
      {options.map((v) => (
        <option key={v.id} value={v.id}>{scene.collections[v.collectionId]?.name ?? "?"} / {v.name}</option>
      ))}
    </Pick>
  );
}
