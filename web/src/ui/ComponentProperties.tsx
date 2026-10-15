import { IconButton, Section, cls } from "./ds";
import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { ComponentPropertyLite, SceneState } from "../store/types";
import { CommitField } from "./fields/CommitField";
import {
  NUMBER_ATTRIBUTES, addPropertyOps, attributeFits, componentOfMaster, layersFor, layersOfMaster, removePropertyOps, setInstanceValueOps, updatePropertyOps,
} from "./propertyOps";

// COMPONENT PROPERTIES in the properties panel. Two sections:
//  - "Properties" on the selected MASTER root of a component: DEFINE controls. A
//    show/hide switch, a text (free or from an option list), a number (opacity,
//    corner radius or font size of a layer) or a swap (replaces a nested component);
//  - "Properties" on a selected INSTANCE: SET them.
// Every edit is one gesture = one undo step.

function run(build: (scene: SceneState) => Op[]) {
  const st = useScene.getState();
  if (!st.scene) return;
  const ops = build(st.scene);
  if (ops.length === 0) return;
  st.beginGesture();
  st.endGesture(ops);
}

const KIND_LABEL: Record<ComponentPropertyLite["type"], string> = { boolean: "Shows", text: "Text of", number: "Drives", swap: "Replaces" };
const NEW_KINDS: { value: ComponentPropertyLite["type"]; label: string }[] = [
  { value: "boolean", label: "Show / hide a layer" },
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "swap", label: "Swap a nested component" },
];

