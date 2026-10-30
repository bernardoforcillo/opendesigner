import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { chainFrom, headOf } from "@/store/threads";
import { storyEditOp } from "@/store/storyEdit";
import { Button } from "@/ui/ds";

// STORY EDITOR: the whole text of a frame's story in one field, however many frames it flows through (store/storyEdit.ts).
export function StoryDialog({ id, isOpen, onOpenChange }: { id: string; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const scene = useScene((s) => s.scene);
  const head = scene?.nodes.at(scene ? headOf(scene, id) : id);
  const [draft, setDraft] = useState<string | null>(null);
  if (!scene || !head?.text) return null;
  const frames = chainFrom(scene, head).length;
  const value = draft ?? head.text.content;

  function save() {
    const op = storyEditOp(scene!, id, value);
    if (op) {
      const st = useScene.getState();
      st.beginGesture();
      st.endGesture([op]);
    }
    setDraft(null);
    onOpenChange(false);
  }

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={(o) => { if (!o) setDraft(null); onOpenChange(o); }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="w-full max-w-[640px] rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Story editor" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Story{frames > 1 ? ` · ${frames} frames` : ""}</h2>
          <textarea aria-label="Story text" spellCheck className="h-[320px] w-full resize-y rounded border border-border bg-bg p-2 font-mono text-[12px] leading-5"
            value={value} onChange={(e) => setDraft(e.target.value)} />
          <p className="text-[11px] text-fg-subtle">Character and paragraph styles stay with the text around your changes.</p>
          <div className="flex justify-end gap-2">
            <Button variant="primary" onPress={save}>Save</Button>
            <Button onPress={() => { setDraft(null); onOpenChange(false); }}>Cancel</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
