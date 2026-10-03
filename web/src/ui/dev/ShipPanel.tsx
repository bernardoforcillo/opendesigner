import { useState } from "react";
import { useScene } from "../../store/store";
import { refreshCode, useCodegen } from "../../dev/codegen";
import { AGENT_PROMPT, AGENT_TOOLS, projectZip, shipCommands, shipScript, zipName } from "../../dev/ship";
import { downloadBytes } from "../../dev/zip";
import { Badge, Button, EmptyState, cls } from "../ds";
import { DevIcon } from "../ds/dev-parts";
import { CopyButton } from "./CopyButton";
import { useReadiness } from "./useReadiness";

// "SPEDISCI" (colonna destra di Sviluppo): l'ultimo metro. Un pulsante che scarica
// lo zip del progetto, i comandi per farlo girare e verificarlo (copiabili uno a
// uno o tutti insieme) e, per chi lavora con un agente, i nomi dei tool MCP.
// Poco testo, niente muri: ogni riga è qualcosa che si copia o si preme.

function Cmd({ command }: { command: string }) {
  return (
    <div className="group flex items-start gap-1 rounded-md bg-surface-2 py-1.5 pl-2 pr-1 ring-1 ring-inset ring-line">
      <span aria-hidden="true" className="select-none font-mono text-[12px] leading-5 text-fg-subtle">$</span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] leading-5 text-fg">{command}</code>
      <CopyButton text={command} iconOnly label={`Copia: ${command}`} />
    </div>
  );
}

export function ShipPanel() {
  const scene = useScene((s) => s.scene);
  const r = useReadiness();
  const reactState = useCodegen((s) => s.byTarget.react);
  const [busy, setBusy] = useState<"react" | "html" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!scene) return <EmptyState icon="info" title="Nessun documento" />;
  const docName = scene.name;
  const steps = shipCommands(docName, zipName(docName, "react"));
  const fileCount = reactState.docId === scene.id ? reactState.files.length : 0;

  // Il download rigenera SEMPRE: lo zip deve riflettere il documento di adesso,
  // non l'ultimo debounce (e la richiesta costa un attimo).
  const download = async (target: "react" | "html") => {
    setBusy(target);
    setError(null);
    try {
      await refreshCode(target);
      const st = useCodegen.getState().byTarget[target];
      if (st.status === "error" || st.files.length === 0) throw new Error(st.error ?? "nessun file generato");
      downloadBytes(zipName(docName, target), projectZip(st.files));
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
        <h2 className="text-[13px] font-semibold text-fg">Spedisci</h2>
        <span className="ml-auto" />
        {r && (blockers > 0 ? <Badge tone="warn">{blockers} da sistemare</Badge> : <Badge tone="ok">Pronto</Badge>)}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="flex flex-col gap-2 p-3">
          <Button variant="primary" icon="download" className="h-8 w-full" isDisabled={busy !== null || (r?.screens.length ?? 0) === 0} onPress={() => void download("react")}>
            {busy === "react" ? "Preparo lo zip…" : zipName(docName, "react")}
          </Button>
          <p className="text-[12px] leading-snug text-fg-subtle">
            Progetto Vite + React + Tailwind{fileCount > 0 ? `, ${fileCount} file` : ""}, con rotte, navigazione e test e2e dei flussi.
          </p>
          {blockers > 0 && (
            <p className="rounded-md bg-warn-soft px-2 py-1.5 text-[12px] leading-snug text-warn">
              Con {blockers} {blockers === 1 ? "punto aperto" : "punti aperti"} lo zip si genera lo stesso, ma rotte e test possono essere incompleti.
            </p>
          )}
          {error && <p role="alert" className="rounded-md bg-danger-soft px-2 py-1.5 text-[12px] leading-snug text-danger">Export non riuscito: {error}</p>}
          <button
            type="button"
            disabled={busy !== null || (r?.screens.length ?? 0) === 0}
            onClick={() => void download("html")}
            className="self-start rounded text-[12px] text-accent outline-none hover:underline focus-visible:shadow-[var(--ring)] disabled:opacity-40"
          >
            {busy === "html" ? "Preparo lo zip…" : `oppure ${zipName(docName, "html")} (solo HTML)`}
          </button>
        </section>

        <section className="border-t border-line p-3">
          <div className="mb-2 flex items-center">
            <h3 className={`${cls.sectionTitle} flex items-center gap-1.5`}><DevIcon name="terminal" size={12} />Dal terminale</h3>
            <span className="ml-auto" />
            <CopyButton text={() => shipScript(steps)} label="Copia tutto" />
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
            <h3 className={`${cls.sectionTitle} flex items-center gap-1.5`}><DevIcon name="robot" size={12} />Per gli agenti</h3>
            <span className="ml-auto" />
            <CopyButton text={AGENT_PROMPT} label="Copia le istruzioni" />
          </div>
          <ul className="flex flex-col gap-1">
            {AGENT_TOOLS.map((t) => (
              <li key={t.name} className="flex items-center gap-1 rounded-md bg-surface-2 py-1 pl-2 pr-1 ring-1 ring-inset ring-line">
                <div className="min-w-0 flex-1">
                  <code className="font-mono text-[12px] text-fg">{t.name}</code>
                  <p className="truncate text-[11px] text-fg-subtle" title={t.hint}>{t.hint}</p>
                </div>
                <CopyButton text={t.name} iconOnly label={`Copia ${t.name}`} />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-snug text-fg-subtle">
            Da riga di comando: <code className="font-mono text-fg-muted">opendesigner flow tasks -doc …</code> elenca cosa resta da costruire.
          </p>
        </section>
      </div>
    </div>
  );
}
