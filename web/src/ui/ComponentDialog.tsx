import { useState } from "react";
import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { makeSetComponentSetOp } from "@/tools/ops";
import { Button, cls } from "@/ui/ds";
import {
  NUMBER_ATTRIBUTES, addAxisOps, addOptionOps, addPropertyOps, createSetOps, duplicateVariantOps, leaveSetOps, membersOf, removePropertyOps,
  renameAxisOps, renameOptionOps, selectionInMaster, setPropertyDefaultOps, setPropertyOptionsOps, setVariantOps, swapChoices,
} from "@/ui/componentOps";
import type { ComponentPropertyLite } from "@/store/types";

// THE COMPONENT DIALOG (Components panel → edit): turns a component into one variant of a
// SET (axes such as State or Size, one option per axis for each variant; axes and options
// can be renamed without losing the members' and instances' choices) and defines the
// PROPERTIES an instance can set (a boolean that shows/hides nodes of the master, a text
// that sets the content of its text nodes -- free or from an option list --, a number that
// writes opacity / corner radius / font size, a swap that points a nested instance at
// another component). Instances pick variants and set values in the properties panel
// (InstanceControls). Every action is ONE gesture = one undo step.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

export function ComponentDialog({ componentId, onClose }: { componentId: string | null; onClose: () => void }) {
  const { t } = useT();
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const comp = componentId && scene ? scene.components[componentId] : undefined;
  return (
    <ModalOverlay isDismissable isOpen={!!componentId && !!comp} onOpenChange={(o) => { if (!o) onClose(); }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[640px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Component")} className="flex flex-col gap-4 outline-none">
          {scene && comp && componentId && <Body scene={scene} componentId={componentId} selection={selection} onClose={onClose} />}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function Body({ scene, componentId, selection, onClose }: {
  scene: NonNullable<ReturnType<typeof useScene.getState>["scene"]>; componentId: string; selection: readonly string[]; onClose: () => void;
}) {
  const { t, tn, tx } = useT();
  const comp = scene.components[componentId];
  const set = comp.setId ? scene.componentSets[comp.setId] : undefined;
  const [newAxis, setNewAxis] = useState("");
  const [newAxisOption, setNewAxisOption] = useState("");
  const [newOption, setNewOption] = useState<Record<string, string>>({});
  const [propName, setPropName] = useState("");
  const [propType, setPropType] = useState<ComponentPropertyLite["type"]>("boolean");
  const [propAttribute, setPropAttribute] = useState<string>("opacity");
  const [note, setNote] = useState<string | null>(null);
  const targets = selectionInMaster(scene, componentId, selection);

  return (
    <>
      <h2 className="text-[14px] font-semibold">{comp.name || t("Unnamed component")}</h2>

      <section aria-label={t("Variants")} className="flex flex-col gap-2">
        <h3 className={cls.sectionTitle}>{t("Variants")}</h3>
        {!set ? (
          <div className="flex items-center gap-2">
            <span className="text-fg-subtle">{t("Not part of a set.")}</span>
            <Button icon="plus" onPress={() => { const made = createSetOps(scene, componentId, comp.name || t("Component set")); if (made) run(made.ops); }}>
              {t("Create variant set")}
            </Button>
          </div>
        ) : (
          <>
            <input key={set.id + set.name} aria-label={t("Set name")} className={`${cls.input} max-w-60`} defaultValue={set.name}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== set.name) run([makeSetComponentSetOp({ ...set, name: v })]); }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            {set.axes.map((a) => (
              <div key={a.name} className="flex flex-col gap-1">
              <div className="grid grid-cols-[6rem_1fr_auto] items-center gap-2">
                <input key={a.name} aria-label={t("Rename {name} axis", { name: a.name })} className={cls.input} defaultValue={a.name}
                  onBlur={(e) => {
                    if (e.target.value.trim() === a.name) { e.target.value = a.name; return; }
                    const ops = renameAxisOps(scene, set.id, a.name, e.target.value);
                    setNote(ops.length === 0 ? t("that axis name is empty or already used") : null);
                    if (ops.length > 0) run(ops); else e.target.value = a.name;
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                <select aria-label={t("{name} of this variant", { name: a.name })} className={cls.select} value={comp.variant?.[a.name] ?? ""}
                  onChange={(e) => {
                    const ops = setVariantOps(scene, componentId, a.name, e.target.value);
                    setNote(ops.length === 0 ? t("another variant already has that combination") : null);
                    run(ops);
                  }}>
                  {a.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <span className="flex items-center gap-1">
                  <input aria-label={t("New {name} option", { name: a.name })} className={`${cls.input} w-28`} placeholder={t("New option")} value={newOption[a.name] ?? ""}
                    onChange={(e) => setNewOption({ ...newOption, [a.name]: e.target.value })} />
                  <Button aria-label={t("Add {name} option", { name: a.name })} onPress={() => {
                    const ops = addOptionOps(scene, set.id, a.name, newOption[a.name] ?? "");
                    setNote(ops.length === 0 ? t("the option name is empty") : null);
                    if (ops.length > 0) { run(ops); setNewOption({ ...newOption, [a.name]: "" }); }
                  }}>{t("Add")}</Button>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1 pl-[6.5rem]">
                {a.options.map((o) => (
                  <input key={o} aria-label={t("Rename {name} option {option}", { name: a.name, option: o })} className={`${cls.input} w-24`} defaultValue={o}
                    onBlur={(e) => {
                      if (e.target.value.trim() === o) { e.target.value = o; return; }
                      const ops = renameOptionOps(scene, set.id, a.name, o, e.target.value);
                      setNote(ops.length === 0 ? t("that option name is empty or already used") : null);
                      if (ops.length > 0) run(ops); else e.target.value = o;
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                ))}
              </div>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <input aria-label={t("New axis name")} className={`${cls.input} w-32`} placeholder={t("New axis")} value={newAxis} onChange={(e) => setNewAxis(e.target.value)} />
              <input aria-label={t("First option of the new axis")} className={`${cls.input} w-32`} placeholder={t("First option")} value={newAxisOption} onChange={(e) => setNewAxisOption(e.target.value)} />
              <Button onPress={() => {
                const ops = addAxisOps(scene, set.id, newAxis, newAxisOption);
                setNote(ops.length === 0 ? t("give the axis a name and a first option") : null);
                if (ops.length > 0) { run(ops); setNewAxis(""); setNewAxisOption(""); }
              }}>{t("Add axis")}</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button icon="plus" onPress={() => {
                const made = duplicateVariantOps(scene, componentId, t("{name} copy", { name: comp.name || t("Variant") }));
                setNote(made ? null : t("no free combination left: add an option first"));
                if (made) run(made.ops);
              }}>{t("Add variant (duplicate this one)")}</Button>
              <Button variant="ghost" onPress={() => run(leaveSetOps(scene, componentId))}>{t("Remove from set")}</Button>
            </div>
            <ul aria-label={t("Variants of the set")} className="flex flex-col gap-0.5 text-fg-subtle">
              {membersOf(scene, set.id).map(({ id, c }) => (
                <li key={id}>{c.name || t("Unnamed")}: {Object.entries(c.variant ?? {}).map(([k, v]) => `${k}=${v}`).join(", ")}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-label={t("Properties")} className="flex flex-col gap-2">
        <h3 className={cls.sectionTitle}>{t("Properties")}</h3>
        {(comp.properties ?? []).length === 0 && <span className="text-fg-subtle">{t("No properties yet.")}</span>}
        {(comp.properties ?? []).map((p) => (
          <div key={p.name} className="grid grid-cols-[8rem_5rem_1fr_auto] items-center gap-2">
            <span className="truncate">{p.name}</span>
            <span className="text-fg-subtle">{p.type === "number" ? tx(p.attribute ?? "") : tx(p.type)} · {p.targetNodeIds.length}</span>
            {p.type === "boolean" ? (
              <select aria-label={t("{name} default", { name: p.name })} className={cls.select} value={p.defaultValue}
                onChange={(e) => run(setPropertyDefaultOps(scene, componentId, p.name, e.target.value))}>
                <option value="true">{t("Shown")}</option><option value="false">{t("Hidden")}</option>
              </select>
            ) : p.type === "swap" ? (
              <select aria-label={t("{name} default", { name: p.name })} className={cls.select} value={p.defaultValue}
                onChange={(e) => run(setPropertyDefaultOps(scene, componentId, p.name, e.target.value))}>
                <option value="">{t("Keep the nested component")}</option>
                {swapChoices(scene, componentId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : p.type === "text" && p.options?.length ? (
              <select aria-label={t("{name} default", { name: p.name })} className={cls.select} value={p.defaultValue}
                onChange={(e) => run(setPropertyDefaultOps(scene, componentId, p.name, e.target.value))}>
                {p.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input key={p.name + p.defaultValue} aria-label={t("{name} default", { name: p.name })} className={cls.input} defaultValue={p.defaultValue}
                maxLength={p.type === "number" ? 32 : 200}
                onBlur={(e) => {
                  if (e.target.value === p.defaultValue) return;
                  const ops = setPropertyDefaultOps(scene, componentId, p.name, e.target.value);
                  setNote(ops.length === 0 ? t("not a valid value for {name}", { name: p.name }) : null);
                  if (ops.length > 0) run(ops); else e.target.value = p.defaultValue;
                }}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            )}
            <button type="button" aria-label={t("Remove {name}", { name: p.name })} className="text-fg-subtle hover:text-danger"
              onClick={() => run(removePropertyOps(scene, componentId, p.name))}>×</button>
            {p.type === "text" && (
              <input key={p.name + (p.options ?? []).join("\n")} aria-label={t("{name} options", { name: p.name })} className={`${cls.input} col-span-full`}
                placeholder={t("Allowed values, comma separated (empty = free text)")} defaultValue={(p.options ?? []).join(", ")}
                onBlur={(e) => run(setPropertyOptionsOps(scene, componentId, p.name, e.target.value.split(",")))}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            )}
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input aria-label={t("Property name")} className={`${cls.input} w-36`} placeholder={t("Property name")} value={propName} onChange={(e) => setPropName(e.target.value)} />
          <select aria-label={t("Property type")} className={`${cls.select} w-32`} value={propType} onChange={(e) => setPropType(e.target.value as ComponentPropertyLite["type"])}>
            <option value="boolean">{t("Show / hide")}</option><option value="text">{t("Text")}</option>
            <option value="number">{t("Number")}</option><option value="swap">{t("Instance swap")}</option>
          </select>
          {propType === "number" && (
            <select aria-label={t("Property attribute")} className={`${cls.select} w-36`} value={propAttribute} onChange={(e) => setPropAttribute(e.target.value)}>
              {NUMBER_ATTRIBUTES.map((a) => <option key={a.value} value={a.value}>{tx(a.label)}</option>)}
            </select>
          )}
          <Button onPress={() => {
            const ops = addPropertyOps(scene, componentId, propType, propName, targets, propAttribute);
            setNote(ops.length === 0
              ? t("select, on the canvas, the nodes of this component the property controls (text nodes for a text or font size property, rectangles for a corner radius, nested instances for a swap), and give it a unique name")
              : null);
            if (ops.length > 0) { run(ops); setPropName(""); }
          }}>{t("Add from selection")}</Button>
        </div>
        <span className="text-fg-subtle">{tn("{n} nodes of this component selected.", targets.length)}</span>
      </section>

      {note && <p role="status" className="text-warn">{note}</p>}
      <div className="flex justify-end"><Button variant="primary" onPress={onClose}>{t("Done")}</Button></div>
    </>
  );
}
