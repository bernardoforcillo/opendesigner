import { useState } from "react";
import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { changeObjectsOps, clipWithShapeOps, exportSnippet, findObjects, fitOps, gapOps, placeSnippetOps, qrOps, releaseClipOps, stepRepeatOps, type FitMode } from "@/tools/objectTools";
import { QR_LEVELS, type QrLevel } from "@/tools/qrcode";
import { Button, cls } from "@/ui/ds";

// OBJECT TOOLS (object menu): Step and Repeat, the Gap tool, frame fitting, clipping paths, QR codes, find/change on objects and
// snippets. They work on the selection; every action is one undo step and says what it did (or why it could not) in the status line.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

const hex = (v: string): { r: number; g: number; b: number; a: number } | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
};

function Form() {
  const { t, tn, tx } = useT();
  const [count, setCount] = useState("3");
  const [dx, setDx] = useState("20");
  const [dy, setDy] = useState("0");
  const [gap, setGap] = useState("12");
  const [axis, setAxis] = useState<"x" | "y">("x");
  const [qrText, setQrText] = useState("");
  const [qrLevel, setQrLevel] = useState<QrLevel>("M");
  const [qrSize, setQrSize] = useState("128");
  const [kind, setKind] = useState("");
  const [nameRe, setNameRe] = useState("");
  const [fromFill, setFromFill] = useState("");
  const [toFill, setToFill] = useState("");
  const [snippet, setSnippet] = useState("");
  const [status, setStatus] = useState("");
  const scene = () => useScene.getState().scene!;
  const selection = () => useScene.getState().selection;
  const reply = (r: string | unknown, ok: string) => setStatus(typeof r === "string" ? r : ok);
  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

  const pageId = () => useScene.getState().currentPageId ?? scene().pages.find((p) => !p.isMaster)?.id ?? scene().pages[0]!.id;
  const query = () => {
    const q: Parameters<typeof findObjects>[1] = {};
    if (kind) q.kind = kind as never;
    if (nameRe) q.name = nameRe;
    if (fromFill) { const c = hex(fromFill); if (!c) return t("Fill colour must be like #ff0000."); q.fill = c; }
    return q;
  };

  return (
    <Dialog aria-label={t("Object tools")} className="flex flex-col gap-3 outline-none">
      <h2 className="text-[14px] font-semibold">{t("Object tools")}</h2>
      <p role="status" aria-label={t("Status")} className="min-h-[1.25rem] text-fg-subtle">{status}</p>

      <section aria-label={t("Step and Repeat")} className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">{t("Step and Repeat")}</h3>
        <div className="flex items-end gap-2">
          <label className="flex flex-col">{t("Copies")}<input aria-label={t("Copies")} className={cls.input} value={count} onChange={(e) => setCount(e.target.value)} /></label>
          <label className="flex flex-col">{t("Offset X")}<input aria-label={t("Offset X")} className={cls.input} value={dx} onChange={(e) => setDx(e.target.value)} /></label>
          <label className="flex flex-col">{t("Offset Y")}<input aria-label={t("Offset Y")} className={cls.input} value={dy} onChange={(e) => setDy(e.target.value)} /></label>
          <Button onPress={() => {
            const made = stepRepeatOps(scene(), selection(), { count: num(count), dx: num(dx), dy: num(dy) });
            if (typeof made !== "string") { run(made.ops); useScene.getState().setSelection(made.ids); }
            reply(made, t("Copies made."));
          }}>{t("Repeat")}</Button>
        </div>
      </section>

      <section aria-label={t("Gap")} className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">{t("Gap")}</h3>
        <div className="flex items-end gap-2">
          <label className="flex flex-col">{t("Space")}<input aria-label={t("Gap size")} className={cls.input} value={gap} onChange={(e) => setGap(e.target.value)} /></label>
          <select aria-label={t("Gap direction")} className={cls.select} value={axis} onChange={(e) => setAxis(e.target.value as "x" | "y")}>
            <option value="x">{t("Side by side")}</option><option value="y">{t("Stacked")}</option>
          </select>
          <Button onPress={() => {
            const ops = gapOps(scene(), selection(), axis, num(gap));
            if (typeof ops !== "string") run(ops);
            reply(ops, t("Gap set."));
          }}>{t("Set gap")}</Button>
        </div>
      </section>

      <section aria-label={t("Frame fitting")} className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">{t("Frame fitting")}</h3>
        <div className="flex flex-wrap gap-2">
          {([["fill", "Fill frame"], ["fit", "Fit content"], ["tile", "Tile"], ["frame-to-content", "Frame to content"]] as [FitMode, string][]).map(([m, label]) => (
            <Button key={m} onPress={() => {
              const id = selection()[0];
              const ops = id ? fitOps(scene(), id, m) : t("Select a node first.");
              if (typeof ops !== "string") run(ops);
              reply(ops, t("Done."));
            }}>{tx(label)}</Button>
          ))}
        </div>
      </section>

      <section aria-label={t("Clipping path")} className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">{t("Clipping path")}</h3>
        <p className="text-fg-subtle">{t("Select the content, then the shape last: the shape's outline clips everything else.")}</p>
        <div className="flex gap-2">
          <Button onPress={() => {
            const sel = selection();
            const shape = sel[sel.length - 1];
            const made = shape ? clipWithShapeOps(scene(), shape, sel.slice(0, -1)) : t("Select the content and the shape.");
            if (typeof made !== "string") { run(made.ops); useScene.getState().setSelection([made.groupId]); }
            reply(made, t("Clipped."));
          }}>{t("Clip to shape")}</Button>
          <Button onPress={() => {
            const id = selection()[0];
            const ops = id ? releaseClipOps(scene(), id) : t("Select the clipping shape.");
            if (typeof ops !== "string") run(ops);
            reply(ops, t("Released."));
          }}>{t("Release")}</Button>
        </div>
      </section>

      <section aria-label={t("QR code")} className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">{t("QR code")}</h3>
        <div className="flex items-end gap-2">
          <label className="flex flex-1 flex-col">{t("Text or URL")}<input aria-label={t("QR text")} className={cls.input} value={qrText} onChange={(e) => setQrText(e.target.value)} /></label>
          <select aria-label={t("QR level")} className={cls.select} value={qrLevel} onChange={(e) => setQrLevel(e.target.value as QrLevel)}>
            {QR_LEVELS.map((l) => <option key={l} value={l}>{t("Level {level}", { level: l })}</option>)}
          </select>
          <label className="flex w-20 flex-col">{t("Size")}<input aria-label={t("QR size")} className={cls.input} value={qrSize} onChange={(e) => setQrSize(e.target.value)} /></label>
          <Button isDisabled={qrText === ""} onPress={() => {
            const made = qrOps(scene(), { text: qrText, level: qrLevel, size: num(qrSize), x: 40, y: 40, parentId: pageId() });
            if (typeof made !== "string") { run(made.ops); useScene.getState().setSelection([made.groupId]); }
            reply(made, t("QR code added."));
          }}>{t("Add")}</Button>
        </div>
      </section>

      <section aria-label={t("Find and change objects")} className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">{t("Find and change objects")}</h3>
        <div className="flex items-end gap-2">
          <select aria-label={t("Object kind")} className={cls.select} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t("Any kind")}</option>
            {["rect", "ellipse", "text", "image", "vector", "group", "frame"].map((k) => <option key={k} value={k}>{tx(k)}</option>)}
          </select>
          <input aria-label={t("Name matches")} className={cls.input} placeholder={t("Name (regex)")} value={nameRe} onChange={(e) => setNameRe(e.target.value)} />
          <input aria-label={t("Fill colour")} className={cls.input} placeholder={t("Fill #rrggbb")} value={fromFill} onChange={(e) => setFromFill(e.target.value)} />
        </div>
        <div className="flex items-end gap-2">
          <Button onPress={() => {
            const q = query();
            const found = typeof q === "string" ? q : findObjects(scene(), q);
            if (typeof found !== "string") useScene.getState().setSelection(found.map((n) => n.id));
            reply(found, tn("{n} found and selected.", (found as unknown[]).length));
          }}>{t("Find")}</Button>
          <input aria-label={t("Change fill to")} className={cls.input} placeholder={t("New fill #rrggbb")} value={toFill} onChange={(e) => setToFill(e.target.value)} />
          <Button isDisabled={toFill === ""} onPress={() => {
            const q = query();
            const to = hex(toFill);
            const found = typeof q === "string" ? q : findObjects(scene(), q);
            if (typeof found === "string") return setStatus(found);
            if (!to) return setStatus(t("New fill must be like #00aa44."));
            run(changeObjectsOps(scene(), found, { fill: to }, q as Parameters<typeof changeObjectsOps>[3]));
            setStatus(tn("{n} changed.", found.length));
          }}>{t("Change fill")}</Button>
        </div>
      </section>

      <section aria-label={t("Snippets")} className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">{t("Snippets")}</h3>
        <p className="text-fg-subtle">{t("A snippet is the selection as text: keep it in a file or a library and place it in any document.")}</p>
        <textarea aria-label={t("Snippet")} className={cls.input} rows={3} value={snippet} onChange={(e) => setSnippet(e.target.value)} />
        <div className="flex gap-2">
          <Button onPress={() => {
            const text = exportSnippet(scene(), selection());
            if (text) setSnippet(text);
            setStatus(text ? t("Snippet made from the selection.") : t("Select something first."));
          }}>{t("From selection")}</Button>
          <Button isDisabled={snippet === ""} onPress={() => {
            const made = placeSnippetOps(scene(), snippet, 40, 40, pageId());
            if (typeof made !== "string") { run(made.ops); useScene.getState().setSelection(made.ids); }
            reply(made, t("Snippet placed."));
          }}>{t("Place")}</Button>
        </div>
      </section>
    </Dialog>
  );
}

export function ObjectToolsDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const scene = useScene((s) => s.scene);
  if (!scene || !isOpen) return null;
  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[90vh] w-full max-w-[620px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <div className="flex flex-col gap-3">
          <Form />
          <div className="flex justify-end"><Button onPress={() => onOpenChange(false)}>Done</Button></div>
        </div>
      </Modal>
    </ModalOverlay>
  );
}
