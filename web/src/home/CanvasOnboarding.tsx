import { useEffect, useMemo, useRef, useState } from "react";
import { Button as RacButton } from "react-aria-components";
import { Icon, Kbd } from "../ui/ds";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { docClient } from "../rpc/client";
import type { SceneState } from "../store/types";
import { TEMPLATES } from "../templates/catalog";
import type { Template } from "../templates/catalog";
import { checklistSteps, onboardingMode, screenNodes, type ChecklistStep } from "./checklist";
import { loadDocPrefs, saveDocPrefs, SHIPPED_EVENT, type DocPrefs } from "./docPrefs";
import { applyTemplate, type StartClient } from "./startDocument";

// ONBOARDING INSIDE THE EDITOR, over the canvas but NEVER against it:
//
//  - document without screens -> a card in the center, "Where do you want to start?": the
//    templates (applied to THIS document), "Draw a screen (A)" and the
//    four-step checklist;
//  - with screens but an incomplete checklist -> a compact card at the top
//    right showing the missing steps and ticking itself off;
//  - closed (the X) or completed -> it disappears, and the choice is remembered per document.
//
// The container is `pointer-events-none`: clicks on the canvas pass through. Only the
// card takes them (`pointer-events-auto`).

export const FIT_MARGIN = 72;

/** The camera that frames all the screens in a w x h box (never beyond 1:1). */
export function fitCameraToScreens(scene: SceneState, w: number, h: number) {
  const screens = screenNodes(scene);
  if (screens.length === 0 || w <= 0 || h <= 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of screens) {
    minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.width); maxY = Math.max(maxY, s.y + s.height);
  }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const zoom = Math.min(1, Math.max(0.05, Math.min((w - 2 * FIT_MARGIN) / bw, (h - 2 * FIT_MARGIN) / bh)));
  return { zoom, x: (w - bw * zoom) / 2 - minX * zoom, y: (h - bh * zoom) / 2 - minY * zoom };
}

export function CanvasOnboarding({
  onDrawScreen, client = docClient as unknown as StartClient,
}: { onDrawScreen: () => void; client?: Pick<StartClient, "submitOp"> }) {
  const docId = useScene((s) => s.scene?.id ?? "");
  const hasNodes = useScene((s) => (s.scene?.nodes.size ?? 0) > 0);
  const box = useRef<HTMLDivElement>(null);
  const [prefs, setPrefs] = useState<DocPrefs>(() => (docId ? loadDocPrefs(docId) : { dismissed: false, presented: false, shipped: false }));
  const prefsFor = useRef(docId);

  // The document changes (or arrives): re-read its preferences.
  useEffect(() => {
    if (!docId || prefsFor.current === docId) return;
    prefsFor.current = docId;
    setPrefs(loadDocPrefs(docId));
  }, [docId]);

  const update = (patch: Partial<DocPrefs>) => {
    if (docId) setPrefs(saveDocPrefs(docId, patch));
  };

  // The prototype was opened: the "Present" step is done, forever.
  useEffect(() => {
    if (!docId) return;
    return useFlowUi.subscribe((st, prev) => {
      if (st.presenting && !prev.presenting) setPrefs(saveDocPrefs(docId, { presented: true }));
    });
  }, [docId]);

  // The code was exported (the event is emitted by Develop mode).
  useEffect(() => {
    if (!docId) return;
    const on = () => setPrefs(saveDocPrefs(docId, { shipped: true }));
    window.addEventListener(SHIPPED_EVENT, on);
    return () => window.removeEventListener(SHIPPED_EVENT, on);
  }, [docId]);

  // A document that opens with screens (from a template, from a colleague, from
  // a reopen) is framed whole: the canvas always starts at (0,0) at zoom 1 and
  // would show a corner of the first screen. Once per document.
  const fitted = useRef("");
  const fit = () => {
    const scene = useScene.getState().scene;
    const el = box.current;
    if (!scene || !el) return false;
    const cam = fitCameraToScreens(scene, el.clientWidth, el.clientHeight);
    if (!cam) return false;
    useScene.getState().setCamera(cam);
    return true;
  };
  useEffect(() => {
    if (!docId || !hasNodes || fitted.current === docId) return;
    if (fit()) fitted.current = docId;
  }, [docId, hasNodes]);

  if (!docId || prefs.dismissed) return <div ref={box} className="pointer-events-none absolute inset-0" />;
  return (
    <div ref={box} className="pointer-events-none absolute inset-0">
      <Live docId={docId} prefs={prefs} update={update} onDrawScreen={onDrawScreen} client={client} refit={fit} />
    </div>
  );
}