export function ComponentPropertiesSection() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length !== 1) return null;
  const comp = componentOfMaster(scene, selection[0]);
  if (!comp) return null;
  const layers = layersOfMaster(scene, selection[0]);
  const others = Object.entries(scene.components).filter(([id]) => id !== comp.id).sort(([, a], [, b]) => (a.name < b.name ? -1 : 1));
  return (
    <Section
      title="Properties"
      count={comp.properties.length}
      actions={
        <select
          aria-label="Add a property"
          className="h-6 w-16 appearance-none rounded-md bg-surface-2 px-1.5 text-[12px] text-fg-muted hover:bg-surface-3"
          value=""
          onChange={(e) => e.target.value && run((s) => addPropertyOps(s, comp.id, e.target.value as ComponentPropertyLite["type"]))}
        >
          <option value="">+ Add</option>
          {NEW_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      }
    >
      {comp.properties.length === 0 ? (
        <p className="text-[12px] leading-snug text-fg-subtle">Let an instance show or hide a layer, change a text or a number, or swap a nested component, without detaching it.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {comp.properties.map((p) => (
            <li key={p.name} className="flex flex-col gap-1 rounded-md bg-surface-2 p-1.5">
              <div className="flex items-center gap-1">
                <CommitField key={`n:${p.name}`} label={`Property name ${p.name}`} value={p.name} onCommit={(n) => run((s) => updatePropertyOps(s, comp.id, p.name, { name: n }))} />
                <IconButton icon="trash" label={`Remove property ${p.name}`} size={22} onPress={() => run((s) => removePropertyOps(s, comp.id, p.name))} />
              </div>

              {p.type === "number" && (
                <label className="grid grid-cols-[3.5rem_1fr] items-center gap-1.5">
                  <span className="text-[11px] text-fg-subtle">Attribute</span>
                  <select
                    aria-label={`Attribute of ${p.name}`}
                    className={cls.select}
                    value={p.attribute ?? "opacity"}
                    onChange={(e) => {
                      // Move to a layer that fits if the current one does not.
                      const attribute = e.target.value;
                      const cur = layers.find((l) => l.id === p.nodeId);
                      const nodeId = cur && attributeFits(attribute, cur.kind) ? p.nodeId : (layersFor(layers, "number", attribute)[0]?.id ?? p.nodeId);
                      run((s) => updatePropertyOps(s, comp.id, p.name, { attribute, nodeId }));
                    }}
                  >
                    {NUMBER_ATTRIBUTES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                </label>
              )}

              <label className="grid grid-cols-[3.5rem_1fr] items-center gap-1.5">
                <span className="text-[11px] text-fg-subtle">{KIND_LABEL[p.type]}</span>
                <select
                  aria-label={`Layer of ${p.name}`}
                  className={cls.select}
                  value={p.nodeId}
                  onChange={(e) => run((s) => updatePropertyOps(s, comp.id, p.name, { nodeId: e.target.value }))}
                >
                  {layersFor(layers, p.type, p.attribute).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
              </label>

              {p.type === "text" && (
                <label className="grid grid-cols-[3.5rem_1fr] items-center gap-1.5">
                  <span className="text-[11px] text-fg-subtle">Options</span>
                  <CommitField
                    key={`o:${p.name}:${(p.options ?? []).join("|")}`}
                    label={`Options of ${p.name}`}
                    value={(p.options ?? []).join(", ")}
                    placeholder="Free text. Or: Info, Warn"
                    onCommit={(v) => run((s) => updatePropertyOps(s, comp.id, p.name, optionPatch(p, v)))}
                  />
                </label>
              )}

              <label className="grid grid-cols-[3.5rem_1fr] items-center gap-1.5">
                <span className="text-[11px] text-fg-subtle">Default</span>
                <DefaultControl p={p} others={others} onChange={(defaultValue) => run((s) => updatePropertyOps(s, comp.id, p.name, { defaultValue }))} />
              </label>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Splits "Info, Warn" into an option list; a default that is no longer an option falls back to the first. */
function optionPatch(p: ComponentPropertyLite, raw: string): Partial<ComponentPropertyLite> {
  const options = [...new Set(raw.split(",").map((o) => o.trim()).filter((o) => o !== ""))];
  const defaultValue = options.length === 0 || options.includes(p.defaultValue) ? p.defaultValue : options[0];
  return { options, defaultValue };
}

function DefaultControl({ p, others, onChange }: {
  p: ComponentPropertyLite; others: [string, { name: string }][]; onChange: (v: string) => void;
}) {
  if (p.type === "boolean") {
    return (
      <input
        type="checkbox" aria-label={`Default of ${p.name}`} checked={p.defaultValue !== "false"}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
        className="size-4 justify-self-start accent-[var(--accent)]"
      />
    );
  }
  if (p.type === "swap") {
    return (
      <select aria-label={`Default of ${p.name}`} className={cls.select} value={p.defaultValue} onChange={(e) => onChange(e.target.value)}>
        <option value="">The layer's own component</option>
        {others.map(([id, c]) => <option key={id} value={id}>{c.name || "Unnamed component"}</option>)}
      </select>
    );
  }
  if (p.type === "text" && p.options?.length) {
    return (
      <select aria-label={`Default of ${p.name}`} className={cls.select} value={p.defaultValue} onChange={(e) => onChange(e.target.value)}>
        {p.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <CommitField
      key={`d:${p.name}:${p.defaultValue}`} label={`Default of ${p.name}`} value={p.defaultValue}
      placeholder={p.type === "number" ? "The layer's own value" : "Master's own text"}
      onCommit={(v) => onChange(p.type === "number" && v.trim() !== "" && !Number.isFinite(Number(v)) ? p.defaultValue : v.trim())}
    />
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
  const others = Object.entries(scene.components).filter(([id]) => id !== n.instance!.componentId).sort(([, a], [, b]) => (a.name < b.name ? -1 : 1));
  return (
    <Section title="Properties" count={props.length}>
      <div className="flex flex-col gap-1.5">
        {props.map((p) => <InstanceValue key={p.name} instanceId={n.id} p={p} value={n.instance!.propertyValues?.[p.name]} others={others} />)}
      </div>
    </Section>
  );
}

function InstanceValue({ instanceId, p, value, others }: {
  instanceId: string; p: ComponentPropertyLite; value: string | undefined; others: [string, { name: string }][];
}) {
  const current = value ?? p.defaultValue;
  // The stored value is only what differs from the default.
  const set = (v: string) => run(() => setInstanceValueOps(instanceId, p.name, v === p.defaultValue ? "" : v));
  return (
    <label className="grid grid-cols-[5rem_1fr] items-center gap-1.5">
      <span className="truncate text-[11px] text-fg-subtle" title={p.name}>{p.name}</span>
      {p.type === "boolean" ? (
        <input
          type="checkbox" aria-label={p.name} checked={current !== "false"}
          onChange={(e) => set(String(e.target.checked))}
          className="size-4 justify-self-start accent-[var(--accent)]"
        />
      ) : p.type === "swap" ? (
        <select aria-label={p.name} className={cls.select} value={current} onChange={(e) => set(e.target.value)}>
          <option value="">Default</option>
          {others.map(([id, c]) => <option key={id} value={id}>{c.name || "Unnamed component"}</option>)}
        </select>
      ) : p.type === "text" && p.options?.length ? (
        <select aria-label={p.name} className={cls.select} value={current} onChange={(e) => set(e.target.value)}>
          {p.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <CommitField
          key={`${instanceId}:${p.name}:${current}`} label={p.name} value={current}
          placeholder={p.type === "number" ? "The layer's own value" : "Master's own text"}
          onCommit={(v) => (p.type === "number" && v.trim() !== "" && !Number.isFinite(Number(v)) ? undefined : set(v.trim()))}
        />
      )}
    </label>
  );
}
