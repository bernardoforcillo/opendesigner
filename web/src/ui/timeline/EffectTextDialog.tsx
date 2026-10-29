import { useEffect, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { create } from "zustand";
import { Button, cls } from "@/ui/ds";
import { useScene } from "@/store/store";
import { addPropertyTracks, commitClip, useTimeline } from "@/animation/timelineStore";
import { fxLayerProp, fxStringProp } from "@/animation/fx/props";
import { fxDef, resolveStrings } from "@/animation/fx/library";
import { FX_CATALOG } from "@/animation/fx/catalog";
import { setStringParam, stringParamOf } from "@/animation/timelineLogic";
import { parseFxFile, registerFxData, wrapFxFile } from "@/animation/fx/files";
import { uploadAsset } from "@/rpc/assets";

// THE TEXT OF AN EFFECT (Basic Text, Path Text): a string parameter cannot be a keyframe value, so it is typed here. Adding the
// effect opens it; the pencil on the effect's text track in the timeline opens it again to change the text. See animation/fx/props.ts.

interface Target { effectId: string; mode: "add" | "edit"; nodeId?: string; layerId?: string }
interface State { target: Target | null; open: (t: Target) => void; close: () => void }
export const useEffectText = create<State>((set) => ({ target: null, open: (target) => set({ target }), close: () => set({ target: null }) }));

function Form({ target }: { target: Target }) {
  const def = fxDef(target.effectId);
  const scene = useScene((s) => s.scene);
  const clipId = useTimeline((s) => s.clipId);
  const clip = scene && clipId ? scene.clips[clipId] : undefined;
  const strings = def?.strings ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const given: Record<string, string> = {};
    if (clip && target.nodeId) for (const s of strings) { const v = stringParamOf(clip, target.nodeId, target.effectId, s.id); if (v !== undefined) given[s.id] = v; }
    return resolveStrings(def!, given);
  });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const close = useEffectText((s) => s.close);
  const pickFile = async (id: string, file: File | undefined) => {
    const docId = useScene.getState().scene?.id;
    if (!file || !docId) return;
    setBusy(true);
    setNote(`Reading ${file.name}…`);
    try {
      const wrapped = wrapFxFile(new Uint8Array(await file.arrayBuffer()));
      const data = parseFxFile(wrapped);
      if (!data) { setNote("The editor cannot read this file (.cube, .3dl, .cdl, .cc, .ccc, .acv or .amp)."); return; }
      const ref = await uploadAsset(docId, new Blob([wrapped as BlobPart]));
      registerFxData(ref.hash, data);
      setValues((v) => ({ ...v, [id]: ref.hash }));
      setNote(file.name);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not upload the file.");
    } finally {
      setBusy(false);
    }
  };
  const missingFile = strings.some((s) => s.file && (values[s.id] ?? "") === "");
  const name = FX_CATALOG.find((e) => e.id === target.effectId)?.name ?? target.effectId;

  const apply = () => {
    const st = useScene.getState();
    if (!st.scene || !def) return close();
    if (target.mode === "edit" && target.nodeId && clip) {
      let next = clip;
      for (const s of strings) next = setStringParam(next, target.nodeId, def.id, s.id, values[s.id] ?? "");
      if (next !== clip) commitClip(next);
    } else {
      const props = [
        ...(target.layerId ? [fxLayerProp(def.id, target.layerId)] : []),
        ...strings.map((s) => fxStringProp(def.id, s.id, values[s.id] ?? s.default)),
        `fx.${def.id}.${def.params[0].id}`,
      ];
      addPropertyTracks(st.scene, st.selection, props);
    }
    close();
  };

  return (
    <Dialog aria-label={`${name} text`} className="flex flex-col gap-3 outline-none">
      <h2 className="text-[14px] font-semibold">{name}</h2>
      {strings.map((s) => s.file ? (
        <label key={s.id} className="flex flex-col gap-1">
          {s.label}
          <input type="file" aria-label={s.label} accept={s.file} disabled={busy} className="text-[12px]" onChange={(e) => void pickFile(s.id, e.target.files?.[0])} />
          <span role="status" className="text-[11px] text-fg-subtle">{note !== "" ? note : (values[s.id] ?? "") !== "" ? "A file is attached." : "No file yet: the node is drawn without the effect."}</span>
        </label>
      ) : (
        <label key={s.id} className="flex flex-col gap-1">
          {s.label}
          {s.multiline ? (
            <textarea aria-label={s.label} rows={3} className={cls.input} value={values[s.id] ?? ""} onChange={(e) => setValues({ ...values, [s.id]: e.target.value })} />
          ) : (
            <input aria-label={s.label} className={cls.input} value={values[s.id] ?? ""} onChange={(e) => setValues({ ...values, [s.id]: e.target.value })} />
          )}
        </label>
      ))}
      <div className="flex justify-end gap-2">
        <Button onPress={close}>Cancel</Button>
        <Button variant="primary" isDisabled={busy || (target.mode === "add" && missingFile)} onPress={apply}>{target.mode === "add" ? "Add" : "Apply"}</Button>
      </div>
    </Dialog>
  );
}

/** Mounted once (in the transport): shows itself when an effect with text is added or its text is edited. */
export function EffectTextDialog() {
  const target = useEffectText((s) => s.target);
  const close = useEffectText((s) => s.close);
  // closing the timeline closes the dialog with it
  const open = useTimeline((s) => s.open);
  useEffect(() => { if (!open) close(); }, [open, close]);
  if (!target || !fxDef(target.effectId)?.strings) return null;
  return (
    <ModalOverlay isDismissable isOpen onOpenChange={(o) => { if (!o) close(); }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="w-full max-w-[420px] rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Form key={`${target.effectId}:${target.nodeId ?? ""}:${target.mode}`} target={target} />
      </Modal>
    </ModalOverlay>
  );
}
