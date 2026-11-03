import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { useT } from "@/i18n";
import { cls } from "@/ui/ds";
import { buildGeneratePrompt, designKitOf, kitIsEmpty } from "@features/generate/prompt";

// GENERATE A SCREEN FROM THE KIT (document menu): the editor has no model, so the dialog shows what the document's
// kit holds, takes the description and hands the connected agent a prompt that builds the screen from that kit only
// (MCP tools get_design_kit and generate_screen, docs/generate.md). The screen arrives through the normal sync.

export function GenerateDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useT();
  const scene = useScene((s) => s.scene);
  const [description, setDescription] = useState("");
  const [width, setWidth] = useState(393);
  const [screenshot, setScreenshot] = useState(false);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  // Every hook is above; the kit is derived, so an empty document just renders the empty-kit message.
  const kit = designKitOf(scene);
  const empty = kitIsEmpty(kit);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildGeneratePrompt(description, kit, { width, screenshot }));
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  const count = (label: string, n: number) => (
    <li className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
      <span>{label}</span>
      <span className="font-medium tabular-nums">{n}</span>
    </li>
  );

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[520px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Generate screen")} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{t("Generate screen")}</h2>
          <p className="text-fg-subtle">{t("Describe a screen. A connected agent builds it from this document's own components, colors and text styles, nothing else.")}</p>
          <ul aria-label={t("Design kit")} className="grid grid-cols-3 gap-1.5">
            {count(t("Components"), kit.components.length)}
            {count(t("Color variables"), kit.colorVariables.length)}
            {count(t("Text styles"), kit.textStyles.length)}
          </ul>
          {empty && <p role="status" className="text-fg-subtle">{t("The kit is empty. Create components, color variables and text styles first, or the agent has nothing to build from.")}</p>}
          <label className="flex flex-col gap-1">
            {t("Description")}
            <textarea
              value={description}
              onChange={(e) => { setDescription(e.target.value); setCopied(null); }}
              rows={4}
              placeholder={t("e.g. A sign in screen with an email field, a password field and a primary button")}
              className={`${cls.input} p-2`}
            />
          </label>
          <div className="flex flex-wrap items-center gap-4 text-[12px]">
            <label className="flex items-center gap-1">{t("Width")}
              <input aria-label={t("Width")} type="number" min={1} value={width} onChange={(e) => { setWidth(Number(e.target.value) || 393); setCopied(null); }} className={`${cls.input} h-7 w-20`} />
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={screenshot} onChange={(e) => { setScreenshot(e.target.checked); setCopied(null); }} />
              {t("I will attach a screenshot to the agent")}
            </label>
          </div>
          {copied === "yes" && <p role="status" className="text-fg-subtle">{t("Copied. Paste it to the agent that is connected to this document.")}</p>}
          {copied === "failed" && <p role="alert" className="text-danger">{t("Could not copy to the clipboard.")}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="h-8 rounded-md px-3 hover:bg-surface-3" onClick={() => onOpenChange(false)}>{t("Close")}</button>
            <button
              type="button"
              disabled={!screenshot && description.trim() === ""}
              onClick={() => void copy()}
              className="h-8 rounded-md bg-accent px-3 text-accent-fg disabled:opacity-50"
            >
              {t("Copy prompt for the agent")}
            </button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
