import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "../store/store";
import type { CollectionLite, FillLite, VariableLite, VariableTypeLite } from "../store/types";
import { makeDeleteCollectionOp, makeDeleteVariableOp, makeSetCollectionOp } from "../tools/ops";
import { Button, cls, EmptyState } from "./ds";
import { ColorField } from "./fields/ColorField";
import { NumberField } from "./fields/NumberField";
import { newCollection, newVariable, removeModeOps, setVariableOps, withMode, withValue } from "./variableOps";

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
  const scene = useScene((s) => s.scene);
  const [picked, setPicked] = useState<string | null>(null);
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

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[720px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Variables" className="flex flex-col gap-3 outline-none">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold">Variables</h2>
            <div className="ml-auto flex items-center gap-2">
              {collections.length > 0 && (
                <select aria-label="Collection" className={`${cls.select} w-44`} value={col?.id ?? ""} onChange={(e) => setPicked(e.target.value)}>
                  {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
              <Button icon="plus" onPress={addCollection}>New collection</Button>
            </div>
          </div>

          {!col ? (
            <EmptyState
              icon="plus"
              title="No variables yet"
              hint="A collection groups variables that share the same modes, like Light and Dark."
              action={<Button variant="primary" onPress={addCollection}>New collection</Button>}
            />
          ) : (
            <CollectionEditor col={col} vars={vars} onDeleted={() => setPicked(null)} />
          )}

          <div className="flex justify-end">
            <Button variant="primary" onPress={() => onOpenChange(false)}>Done</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function CollectionEditor({ col, vars, onDeleted }: { col: CollectionLite; vars: VariableLite[]; onDeleted: () => void }) {
  const rename = (name: string) => { if (name.trim() !== "" && name !== col.name) run([makeSetCollectionOp({ ...col, name: name.trim() })]); };
  const renameMode = (id: string, name: string) => {
    if (name.trim() === "" || col.modes.find((m) => m.id === id)?.name === name) return;
    run([makeSetCollectionOp({ ...col, modes: col.modes.map((m) => (m.id === id ? { ...m, name: name.trim() } : m)) })]);
  };
  const addVariable = (type: VariableTypeLite) => run(setVariableOps(newVariable(col, type, `${type === "color" ? "color" : "number"}/${vars.length + 1}`)));
  const cols = `minmax(9rem,1.2fr) repeat(${col.modes.length}, minmax(7rem,1fr)) 1.75rem`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input key={col.id + col.name} aria-label="Collection name" className={`${cls.input} max-w-60`} defaultValue={col.name}
          onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        <Button icon="plus" onPress={() => run([makeSetCollectionOp(withMode(col))])}>Add mode</Button>
        <Button variant="danger" className="ml-auto" onPress={() => { run([makeDeleteCollectionOp(col.id)]); onDeleted(); }}>
          Delete collection
        </Button>
      </div>

      <div role="table" aria-label="Variables" className="grid gap-x-2 gap-y-1" style={{ gridTemplateColumns: cols }}>
        <div role="row" className="contents">
          <span role="columnheader" className={cls.label}>Name</span>
          {col.modes.map((m) => (
            <span role="columnheader" key={m.id} className="flex items-center gap-1">
              <input key={m.id + m.name} aria-label={`Mode name ${m.name}`} className={`${cls.input} h-6 text-[12px] font-medium`} defaultValue={m.name}
                onBlur={(e) => renameMode(m.id, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
              {col.modes.length > 1 && (
                <button type="button" aria-label={`Remove mode ${m.name}`} className="text-fg-subtle hover:text-danger"
                  onClick={() => run(removeModeOps(col, m.id))}>×</button>
              )}
            </span>
          ))}
          <span />
        </div>
        {vars.map((v) => <VariableRow key={v.id} v={v} col={col} />)}
      </div>

      <div className="flex gap-2">
        <Button icon="plus" onPress={() => addVariable("color")}>Color</Button>
        <Button icon="plus" onPress={() => addVariable("number")}>Number</Button>
      </div>
    </div>
  );
}

function VariableRow({ v, col }: { v: VariableLite; col: CollectionLite }) {
  const rename = (name: string) => { if (name.trim() !== "" && name !== v.name) run(setVariableOps({ ...v, name: name.trim() })); };
  return (
    <div role="row" className="contents">
      <input key={v.id + v.name} aria-label={`Variable name ${v.name}`} className={cls.input} defaultValue={v.name}
        onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
      {col.modes.map((m) => {
        // A mode with no value of its own shows the default mode's, which is what it resolves to.
        const val = v.values[m.id] ?? v.values[col.modes[0].id];
        return (
          <div role="cell" key={m.id}>
            {v.type === "color" ? (
              <ColorField label={`${v.name} ${m.name}`} value={val as FillLite | undefined ?? null}
                onCommit={(rgb) => run(setVariableOps(withValue(v, m.id, { ...rgb, a: (val as FillLite | undefined)?.a ?? 1 })))} />
            ) : (
              <NumberField label={`${v.name} ${m.name}`} value={typeof val === "number" ? val : NaN}
                onCommit={(n) => run(setVariableOps(withValue(v, m.id, n)))} />
            )}
          </div>
        );
      })}
      <button type="button" aria-label={`Delete variable ${v.name}`} className="text-fg-subtle hover:text-danger"
        onClick={() => run([makeDeleteVariableOp(v.id)])}>×</button>
    </div>
  );
}
