import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "../store/store";
import { makeSetComponentSetOp } from "../tools/ops";
import { Button, cls } from "./ds";
import {
  addAxisOps, addOptionOps, addPropertyOps, createSetOps, duplicateVariantOps, leaveSetOps, membersOf, removePropertyOps,
  selectionInMaster, setPropertyDefaultOps, setVariantOps,
} from "./componentOps";

// THE COMPONENT DIALOG (Components panel → edit): turns a component into one variant of a
// SET (axes such as State or Size, one option per axis for each variant) and defines the
// PROPERTIES an instance can set (a boolean that shows/hides nodes of the master, a text
// that sets the content of its text nodes). Instances pick variants and set values in the
// properties panel (InstanceControls). Every action is ONE gesture = one undo step.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

export function ComponentDialog({ componentId, onClose }: { componentId: string | null; onClose: () => void }) {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const comp = componentId && scene ? scene.components[componentId] : undefined;
  return (
    <ModalOverlay isDismissable isOpen={!!componentId && !!comp} onOpenChange={(o) => { if (!o) onClose(); }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[640px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Component" className="flex flex-col gap-4 outline-none">
          {scene && comp && componentId && <Body scene={scene} componentId={componentId} selection={selection} onClose={onClose} />}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function Body({ scene, componentId, selection, onClose }: {
  scene: NonNullable<ReturnType<typeof useScene.getState>["scene"]>; componentId: string; selection: readonly string[]; onClose: () => void;
}) {
  const comp = scene.components[componentId];
  const set = comp.setId ? scene.componentSets[comp.setId] : undefined;
  const [newAxis, setNewAxis] = useState("");
  const [newAxisOption, setNewAxisOption] = useState("");
  const [newOption, setNewOption] = useState<Record<string, string>>({});
  const [propName, setPropName] = useState("");
  const [propType, setPropType] = useState<"boolean" | "text">("boolean");
  const [note, setNote] = useState<string | null>(null);
  const targets = selectionInMaster(scene, componentId, selection);

  return (
    <>
      <h2 className="text-[14px] font-semibold">{comp.name || "Unnamed component"}</h2>

      <section aria-label="Variants" className="flex flex-col gap-2">
        <h3 className={cls.sectionTitle}>Variants</h3>
        {!set ? (
          <div className="flex items-center gap-2">
            <span className="text-fg-subtle">Not part of a set.</span>
            <Button icon="plus" onPress={() => { const made = createSetOps(scene, componentId, comp.name || "Component set"); if (made) run(made.ops); }}>
              Create variant set
            </Button>
          </div>
        ) : (
          <>
            <input key={set.id + set.name} aria-label="Set name" className={`${cls.input} max-w-60`} defaultValue={set.name}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== set.name) run([makeSetComponentSetOp({ ...set, name: v })]); }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            {set.axes.map((a) => (
              <div key={a.name} className="grid grid-cols-[6rem_1fr_auto] items-center gap-2">
                <span className={cls.label}>{a.name}</span>
                <select aria-label={`${a.name} of this variant`} className={cls.select} value={comp.variant?.[a.name] ?? ""}
                  onChange={(e) => {
                    const ops = setVariantOps(scene, componentId, a.name, e.target.value);
                    setNote(ops.length === 0 ? "another variant already has that combination" : null);
                    run(ops);
                  }}>
                  {a.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <span className="flex items-center gap-1">
                  <input aria-label={`New ${a.name} option`} className={`${cls.input} w-28`} placeholder="New option" value={newOption[a.name] ?? ""}
                    onChange={(e) => setNewOption({ ...newOption, [a.name]: e.target.value })} />
                  <Button aria-label={`Add ${a.name} option`} onPress={() => {
                    const ops = addOptionOps(scene, set.id, a.name, newOption[a.name] ?? "");
                    setNote(ops.length === 0 ? "the option name is empty" : null);
                    if (ops.length > 0) { run(ops); setNewOption({ ...newOption, [a.name]: "" }); }
                  }}>Add</Button>
                </span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <input aria-label="New axis name" className={`${cls.input} w-32`} placeholder="New axis" value={newAxis} onChange={(e) => setNewAxis(e.target.value)} />
              <input aria-label="First option of the new axis" className={`${cls.input} w-32`} placeholder="First option" value={newAxisOption} onChange={(e) => setNewAxisOption(e.target.value)} />
              <Button onPress={() => {
                const ops = addAxisOps(scene, set.id, newAxis, newAxisOption);
                setNote(ops.length === 0 ? "give the axis a name and a first option" : null);
                if (ops.length > 0) { run(ops); setNewAxis(""); setNewAxisOption(""); }
              }}>Add axis</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button icon="plus" onPress={() => {
                const made = duplicateVariantOps(scene, componentId, `${comp.name || "Variant"} copy`);
                setNote(made ? null : "no free combination left: add an option first");
                if (made) run(made.ops);
              }}>Add variant (duplicate this one)</Button>
              <Button variant="ghost" onPress={() => run(leaveSetOps(scene, componentId))}>Remove from set</Button>
            </div>
            <ul aria-label="Variants of the set" className="flex flex-col gap-0.5 text-fg-subtle">
              {membersOf(scene, set.id).map(({ id, c }) => (
                <li key={id}>{c.name || "Unnamed"}: {Object.entries(c.variant ?? {}).map(([k, v]) => `${k}=${v}`).join(", ")}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-label="Properties" className="flex flex-col gap-2">
        <h3 className={cls.sectionTitle}>Properties</h3>
        {(comp.properties ?? []).length === 0 && <span className="text-fg-subtle">No properties yet.</span>}
        {(comp.properties ?? []).map((p) => (
          <div key={p.name} className="grid grid-cols-[8rem_5rem_1fr_auto] items-center gap-2">
            <span className="truncate">{p.name}</span>
            <span className="text-fg-subtle">{p.type} · {p.targetNodeIds.length}</span>
            {p.type === "boolean" ? (
              <select aria-label={`${p.name} default`} className={cls.select} value={p.defaultValue}
                onChange={(e) => run(setPropertyDefaultOps(scene, componentId, p.name, e.target.value))}>
                <option value="true">Shown</option><option value="false">Hidden</option>
              </select>
            ) : (
              <input key={p.name + p.defaultValue} aria-label={`${p.name} default`} className={cls.input} defaultValue={p.defaultValue} maxLength={200}
                onBlur={(e) => { if (e.target.value !== p.defaultValue) run(setPropertyDefaultOps(scene, componentId, p.name, e.target.value)); }}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            )}
            <button type="button" aria-label={`Remove ${p.name}`} className="text-fg-subtle hover:text-danger"
              onClick={() => run(removePropertyOps(scene, componentId, p.name))}>×</button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input aria-label="Property name" className={`${cls.input} w-36`} placeholder="Property name" value={propName} onChange={(e) => setPropName(e.target.value)} />
          <select aria-label="Property type" className={`${cls.select} w-32`} value={propType} onChange={(e) => setPropType(e.target.value as "boolean" | "text")}>
            <option value="boolean">Show / hide</option><option value="text">Text</option>
          </select>
          <Button onPress={() => {
            const ops = addPropertyOps(scene, componentId, propType, propName, targets);
            setNote(ops.length === 0
              ? "select, on the canvas, the nodes of this component the property controls (text nodes for a text property), and give it a unique name"
              : null);
            if (ops.length > 0) { run(ops); setPropName(""); }
          }}>Add from selection</Button>
        </div>
        <span className="text-fg-subtle">{targets.length} node{targets.length === 1 ? "" : "s"} of this component selected.</span>
      </section>

      {note && <p role="status" className="text-warn">{note}</p>}
      <div className="flex justify-end"><Button variant="primary" onPress={onClose}>Done</Button></div>
    </>
  );
}
