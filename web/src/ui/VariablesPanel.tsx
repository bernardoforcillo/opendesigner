import { Button, EmptyState, IconButton, cls } from "./ds";
import { useScene } from "../store/store";
import { activeModeId } from "../store/variables";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { SceneState, VariableKind, VariableLite } from "../store/types";
import { ColorField, type RgbLite } from "./fields/ColorField";
import { CommitField } from "./fields/CommitField";
import { NumberField } from "./fields/NumberField";
import {
  KIND_LABEL, addModeOps, aliasCandidates, deleteVariableOps, effectiveModes, newVariableOps, removeModeOps, renameModeOps, renameVariableOps,
  setAliasOps, setVariableColorOps, setVariableNumberOps, setVariableStringOps,
} from "./variableOps";

// VARIABLES PANEL: the document's colour tokens and their modes.
//
// A variable has one colour per mode (Light, Dark, ...). Fills and strokes bind
// to a variable from the properties panel and then follow it: change the colour
// here once and everything bound restyles. The mode switcher at the top
// PREVIEWS a mode on the canvas; it is view state, like the camera, not an op
// and not an undo step. The first mode is the default (what the export puts in
// :root); a variable with no value for a mode shows the default's.
//
// Every edit is ONE gesture = one op batch = one undo step, like the other panels.

function run(build: (scene: SceneState) => Op[]) {
  const st = useScene.getState();
  if (!st.scene) return;
  const ops = build(st.scene);
  if (ops.length === 0) return;
  st.beginGesture();
  st.endGesture(ops);
}

/** How many paints, gradient stops and properties are bound to each variable. */
function usage(scene: SceneState): Map<string, number> {
  const uses = new Map<string, number>();
  scene.nodes.forEach((n) => {
    const bump = (id: string | undefined) => { if (id) uses.set(id, (uses.get(id) ?? 0) + 1); };
    for (const f of n.fills) { bump(f.varId); f.gradient?.stops.forEach((st) => bump(st.varId)); }
    for (const s of n.strokes) { bump(s.color.varId); s.color.gradient?.stops.forEach((st) => bump(st.varId)); }
    for (const id of Object.values(n.bindings ?? {})) bump(id);
  });
  return uses;
}

