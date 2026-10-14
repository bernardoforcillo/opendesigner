import { IconButton, Section, cls } from "./ds";
import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { ComponentPropertyLite, SceneState } from "../store/types";
import { CommitField } from "./fields/CommitField";
import { addPropertyOps, componentOfMaster, layersOfMaster, removePropertyOps, setInstanceValueOps, updatePropertyOps } from "./propertyOps";

// COMPONENT PROPERTIES in the properties panel. Two sections:
//  - "Component properties", on the selected MASTER root of a component: define
//    boolean (show/hide a layer) and text (set a text layer) controls;
//  - "Properties", on a selected INSTANCE: set them (a switch per boolean, a field per text).
// Every edit is one gesture = one undo step.

function run(build: (scene: SceneState) => Op[]) {
  const st = useScene.getState();
  if (!st.scene) return;
  const ops = build(st.scene);
  if (ops.length === 0) return;
  st.beginGesture();
  st.endGesture(ops);
}

export function ComponentPropertiesSection() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length !== 1) return null;
  const comp = componentOfMaster(scene, selection[0]);
  if (!comp) return null;
  const layers = layersOfMaster(scene, selection[0]);
  return (
    <Section
      title="Properties"
      count={comp.properties.length}
      actions={
        <>
          <IconButton icon="plus" label="Add a show/hide property" size={22} onPress={() => run((s) => addPropertyOps(s, comp.id, "boolean"))} />
          <IconButton icon="text" label="Add a text property" size={22} onPress={() => run((s) => addPropertyOps(s, comp.id, "text"))} />
        </>
      }
    >
      {comp.properties.length === 0 ? (
        <p className="text-[12px] leading-snug text-fg-subtle">Let an instance show or hide a layer, or change a text, without detaching it.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {comp.properties.map((p) => (
            <li key={p.name} className="flex flex-col gap-1 rounded-md bg-surface-2 p-1.5">
              <div className="flex items-center gap-1">
                <CommitField key={`n:${p.name}`} label={`Property name ${p.name}`} value={p.name} onCommit={(n) => run((s) => updatePropertyOps(s, comp.id, p.name, { name: n }))} />
                <IconButton icon="trash" label={`Remove property ${p.name}`} size={22} onPress={() => run((s) => removePropertyOps(s, comp.id, p.name))} />
              </div>
              <label className="grid grid-cols-[3.5rem_1fr] items-center gap-1.5">
                <span className="text-[11px] text-fg-subtle">{p.type === "boolean" ? "Shows" : "Text of"}</span>
                <select
                  aria-label={`Layer of ${p.name}`}
                  className={cls.select}
                  value={p.nodeId}
                  onChange={(e) => run((s) => updatePropertyOps(s, comp.id, p.name, { nodeId: e.target.value }))}
                >
                  {layers.filter((l) => p.type === "boolean" || l.kind === "text").map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
              </label>
              <label className="grid grid-cols-[3.5rem_1fr] items-center gap-1.5">
                <span className="text-[11px] text-fg-subtle">Default</span>
                {p.type === "boolean" ? (
                  <input
                    type="checkbox"
                    aria-label={`Default of ${p.name}`}
                    checked={p.defaultValue !== "false"}
                    onChange={(e) => run((s) => updatePropertyOps(s, comp.id, p.name, { defaultValue: e.target.checked ? "true" : "false" }))}
                    className="size-4 justify-self-start accent-[var(--accent)]"
                  />
                ) : (
                  <CommitField key={`d:${p.name}:${p.defaultValue}`} label={`Default of ${p.name}`} value={p.defaultValue} placeholder="Master's own text" onCommit={(v) => run((s) => updatePropertyOps(s, comp.id, p.name, { defaultValue: v }))} />
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function InstancePropertiesSection() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length !== 1) return null;
  const n = scene.nodes.get(selection[0]);
  const comp = n?.instance ? scene.components[n.instance.componentId] : undefined;
  const props = comp?.properties;
  if (!n || !n.instance || !props || props.length === 0) return null;
  return (
    <Section title="Properties" count={props.length}>
      <div className="flex flex-col gap-1.5">
        {props.map((p) => <InstanceValue key={p.name} instanceId={n.id} p={p} value={n.instance!.propertyValues?.[p.name]} />)}
      </div>
    </Section>
  );
}

function InstanceValue({ instanceId, p, value }: { instanceId: string; p: ComponentPropertyLite; value: string | undefined }) {
  const current = value ?? p.defaultValue;
  return (
    <label className="grid grid-cols-[5rem_1fr] items-center gap-1.5">
      <span className="truncate text-[11px] text-fg-subtle" title={p.name}>{p.name}</span>
      {p.type === "boolean" ? (
        <input
          type="checkbox"
          aria-label={p.name}
          checked={current !== "false"}
          // Back to the default when the switch matches it, so an instance only stores what it changes.
          onChange={(e) => run(() => setInstanceValueOps(instanceId, p.name, String(e.target.checked) === p.defaultValue ? "" : String(e.target.checked)))}
          className="size-4 justify-self-start accent-[var(--accent)]"
        />
      ) : (
        <CommitField key={`${instanceId}:${p.name}:${current}`} label={p.name} value={current} placeholder="Master's own text" onCommit={(v) => run(() => setInstanceValueOps(instanceId, p.name, v === p.defaultValue ? "" : v))} />
      )}
    </label>
  );
}
