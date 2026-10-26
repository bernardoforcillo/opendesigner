import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { imageLinks, pickImageFile, ppiStatus, relinkImage } from "@/tools/imageLinks";
import { Button } from "@/ui/ds";

// LINKS (document menu): every image of the document with the file it came from, its size, its effective
// resolution at the size it is placed, and a way to open it (select it on its page) or relink it to another file.
// A browser cannot watch a file on disk, so "update a link" is relinking to the new version. See docs/graphics-colour.md.

export function LinksDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const scene = useScene((s) => s.scene);
  if (!scene || !isOpen) return null;
  const links = isOpen ? imageLinks(scene) : [];
  const low = links.filter((l) => ppiStatus(l.ppi) === "low").length;
  const pageName = (id: string) => scene.pages.find((p) => p.id === id)?.name || "Page";
  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[640px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Links" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Links</h2>
          {links.length === 0 && <p className="text-fg-subtle">No images in this document.</p>}
          {low > 0 && <p role="status" className="text-danger">{low} {low === 1 ? "image is" : "images are"} under 150 ppi at the size placed.</p>}
          <ul aria-label="Images" className="flex flex-col gap-1">
            {links.map((l) => (
              <li key={l.id} className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-md border border-line p-1.5">
                <button type="button" className="min-w-0 text-left" aria-label={`Show ${l.name}`}
                  onClick={() => { const st = useScene.getState(); if (l.pageId) st.setCurrentPage(l.pageId); st.setSelection([l.id]); }}>
                  <span className="block truncate">{l.originalName || l.name}</span>
                  <span className={"block text-[12px] " + (ppiStatus(l.ppi) === "low" ? "text-danger" : "text-fg-subtle")}>
                    {pageName(l.pageId)} · {l.pixelWidth > 0 ? `${l.pixelWidth} × ${l.pixelHeight} px` : "size unknown"}{l.ppi !== null ? ` · ${Math.round(l.ppi)} ppi` : ""}
                  </span>
                </button>
                <Button onPress={() => { void pickImageFile().then((f) => { if (f) void relinkImage(l.id, f); }); }}>Relink…</Button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end"><Button onPress={() => onOpenChange(false)}>Done</Button></div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
