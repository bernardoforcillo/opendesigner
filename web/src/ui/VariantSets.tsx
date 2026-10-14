import { Button, IconButton, cls } from "./ds";
import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { ComponentSetLite, SceneState } from "../store/types";
import { membersOf } from "../store/variants";
import { CommitField } from "./fields/CommitField";
import {
  addMemberOps, addPropertyOps, addValueOps, deleteSetOps, firstFreeCombination, freeValues, newSetOps, removeMemberOps, removePropertyOps, removeValueOps,
  renamePropertyOps, renameSetOps, renameValueOps, setMemberValueOps,
} from "./variantOps";

// VARIANT SETS: groups of components that are variants of one another (Size,
// State, ...). Every member has one value per property; an instance of a member
// switches variant from the properties panel. Editing a set's properties
// migrates its members on the server, so every action here is ONE op batch = one
// undo step.

function run(build: (scene: SceneState) => Op[]) {
  const st = useScene.getState();
  if (!st.scene) return;
  const ops = build(st.scene);
  if (ops.length === 0) return;
  st.beginGesture();
  st.endGesture(ops);
}

export function VariantSets() {
  const scene = useScene((s) => s.scene);
  if (!scene) return null;
  const sets = Object.values(scene.componentSets ?? {}).sort((a, b) => (a.name < b.name ? -1 : 1));
  const hasComponents = Object.keys(scene.components).length > 0;
  if (sets.length === 0 && !hasComponents) return null;
  return (
    <section aria-label="Variant sets" className="border-t border-line px-2 pb-2 pt-1">
      <div className="flex h-8 items-center gap-2 px-1">
        <h3 className={cls.sectionTitle}>Variant sets</h3>
        <span className="text-[11px] tabular-nums text-fg-subtle">{sets.length}</span>
        <div className="ml-auto">
          <IconButton icon="plus" label="New variant set" size={24} onPress={() => run(newSetOps)} />
        </div>
      </div>
      {sets.length === 0 ? (
        <p className="px-1 pb-1 text-[12px] leading-snug text-fg-subtle">Group components that are variants of one another, then switch an instance between them.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sets.map((set) => <SetCard key={set.id} set={set} scene={scene} />)}
        </ul>
      )}
    </section>
  );
}

function SetCard({ set, scene }: { set: ComponentSetLite; scene: SceneState }) {
  const members = membersOf(scene, set.id).sort((a, b) => (a.component.name < b.component.name ? -1 : 1));
  const loose = Object.entries(scene.components).filter(([, c]) => !c.setId).sort(([, a], [, b]) => (a.name < b.name ? -1 : 1));
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2">
      <div className="flex items-center gap-1.5">
        <CommitField label={`Name of set ${set.name}`} value={set.name} onCommit={(n) => run(() => renameSetOps(set, n))} />
        <IconButton icon="trash" label={`Delete set ${set.name}`} size={24} onPress={() => run(() => deleteSetOps(set.id))} />
      </div>

      <div className="flex flex-col gap-1.5">
        {set.properties.map((p) => (
          <div key={p.name} className="flex flex-col gap-1 rounded-md bg-surface-2 p-1.5">
            <div className="flex items-center gap-1">
              <CommitField key={`pn:${p.name}`} label={`Property name ${p.name}`} value={p.name} onCommit={(n) => run(() => renamePropertyOps(set, p.name, n))} />
              <IconButton icon="trash" label={`Remove property ${p.name}`} size={22} onPress={() => run(() => removePropertyOps(set, p.name))} />
            </div>
            {p.values.map((v) => (
              <div key={v} className="flex items-center gap-1 pl-3">
                <CommitField key={`pv:${p.name}:${v}`} label={`Value ${v} of ${p.name}`} value={v} onCommit={(n) => run(() => renameValueOps(set, p.name, v, n))} />
                <IconButton icon="minus" label={`Remove value ${v} of ${p.name}`} size={22} isDisabled={p.values.length <= 1} onPress={() => run(() => removeValueOps(set, p.name, v))} />
              </div>
            ))}
            <div className="pl-3">
              <CommitField
                key={`${p.name}:${p.values.length}`}   // remount after an add: the field empties itself
                label={`Add value to ${p.name}`}
                value=""
                placeholder="+ Value"
                onCommit={(v) => run(() => addValueOps(set, p.name, v))}
              />
            </div>
          </div>
        ))}
        <CommitField key={`prop:${set.properties.length}`} label={`Add property to ${set.name}`} value="" placeholder="+ Property" onCommit={(n) => run(() => addPropertyOps(set, n))} />
      </div>

      <ul aria-label={`Members of ${set.name}`} className="flex flex-col gap-1">
        {members.map(({ id, component }) => (
          <li key={id} className="flex flex-col gap-1 rounded-md bg-surface-2 p-1.5">
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{component.name || "Unnamed component"}</span>
              <IconButton icon="minus" label={`Remove ${component.name} from ${set.name}`} size={22} onPress={() => run(() => removeMemberOps(id))} />
            </div>
            {set.properties.map((p) => {
              const free = freeValues(scene, set, id, p.name);
              return (
                <label key={p.name} className="grid grid-cols-[4.5rem_1fr] items-center gap-1.5">
                  <span className="truncate text-[11px] text-fg-subtle">{p.name}</span>
                  <select
                    aria-label={`${component.name} ${p.name}`}
                    className={cls.select}
                    value={component.variant?.[p.name] ?? ""}
                    onChange={(e) => run((s) => setMemberValueOps(s, set, id, p.name, e.target.value))}
                  >
                    {p.values.map((v) => <option key={v} value={v} disabled={!free.has(v) && v !== component.variant?.[p.name]}>{v}</option>)}
                  </select>
                </label>
              );
            })}
          </li>
        ))}
      </ul>

      {loose.length > 0 && set.properties.length > 0 && (
        <select
          aria-label={`Add a component to ${set.name}`}
          className={cls.select}
          value=""
          onChange={(e) => e.target.value && run((s) => addMemberOps(s, set, e.target.value))}
        >
          <option value="">{firstFreeCombination(scene, set) ? "Add component…" : "Add component (new value)…"}</option>
          {loose.map(([id, c]) => <option key={id} value={id}>{c.name || "Unnamed component"}</option>)}
        </select>
      )}
      {set.properties.length === 0 && <Button variant="secondary" onPress={() => run(() => addPropertyOps(set, "Variant"))}>Add a property</Button>}
    </li>
  );
}
