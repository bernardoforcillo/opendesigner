import { useRef, useState } from "react";
import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import type { CollectionLite, FillLite, VariableLite, VariableTypeLite } from "@/store/types";
import { makeDeleteCollectionOp, makeDeleteVariableOp, makeSetCollectionOp, makeSetVariableOp } from "@/tools/ops";
import { downloadBlob } from "@/export/exportScene";
import { colorToHex, fromDtcg, toCssVariables, toDtcg } from "@/tokens/tokens";
import { Button, cls, EmptyState } from "@/ui/ds";
import { ColorField } from "@/ui/fields/ColorField";
import { NumberField } from "@/ui/fields/NumberField";
import { aliasCandidates, newCollection, newVariable, removeModeOps, setVariableOps, withAlias, withMode, withoutAlias, withValue } from "@/ui/variableOps";
import { variableValueIn } from "@/store/variables";

// THE VARIABLES DIALOG (document menu → Variables): create and edit collections,
// their modes and the variables with one value per mode. Binding a property to a
// variable happens in the properties panel (VariablesSection).
//
// Each confirmed edit is ONE gesture = one undo step. The what-op-does-an-edit-
// build logic is variableOps.ts; here there is only layout and wiring.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

export function VariablesDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useT();
  const scene = useScene((s) => s.scene);
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Nothing is read while the dialog is closed: the document menu mounts it
  // permanently, and it must cost (and risk) nothing until it is opened.
  const collections = isOpen && scene ? Object.values(scene.collections ?? {}).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const col = collections.find((c) => c.id === picked) ?? collections[0];
  const vars = scene && col ? Object.values(scene.variables ?? {}).filter((v) => v.collectionId === col.id).sort((a, b) => a.name.localeCompare(b.name)) : [];

  const addCollection = () => {
    if (!scene) return;
    const c = newCollection(scene);
    run([makeSetCollectionOp(c)]);
    setPicked(c.id);
  };

  // Tokens in and out (tokens/tokens.ts): a DTCG JSON file and CSS custom properties.
  const exportAs = (kind: "json" | "css") => {
    if (!scene) return;
    const text = kind === "json" ? toDtcg(scene) : toCssVariables(scene);
    const base = scene.name.trim() || "tokens";
    downloadBlob(new Blob([text], { type: kind === "json" ? "application/json" : "text/css" }), `${base}.tokens.${kind}`);
  };
  const tr = t;
  const importFile = async (file: File | undefined) => {
    const cur = useScene.getState().scene;
    if (!file || !cur) return;
    try {
      const t = fromDtcg(await file.text(), cur);
      if (t.collections.length === 0) { setNotice(t.skipped.length ? `nothing to import (${t.skipped.length} unreadable)` : tr("no tokens found in that file")); return; }
      run([...t.collections.map(makeSetCollectionOp), ...t.variables.map(makeSetVariableOp)]);
      setPicked(t.collections[0].id);
      setNotice(`imported ${t.variables.length} variable${t.variables.length === 1 ? "" : "s"} in ${t.collections.length} collection${t.collections.length === 1 ? "" : "s"}` + (t.skipped.length ? `; skipped ${t.skipped.length}` : ""));
    } catch (e) {
      setNotice(e instanceof Error ? `could not import: ${e.message}` : tr("could not import that file"));
    }
  };

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[720px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Variables")} className="flex flex-col gap-3 outline-none">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold">{t("Variables")}</h2>
            <div className="ml-auto flex items-center gap-2">
              {collections.length > 0 && (
                <select aria-label={t("Collection")} className={`${cls.select} w-44`} value={col?.id ?? ""} onChange={(e) => setPicked(e.target.value)}>
                  {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
              <Button icon="plus" onPress={addCollection}>{t("New collection")}</Button>
            </div>
          </div>

          {!col ? (
            <EmptyState
              icon="plus"
              title={t("No variables yet")}
              hint={t("A collection groups variables that share the same modes, like Light and Dark.")}
              action={<Button variant="primary" onPress={addCollection}>{t("New collection")}</Button>}
            />
          ) : (
            <CollectionEditor col={col} vars={vars} onDeleted={() => setPicked(null)} />
          )}

          {notice && <p role="status" className="text-fg-subtle">{notice}</p>}
          <div className="flex items-center gap-2 border-t border-line pt-3">
            <input ref={fileInput} type="file" accept=".json,application/json" aria-label={t("Tokens file")} className="hidden"
              onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
            <Button onPress={() => fileInput.current?.click()}>{t("Import tokens…")}</Button>
            <Button isDisabled={collections.length === 0} onPress={() => exportAs("json")}>{t("Export JSON")}</Button>
            <Button isDisabled={collections.length === 0} onPress={() => exportAs("css")}>{t("Export CSS")}</Button>
            <Button variant="primary" className="ml-auto" onPress={() => onOpenChange(false)}>{t("Done")}</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function CollectionEditor({ col, vars, onDeleted }: { col: CollectionLite; vars: VariableLite[]; onDeleted: () => void }) {
  const { t } = useT();
  const rename = (name: string) => { if (name.trim() !== "" && name !== col.name) run([makeSetCollectionOp({ ...col, name: name.trim() })]); };
  const renameMode = (id: string, name: string) => {
    if (name.trim() === "" || col.modes.find((m) => m.id === id)?.name === name) return;
    run([makeSetCollectionOp({ ...col, modes: col.modes.map((m) => (m.id === id ? { ...m, name: name.trim() } : m)) })]);
  };
  const addVariable = (type: VariableTypeLite) => run(setVariableOps(newVariable(col, type, `${type}/${vars.length + 1}`)));
  const cols = `minmax(9rem,1.2fr) repeat(${col.modes.length}, minmax(7rem,1fr)) minmax(7rem,1fr) 1.75rem`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input key={col.id + col.name} aria-label={t("Collection name")} className={`${cls.input} max-w-60`} defaultValue={col.name}
          onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        <Button icon="plus" onPress={() => run([makeSetCollectionOp(withMode(col))])}>{t("Add mode")}</Button>
        <Button variant="danger" className="ml-auto" onPress={() => { run([makeDeleteCollectionOp(col.id)]); onDeleted(); }}>
          {t("Delete collection")}
        </Button>
      </div>

      <div role="table" aria-label={t("Variables")} className="grid gap-x-2 gap-y-1" style={{ gridTemplateColumns: cols }}>
        <div role="row" className="contents">
          <span role="columnheader" className={cls.label}>{t("Name")}</span>
          {col.modes.map((m) => (
            <span role="columnheader" key={m.id} className="flex items-center gap-1">
              <input key={m.id + m.name} aria-label={t("Mode name {name}", { name: m.name })} className={`${cls.input} h-6 text-[12px] font-medium`} defaultValue={m.name}
                onBlur={(e) => renameMode(m.id, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
              {col.modes.length > 1 && (
                <button type="button" aria-label={t("Remove mode {name}", { name: m.name })} className="text-fg-subtle hover:text-danger"
                  onClick={() => run(removeModeOps(col, m.id))}>×</button>
              )}
            </span>
          ))}
          <span role="columnheader" className={cls.label}>{t("Alias of")}</span>
          <span />
        </div>
        {vars.map((v) => <VariableRow key={v.id} v={v} col={col} />)}
      </div>

      <div className="flex gap-2">
        <Button icon="plus" onPress={() => addVariable("color")}>{t("Color")}</Button>
        <Button icon="plus" onPress={() => addVariable("number")}>{t("Number")}</Button>
        <Button icon="plus" onPress={() => addVariable("string")}>{t("String")}</Button>
        <Button icon="plus" onPress={() => addVariable("boolean")}>{t("Boolean")}</Button>
      </div>
    </div>
  );
}

function VariableRow({ v, col }: { v: VariableLite; col: CollectionLite }) {
  const { t } = useT();
  const scene = useScene((s) => s.scene);
  const rename = (name: string) => { if (name.trim() !== "" && name !== v.name) run(setVariableOps({ ...v, name: name.trim() })); };
  const targets = scene ? aliasCandidates(scene, v) : [];
  const setAlias = (id: string) => {
    if (!scene) return;
    run(setVariableOps(id === "" ? withoutAlias(scene, col, v) : withAlias(v, id)));
  };
  return (
    <div role="row" className="contents">
      <input key={v.id + v.name} aria-label={t("Variable name {name}", { name: v.name })} className={cls.input} defaultValue={v.name}
        onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
      {col.modes.map((m) => {
        // A mode with no value of its own shows the default mode's, which is what it resolves to.
        // An alias has none: it shows the target's value for this mode, read-only.
        const val = scene && v.aliasOf !== undefined ? variableValueIn(scene, v, m.id) : (v.values[m.id] ?? v.values[col.modes[0].id]);
        return (
          <div role="cell" key={m.id}>
            {v.aliasOf !== undefined ? (
              <Resolved label={`${v.name} ${m.name}`} value={val} />
            ) : v.type === "color" ? (
              <ColorField label={`${v.name} ${m.name}`} value={val as FillLite | undefined ?? null}
                onCommit={(rgb) => run(setVariableOps(withValue(v, m.id, { ...rgb, a: (val as FillLite | undefined)?.a ?? 1 })))} />
            ) : v.type === "boolean" ? (
              <input type="checkbox" aria-label={`${v.name} ${m.name}`} checked={val === true}
                onChange={(e) => run(setVariableOps(withValue(v, m.id, e.target.checked)))} />
            ) : v.type === "string" ? (
              <input key={m.id + String(val)} aria-label={`${v.name} ${m.name}`} className={cls.input} defaultValue={typeof val === "string" ? val : ""}
                onBlur={(e) => { if (e.target.value !== val) run(setVariableOps(withValue(v, m.id, e.target.value))); }}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            ) : (
              <NumberField label={`${v.name} ${m.name}`} value={typeof val === "number" ? val : NaN}
                onCommit={(n) => run(setVariableOps(withValue(v, m.id, n)))} />
            )}
          </div>
        );
      })}
      <select aria-label={t("Alias of {name}", { name: v.name })} className={cls.select} value={v.aliasOf ?? ""} onChange={(e) => setAlias(e.target.value)}>
        <option value="">{t("None")}</option>
        {targets.map((tg) => (
          <option key={tg.id} value={tg.id}>{scene?.collections[tg.collectionId]?.name ?? "?"} / {tg.name}</option>
        ))}
      </select>
      <button type="button" aria-label={t("Delete variable {name}", { name: v.name })} className="text-fg-subtle hover:text-danger"
        onClick={() => run([makeDeleteVariableOp(v.id)])}>×</button>
    </div>
  );
}

/** The value an alias resolves to in one mode: shown, not editable (edit the target). */
function Resolved({ label, value }: { label: string; value: FillLite | number | string | boolean | undefined }) {
  if (value === undefined) return <span aria-label={label} className="text-fg-subtle">–</span>;
  if (typeof value === "object") {
    const c = `rgba(${Math.round(value.r * 255)}, ${Math.round(value.g * 255)}, ${Math.round(value.b * 255)}, ${value.a})`;
    return <span aria-label={label} className="flex items-center gap-1.5 text-fg-subtle"><span className="size-4 rounded border border-line" style={{ background: c }} />{colorToHex(value)}</span>;
  }
  return <span aria-label={label} className="text-fg-subtle">{String(value)}</span>;
}
