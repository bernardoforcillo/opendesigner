import { useMemo, useState } from "react";
import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { findAll, replaceOps, type FindOptions } from "@/store/findReplace";
import { Button, cls } from "@/ui/ds";

// FIND AND CHANGE (document menu): search the text of every page, jump to a match, change one or all. Plain
// text, case, whole word or a regular expression ($1 in the replacement). A change is one gesture = one undo.
// See docs/text-frames.md.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

export function FindReplaceDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn } = useT();
  const scene = useScene((s) => s.scene);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [at, setAt] = useState(0);
  const opts: FindOptions = { query, matchCase, wholeWord, regex };
  const found = useMemo(() => (isOpen && scene ? findAll(scene, { query, matchCase, wholeWord, regex }) : []), [isOpen, scene, query, matchCase, wholeWord, regex]);
  if (!scene) return null;
  const error = Array.isArray(found) ? null : found.error;
  const matches = Array.isArray(found) ? found : [];
  const current = matches[Math.min(at, matches.length - 1)];

  function go(i: number) {
    if (matches.length === 0) return;
    const k = ((i % matches.length) + matches.length) % matches.length;
    setAt(k);
    const m = matches[k];
    const st = useScene.getState();
    st.setCurrentPage(m.pageId);
    st.setSelection([m.nodeId]);
  }
  const pageName = (id: string) => scene.pages.find((p) => p.id === id)?.name || t("Page");

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[10vh]">
      <Modal className="max-h-[80vh] w-full max-w-[520px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Find and change")} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{t("Find and change")}</h2>
          <input aria-label={t("Find")} autoFocus className={cls.input} value={query} placeholder={t("Find")} onChange={(e) => { setQuery(e.target.value); setAt(0); }}
            onKeyDown={(e) => { if (e.key === "Enter") go(e.shiftKey ? at - 1 : at + 1); }} />
          <input aria-label={t("Change to")} className={cls.input} value={replacement} placeholder={regex ? t("Change to (use $1 for groups)") : t("Change to")} onChange={(e) => setReplacement(e.target.value)} />
          <div className="flex flex-wrap gap-4">
            {([[t("Match case"), matchCase, setMatchCase], [t("Whole word"), wholeWord, setWholeWord], [t("Regular expression"), regex, setRegex]] as const).map(([label, value, set]) => (
              <label key={label} className="flex items-center gap-1.5">
                <input type="checkbox" aria-label={label} checked={value} onChange={(e) => { set(e.target.checked); setAt(0); }} /> {label}
              </label>
            ))}
          </div>
          {error && <p role="alert" className="text-danger">{error}</p>}
          <p aria-live="polite" className="text-fg-subtle">
            {query === "" ? t("Type what to look for.") : matches.length === 0 ? t("No match.") : `${matches.length >= 5000 ? t("More than {n} matches", { n: 5000 }) : tn("{n} matches", matches.length)}${current ? ` — ${t("{i} of {n}", { i: Math.min(at, matches.length - 1) + 1, n: matches.length })}` : ""}`}
          </p>
          <ul aria-label={t("Matches")} className="max-h-[200px] overflow-auto">
            {matches.slice(0, 200).map((m, i) => (
              <li key={`${m.nodeId}:${m.start}`}>
                <button type="button" aria-current={i === at ? "true" : undefined}
                  className={"flex w-full gap-2 rounded-md px-2 py-1 text-left " + (i === at ? "bg-accent-soft" : "hover:bg-surface-3")} onClick={() => go(i)}>
                  <span className="shrink-0 text-fg-subtle">{pageName(m.pageId)}</span>
                  <span className="truncate">{m.context}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-end gap-2">
            <Button isDisabled={matches.length === 0} onPress={() => go(at - 1)}>{t("Previous")}</Button>
            <Button isDisabled={matches.length === 0} onPress={() => go(at + 1)}>{t("Next")}</Button>
            <Button isDisabled={!current} onPress={() => { if (current) run(replaceOps(scene, [current], opts, replacement)); }}>{t("Change")}</Button>
            <Button variant="primary" isDisabled={matches.length === 0} onPress={() => run(replaceOps(scene, matches, opts, replacement))}>{t("Change all")}</Button>
            <Button onPress={() => onOpenChange(false)}>{t("Done")}</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