// The part that reads the scene on every change: mounted ONLY while the card is
// alive, so a completed (or closed) document pays nothing.
function Live({
  docId, prefs, update, onDrawScreen, client, refit,
}: {
  docId: string; prefs: DocPrefs; update: (p: Partial<DocPrefs>) => void;
  onDrawScreen: () => void; client: Pick<StartClient, "submitOp">; refit: () => boolean;
}) {
  const scene = useScene((s) => s.scene);
  const steps = useMemo(() => checklistSteps(scene, prefs), [scene, prefs]);
  const [busy, setBusy] = useState<{ id: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // While the template is being applied the big card STAYS: the first op that
  // arrives would already make "Draw" done and switch it to the
  // compact one, inviting to close it (or to reload) with the template half applied.
  const mode = busy ? "empty" : onboardingMode(scene, prefs.dismissed, steps);

  // All four steps done: the card has done its job, forever.
  useEffect(() => {
    if (scene && steps.every((s) => s.done)) update({ dismissed: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps]);

  async function pick(t: Template) {
    if (busy) return;
    const st = useScene.getState();
    const pageId = st.currentPageId ?? st.scene?.pages[0]?.id ?? "page1";
    setError(null);
    setBusy({ id: t.id, done: 0, total: 1 });
    try {
      await applyTemplate(client, docId, pageId, t, { clientId: "template", onProgress: (done, total) => setBusy({ id: t.id, done, total }) });
      // The ops come back from the stream: we frame (and the big card gives up its
      // place) only when everything is there -- nodes AND transitions --, not at the first
      // screen that arrives.
      const built = t.build(pageId, () => "x");
      const wantNodes = built.nodes.length, wantTransitions = built.transitions.length;
      for (let i = 0; i < 50; i++) {
        const sc = useScene.getState().scene;
        if (sc && sc.nodes.size >= wantNodes && Object.keys(sc.transitions).length >= wantTransitions) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      refit();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (mode === "none") return null;
  if (mode === "progress") return <ProgressCard steps={steps} onClose={() => update({ dismissed: true })} />;
  return <EmptyCard steps={steps} busy={busy} error={error} onPick={(t) => void pick(t)} onDraw={onDrawScreen} onClose={() => update({ dismissed: true })} />;
}

function Check({ done, n }: { done: boolean; n: number }) {
  return (
    <span
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums ${
        done ? "bg-ok text-white" : "bg-surface-3 text-fg-subtle"
      }`}
    >
      {done ? <Icon name="check" size={11} strokeWidth={2.2} /> : n}
    </span>
  );
}

function CloseButton({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <RacButton
      aria-label={label}
      onPress={onClose}
      className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)]"
    >
      <Icon name="x" size={12} />
    </RacButton>
  );
}

function EmptyCard({
  steps, busy, error, onPick, onDraw, onClose,
}: {
  steps: ChecklistStep[]; busy: { id: string; done: number; total: number } | null; error: string | null;
  onPick: (t: Template) => void; onDraw: () => void; onClose: () => void;
}) {
  const choices = TEMPLATES.filter((t) => t.id !== "blank");
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <section
        aria-label="Where do you want to start?"
        className="pointer-events-auto relative w-full max-w-[460px] rounded-2xl bg-raised p-5 text-fg shadow-pop"
      >
        <CloseButton onClose={onClose} label="Close and don't show again for this document" />
        <h2 className="pr-6 text-[16px] font-semibold tracking-[-0.01em]">Where do you want to start?</h2>
        <p className="mt-0.5 text-[13px] text-fg-muted">A template gives you screens that are already connected, ready to try; or draw your own.</p>

        <div className="mt-3.5 grid grid-cols-2 gap-2">
          {choices.map((t) => (
            <RacButton
              key={t.id}
              onPress={() => onPick(t)}
              isDisabled={!!busy}
              aria-label={`Apply the ${t.name} template`}
              className="flex items-start gap-2 rounded-lg border border-line bg-surface p-2.5 text-left outline-none hover:border-line-strong hover:bg-surface-2 focus-visible:shadow-[var(--ring)] disabled:opacity-50"
            >
              <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent"><Icon name={t.icon} size={13} /></span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold">{t.name}</span>
                <span className="block text-[11px] leading-snug text-fg-subtle">
                  {busy?.id === t.id ? `Applying… ${busy.total > 1 ? Math.round((busy.done / busy.total) * 100) : 0}%` : t.tagline}
                </span>
              </span>
            </RacButton>
          ))}
        </div>
        {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}

        <RacButton
          onPress={onDraw}
          isDisabled={!!busy}
          className="mt-2.5 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[13px] font-medium text-accent-fg outline-none hover:bg-accent-hover focus-visible:shadow-[var(--ring)] disabled:opacity-50"
        >
          <Icon name="frame" size={14} /> Draw a screen <Kbd>A</Kbd>
        </RacButton>

        <ol aria-label="Steps" className="mt-4 flex items-center justify-between gap-1 border-t border-line pt-3.5">
          {steps.map((s, i) => (
            <li key={s.id} data-done={s.done} className="flex items-center gap-1.5 text-[12px] text-fg-muted">
              <Check done={s.done} n={i + 1} />
              <span className={s.done ? "text-fg-subtle line-through" : ""}>{s.label}</span>
              {i < steps.length - 1 && <Icon name="chevronRight" size={10} className="ml-0.5 text-fg-subtle" />}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function ProgressCard({ steps, onClose }: { steps: ChecklistStep[]; onClose: () => void }) {
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  return (
    <section
      aria-label="Getting started"
      className="pointer-events-auto absolute right-3 top-3 w-[232px] rounded-xl bg-raised p-3 text-fg shadow-pop"
    >
      <CloseButton onClose={onClose} label="Close getting started" />
      <h2 className="flex items-baseline gap-1.5 pr-6 text-[13px] font-semibold">
        Getting started <span className="text-[11px] font-medium tabular-nums text-fg-subtle">{done}/{steps.length}</span>
      </h2>
      <ol aria-label="Steps" className="mt-2 flex flex-col gap-1.5">
        {steps.map((s, i) => (
          <li key={s.id} data-done={s.done} className="flex items-center gap-2 text-[12px]">
            <Check done={s.done} n={i + 1} />
            <span className={s.done ? "text-fg-subtle line-through" : s === next ? "font-medium text-fg" : "text-fg-muted"}>{s.label}</span>
          </li>
        ))}
      </ol>
      {next && <p className="mt-2.5 border-t border-line pt-2 text-[12px] leading-snug text-fg-muted">{next.hint}</p>}
    </section>
  );
}
