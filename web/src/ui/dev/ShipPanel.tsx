import { useState } from "react";
import { useScene } from "../../store/store";
import { measureNode, type Measurement } from "../../dev/measure";
import { refreshCode, useCodegen } from "../../dev/codegen";
import { AGENT_PROMPT, AGENT_TOOLS, projectZip, shipCommands, shipScript, zipName } from "../../dev/ship";
import { downloadBytes } from "../../dev/zip";
import { SHIPPED_EVENT } from "../../home/docPrefs";
import { Badge, Button, EmptyState, cls } from "../ds";
import { DevIcon } from "../ds/dev-parts";
import { CopyButton } from "./CopyButton";
import { useReadiness } from "./useReadiness";

// "SHIP" (right column of Develop): the last mile. A button that downloads
// the project zip, the commands to run and verify it (copyable one by
// one or all together) and, for those working with an agent, the MCP tool names.
// Little text, no walls: every row is something you copy or press.

function Cmd({ command }: { command: string }) {
  return (
    <div className="group flex items-start gap-1 rounded-md bg-surface-2 py-1.5 pl-2 pr-1 ring-1 ring-inset ring-line">
      <span aria-hidden="true" className="select-none font-mono text-[12px] leading-5 text-fg-subtle">$</span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] leading-5 text-fg">{command}</code>
      <CopyButton text={command} iconOnly label={`Copy: ${command}`} />
    </div>
  );
}

const SIDES = ["top", "right", "bottom", "left"] as const;

// The redlines of the selected node: its size and position and the gaps around it, in px.
function Measurements({ m }: { m: Measurement }) {
  const rows = SIDES.filter((k) => m.toParent[k] !== null || m.toSibling[k] !== null);
  return (
    <section className="border-t border-line p-3" data-testid="measurements">
      <h3 className={`${cls.sectionTitle} mb-2`}>Measurements · {m.name}</h3>
      <p className="mb-1.5 font-mono text-[12px] text-fg">{m.width} × {m.height} at {m.x}, {m.y}</p>
      {rows.length > 0 && (
        <table className="w-full text-[12px]">
          <thead><tr className="text-left text-[11px] text-fg-subtle"><th className="font-medium">Side</th><th className="font-medium">To parent</th><th className="font-medium">To sibling</th></tr></thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k} className="font-mono tabular-nums text-fg">
                <td className="font-sans capitalize text-fg-muted">{k}</td>
                <td>{m.toParent[k] ?? "–"}</td>
                <td>{m.toSibling[k] ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ShipPanel() {
  const scene = useScene((s) => s.scene);
  const selected = useScene((s) => (s.selection.length === 1 ? s.selection[0] : null));
  const measured = scene && selected ? measureNode(scene, selected) : null;
  const r = useReadiness();
  const reactState = useCodegen((s) => s.byTarget.react);
  const [busy, setBusy] = useState<"react" | "html" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!scene) return <EmptyState icon="info" title="No document" />;
  const docName = scene.name;
  const steps = shipCommands(docName, zipName(docName, "react"));
  const fileCount = reactState.docId === scene.id ? reactState.files.length : 0;

  // The download ALWAYS regenerates: the zip must reflect the document as it is now,
  // not the last debounce (and the request costs a moment).
  const download = async (target: "react" | "html") => {
    setBusy(target);
    setError(null);
    try {
      await refreshCode(target);
      const st = useCodegen.getState().byTarget[target];
      if (st.status === "error" || st.files.length === 0) throw new Error(st.error ?? "no files generated");
      downloadBytes(zipName(docName, target), projectZip(st.files));
      // The onboarding checklist (home/CanvasOnboarding) ticks "Ship" from here.
      window.dispatchEvent(new Event(SHIPPED_EVENT));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const blockers = r?.blockers ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ship-panel">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="text-[13px] font-semibold text-fg">Ship</h2>
        <span className="ml-auto" />
        {r && (blockers > 0 ? <Badge tone="warn">{blockers} to fix</Badge> : <Badge tone="ok">Ready</Badge>)}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="flex flex-col gap-2 p-3">
          <Button variant="primary" icon="download" className="h-8 w-full" isDisabled={busy !== null || (r?.screens.length ?? 0) === 0} onPress={() => void download("react")}>
            {busy === "react" ? "Preparing the zip…" : zipName(docName, "react")}
          </Button>
          <p className="text-[12px] leading-snug text-fg-subtle">
            Vite + React + Tailwind project{fileCount > 0 ? `, ${fileCount} files` : ""}, with routes, navigation and e2e flow tests.
          </p>
          {blockers > 0 && (
            <p className="rounded-md bg-warn-soft px-2 py-1.5 text-[12px] leading-snug text-warn">
              With {blockers} {blockers === 1 ? "open issue" : "open issues"} the zip is still generated, but routes and tests may be incomplete.
            </p>
          )}
          {error && <p role="alert" className="rounded-md bg-danger-soft px-2 py-1.5 text-[12px] leading-snug text-danger">Export failed: {error}</p>}
          <button
            type="button"
            disabled={busy !== null || (r?.screens.length ?? 0) === 0}
            onClick={() => void download("html")}
            className="self-start rounded text-[12px] text-accent outline-none hover:underline focus-visible:shadow-[var(--ring)] disabled:opacity-40"
          >
            {busy === "html" ? "Preparing the zip…" : `or ${zipName(docName, "html")} (HTML only)`}
          </button>
        </section>

        {measured && <Measurements m={measured} />}

        <section className="border-t border-line p-3">
          <div className="mb-2 flex items-center">
            <h3 className={`${cls.sectionTitle} flex items-center gap-1.5`}><DevIcon name="terminal" size={12} />From the terminal</h3>
            <span className="ml-auto" />
            <CopyButton text={() => shipScript(steps)} label="Copy all" />
          </div>
          <ol className="flex flex-col gap-2.5">
            {steps.map((s, i) => (
              <li key={s.id}>
                <p className="mb-1 flex items-baseline gap-1.5 text-[12px]">
                  <span className="font-semibold tabular-nums text-fg-subtle">{i + 1}</span>
                  <span className="font-medium text-fg">{s.title}</span>
                </p>
                <Cmd command={s.command} />
                <p className="mt-0.5 text-[11px] leading-snug text-fg-subtle">{s.hint}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-line p-3">
          <div className="mb-2 flex items-center">
            <h3 className={`${cls.sectionTitle} flex items-center gap-1.5`}><DevIcon name="robot" size={12} />For agents</h3>
            <span className="ml-auto" />
            <CopyButton text={AGENT_PROMPT} label="Copy the instructions" />
          </div>
          <ul className="flex flex-col gap-1">
            {AGENT_TOOLS.map((t) => (
              <li key={t.name} className="flex items-center gap-1 rounded-md bg-surface-2 py-1 pl-2 pr-1 ring-1 ring-inset ring-line">
                <div className="min-w-0 flex-1">
                  <code className="font-mono text-[12px] text-fg">{t.name}</code>
                  <p className="truncate text-[11px] text-fg-subtle" title={t.hint}>{t.hint}</p>
                </div>
                <CopyButton text={t.name} iconOnly label={`Copy ${t.name}`} />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-snug text-fg-subtle">
            From the command line: <code className="font-mono text-fg-muted">opendesigner flow tasks -doc …</code> lists what is left to build.
          </p>
        </section>
      </div>
    </div>
  );
}
