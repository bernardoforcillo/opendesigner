import type { ReactNode } from "react";
import { useScene } from "@/store/store";
import { effectiveComponentId } from "@/store/components";
import { cls, Section } from "@/ui/ds";
import { chooseVariantOps, chosenOption, setPropertyValueOps, swapChoices } from "@/ui/componentOps";
import { propertyValue } from "@/store/components";

// THE VARIANT AND PROPERTY CONTROLS of a selected component INSTANCE: one select per
// axis of the component's set (switching variant swaps the master the instance shows)
// and one control per property of the component it resolves to -- a checkbox for a
// boolean (shows/hides nodes of the master), a text field (or a select, with an option
// list) for a text, a number field for a number and a component select for a swap. Every choice is
// ONE gesture = one `setInstanceProps` = one undo step.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

export function InstanceControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length !== 1) return null;
  const n = scene.nodes.at(selection[0]);
  if (!n || n.kind !== "instance" || !n.instance) return null;
  const base = scene.components[n.instance.componentId];
  const set = base?.setId ? scene.componentSets[base.setId] : undefined;
  const comp = scene.components[effectiveComponentId(scene, n.instance)];
  const props = comp?.properties ?? [];
  if (!set && props.length === 0) return null;

  return (
    <Section title="Component">
      <div className="flex flex-col gap-1.5">
        {set?.axes.map((a) => (
          <label key={a.name} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
            <span className={cls.label}>{a.name}</span>
            <select aria-label={a.name} className={cls.select} value={chosenOption(scene, n, a.name) ?? ""}
              onChange={(e) => run(chooseVariantOps(scene, n.id, a.name, e.target.value))}>
              {a.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        ))}
        {props.map((p) => {
          const value = propertyValue(scene, n.instance!, p);
          const row = (control: ReactNode) => (
            <div key={p.name} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
              <span className={cls.label}>{p.name}</span>
              {control}
            </div>
          );
          if (p.type === "boolean") {
            return row(<input type="checkbox" aria-label={p.name} checked={value === "true"}
              onChange={(e) => run(setPropertyValueOps(scene, n.id, p.name, e.target.checked ? "true" : "false"))} />);
          }
          if (p.type === "swap") {
            // "" = the nested instance keeps its own component.
            return row(<select aria-label={p.name} className={cls.select} value={value}
              onChange={(e) => run(setPropertyValueOps(scene, n.id, p.name, e.target.value))}>
              <option value="">Default</option>
              {swapChoices(scene, effectiveComponentId(scene, n.instance!)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>);
          }
          if (p.type === "text" && p.options?.length) {
            return row(<select aria-label={p.name} className={cls.select} value={value}
              onChange={(e) => run(setPropertyValueOps(scene, n.id, p.name, e.target.value))}>
              {p.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>);
          }
          // number: an invalid entry (outside the attribute's range) is dropped and the field goes back.
          return row(<input key={p.name + value} aria-label={p.name} className={cls.input} defaultValue={value}
            maxLength={p.type === "number" ? 32 : 200} inputMode={p.type === "number" ? "decimal" : undefined}
            onBlur={(e) => {
              if (e.target.value === value) return;
              const ops = setPropertyValueOps(scene, n.id, p.name, e.target.value);
              if (ops.length === 0) e.target.value = value; else run(ops);
            }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />);
        })}
      </div>
    </Section>
  );
}