export function VariablesPanel() {
  const scene = useScene((s) => s.scene);
  if (!scene) return null;
  const modes = effectiveModes(scene);
  const active = activeModeId(scene) ?? modes[0].id;
  const variables = Object.values(scene.variables ?? {}).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const uses = usage(scene);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-3 py-2">
        <div className="flex items-center justify-between">
          <h3 className={cls.sectionTitle}>Modes</h3>
          <div className="flex items-center gap-0.5">
            <IconButton icon="plus" label="Add mode" onPress={() => run(addModeOps)} />
            <IconButton
              icon="minus" label="Remove current mode"
              isDisabled={modes.length <= 1}
              onPress={() => run((s) => removeModeOps(s, active))}
            />
          </div>
        </div>
        <div role="radiogroup" aria-label="Previewed mode" className="flex flex-wrap gap-1">
          {modes.map((m, i) => (
            <button
              key={m.id}
              type="button"
              // One mode previewed at a time: a radio in semantics. A native
              // button because react-aria's Button does not forward `role`.
              role="radio"
              aria-checked={m.id === active}
              {...(i === 0 && modes.length > 1 ? { "aria-description": "Default mode" } : {})}
              onClick={() => useScene.getState().setActiveMode(m.id)}
              className={
                "h-7 rounded-md px-2.5 text-[13px] font-medium outline-none focus-visible:shadow-[var(--ring)] " +
                (m.id === active ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg-muted hover:bg-surface-3")
              }
            >
              {m.name}
            </button>
          ))}
        </div>
        <CommitField
          label="Mode name"
          value={modes.find((m) => m.id === active)?.name ?? ""}
          onCommit={(name) => run((s) => renameModeOps(s, active, name))}
        />
        {modes.length > 1 && <p className="text-[11px] leading-snug text-fg-subtle">The first mode is the default: it is what exported code uses unless a mode is switched on.</p>}
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 px-3 py-2">
        <h3 className={cls.sectionTitle}>Variables <span className="tabular-nums">{variables.length}</span></h3>
        {/* Three equal buttons on their own row: the panel is 256px wide. */}
        <div role="group" aria-label="New variable" className="grid grid-cols-3 gap-1">
          {(["color", "number", "string"] as const).map((k) => (
            <Button key={k} variant="secondary" icon="plus" className="min-w-0 px-1.5" aria-label={`New ${KIND_LABEL[k].toLowerCase()} variable`} onPress={() => run((s) => newVariableOps(s, k))}>
              {KIND_LABEL[k]}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {variables.length === 0 ? (
          <EmptyState
            icon="palette"
            title="No variables yet"
            hint="A variable is a named colour, number or text with a value per mode. Bind fills, opacity or text to it and change it in one place."
          />
        ) : (
          <ul className="flex flex-col">
            {variables.map((v) => (
              <VariableRow key={v.id} v={v} modes={modes} active={active} used={uses.get(v.id) ?? 0} scene={scene} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const KIND_ICON_LABEL: Record<VariableKind, string> = { color: "colour", number: "number", string: "text" };

function VariableRow({ v, modes, active, used, scene }: {
  v: VariableLite; modes: readonly { id: string; name: string }[]; active: string; used: number; scene: SceneState;
}) {
  const def = modes[0].id;
  const candidates = aliasCandidates(scene, v);
  // The target may be one that is not a candidate any more (it would now loop): still show it.
  const target = v.aliasOf ? scene.variables?.[v.aliasOf] : undefined;
  return (
    <li className="flex flex-col gap-1.5 border-t border-line px-3 py-2 first:border-t-0">
      <div className="flex items-center gap-1.5">
        <CommitField label={`Name of ${v.name}`} value={v.name} onCommit={(name) => run(() => renameVariableOps(v, name))} />
        <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle" title={v.kind === "color" ? "Fills, strokes and gradient stops bound to it" : "Properties bound to it"}>{used}</span>
        <IconButton icon="trash" label={`Delete ${v.name}`} onPress={() => run(() => deleteVariableOps(v.id))} />
      </div>
      {(candidates.length > 0 || v.aliasOf) && (
        <select
          aria-label={`Value of ${v.name}`}
          className={cls.select}
          value={v.aliasOf ?? "__own__"}
          onChange={(e) => run((s) => setAliasOps(s, v, e.target.value === "__own__" ? null : e.target.value))}
        >
          <option value="__own__">Own {KIND_ICON_LABEL[v.kind]} value</option>
          {v.aliasOf && !target && <option value={v.aliasOf}>Missing variable</option>}
          {target && !candidates.some((c) => c.id === target.id) && <option value={target.id}>Alias of {target.name}</option>}
          {candidates.map((c) => <option key={c.id} value={c.id}>Alias of {c.name}</option>)}
        </select>
      )}
      {!v.aliasOf && (
        <div className="flex flex-col gap-1">
          {modes.map((m) => (
            <div key={m.id} className="grid grid-cols-[4.5rem_1fr] items-center gap-1.5">
              <span className={`truncate text-[11px] ${m.id === active ? "font-semibold text-fg" : "text-fg-subtle"}`}>{m.name}</span>
              <ValueField v={v} mode={m.id} def={def} name={m.name} />
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

// One mode's value field, by kind. A mode with no value of its own shows the
// default mode's, as the canvas does.
function ValueField({ v, mode, def, name }: { v: VariableLite; mode: string; def: string; name: string }) {
  const label = `${v.name} in ${name}`;
  if (v.kind === "number") {
    const n = v.numbers?.[mode] ?? v.numbers?.[def];
    return <NumberField label={label} glyph="#" value={n ?? NaN} placeholder="No value" onCommit={(x) => run(() => setVariableNumberOps(v, mode, x))} />;
  }
  if (v.kind === "string") {
    return <CommitField label={label} value={v.strings?.[mode] ?? v.strings?.[def] ?? ""} placeholder="No value" onCommit={(t) => run(() => setVariableStringOps(v, mode, t))} />;
  }
  const shown = v.values[mode] ?? v.values[def] ?? null;
  return (
    <ColorField
      label={label}
      value={shown ? { r: shown.r, g: shown.g, b: shown.b } : null}
      placeholder="No value"
      onCommit={(rgb: RgbLite) => run(() => setVariableColorOps(v, mode, rgb))}
    />
  );
}
