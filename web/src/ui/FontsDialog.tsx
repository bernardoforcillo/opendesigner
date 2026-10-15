import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { uploadAsset } from "../rpc/assets";
import { useScene } from "../store/store";
import { makeDeleteFontOp } from "../tools/ops";
import { Button, cls, EmptyState } from "./ds";
import { addFontOp, guessFontFromFilename } from "./typographyOps";

// THE FONTS DIALOG (document menu → Fonts…): upload a TTF/OTF/WOFF/WOFF2 file and
// say which family, weight and style it is; the text styles that name that family
// then draw with it -- in the editor, in exports and in generated code. The file
// is a content-addressed asset (like an image); the document only stores its hash.

const WEIGHTS = ["100", "200", "300", "400", "500", "600", "700", "800", "900"];
const ACCEPT = ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2";

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

export function FontsDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const scene = useScene((s) => s.scene);
  const [file, setFile] = useState<File | null>(null);
  const [family, setFamily] = useState("");
  const [weight, setWeight] = useState("400");
  const [italic, setItalic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fonts = isOpen && scene ? Object.values(scene.fonts ?? {}).sort((a, b) =>
    a.family.localeCompare(b.family) || Number(a.weight) - Number(b.weight) || a.style.localeCompare(b.style)) : [];

  const pick = (f: File | null) => {
    setFile(f);
    setError(null);
    if (!f) return;
    const guess = guessFontFromFilename(f.name);
    setFamily(guess.family);
    setWeight(guess.weight);
    setItalic(guess.italic);
  };

  const add = async () => {
    const cur = useScene.getState().scene;
    if (!file || !cur) return;
    setBusy(true);
    setError(null);
    try {
      const ref = await uploadAsset(cur.id, file);
      const { op } = addFontOp(family, weight, italic, ref.hash);
      const before = Object.keys(useScene.getState().scene?.fonts ?? {}).length;
      run([op]);
      // The same (family, weight, style) twice is refused by the document: say so instead of doing nothing.
      if (Object.keys(useScene.getState().scene?.fonts ?? {}).length === before) {
        setError("a font with this family, weight and style already exists, or the family name has unsupported characters");
      } else {
        setFile(null);
        setFamily("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not upload the font");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[560px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Fonts" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Fonts</h2>
          <p className="text-fg-subtle">
            Upload a font file and a text whose font is that family is drawn with it, in the editor, in exports and in the generated code.
            Only upload fonts you are licensed to embed.
          </p>

          {fonts.length === 0 ? (
            <EmptyState icon="plus" title="No uploaded fonts" hint="The built-in fonts are always available." />
          ) : (
            <ul aria-label="Uploaded fonts" className="flex flex-col gap-1">
              {fonts.map((f) => (
                <li key={f.id} className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1">
                  <span className="min-w-0 flex-1 truncate" style={{ fontFamily: `"${f.family}"`, fontWeight: f.weight, fontStyle: f.style }}>{f.family}</span>
                  <span className="text-fg-subtle tabular-nums">{f.weight}{f.style === "italic" ? " italic" : ""}</span>
                  <button type="button" aria-label={`Delete ${f.family} ${f.weight}${f.style === "italic" ? " italic" : ""}`}
                    className="text-fg-subtle hover:text-danger" onClick={() => run([makeDeleteFontOp(f.id)])}>×</button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <input type="file" aria-label="Font file" accept={ACCEPT} className="text-[12px]"
              onChange={(e) => pick(e.target.files?.[0] ?? null)} />
            {file && (
              <div className="grid grid-cols-[1fr_6rem_auto] items-center gap-2">
                <input aria-label="Family name" className={cls.input} value={family} maxLength={64} onChange={(e) => setFamily(e.target.value)} />
                <select aria-label="Weight" className={cls.select} value={weight} onChange={(e) => setWeight(e.target.value)}>
                  {WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={italic} onChange={(e) => setItalic(e.target.checked)} /> Italic
                </label>
              </div>
            )}
            {error && <p role="alert" className="text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="primary" isDisabled={!file || busy || family.trim() === ""} onPress={() => void add()}>
                {busy ? "Uploading…" : "Add font"}
              </Button>
              <Button onPress={() => onOpenChange(false)}>Done</Button>
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
