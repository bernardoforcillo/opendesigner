import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Button as RacButton, Radio, RadioGroup, ToggleButton } from "react-aria-components";
import { useScene } from "../../store/store";
import { useFlowAnalysis } from "../../flow/analysis";
import { screenOf } from "../../flow/screens";
import {
  fileForNode, groupFiles, isBinaryPath, nodeIdOfFile, refreshCode, textOf, useCodeExport, useCodegen,
  type CodeFile, type CodeTarget,
} from "../../dev/codegen";
import { highlight, langOf, type TokenKind } from "../../dev/highlight";
import { PREVIEW_MSG, previewDoc, resolvePreviewHref } from "../../dev/preview";
import { Badge, Button, EmptyState, Icon } from "../ds";
import { SEGMENT, SEGMENTED_TRACK } from "../ds/flow-parts";
import { DevIcon } from "../ds/dev-parts";
import { CopyButton } from "./CopyButton";
import { PipelineStepper } from "./PipelineStepper";
import { selectScreen, useReadiness } from "./useReadiness";

// LA VISTA CODICE (centro di Sviluppo): albero dei file generati, codice in sola
// lettura con evidenziazione, e -- a richiesta -- l'anteprima della stessa
// schermata (target HTML) in un iframe accanto, per confrontare disegno e output.
//
// Il codice viene dal server (ExportCode, dev/codegen.ts): qui si mostra. La
// schermata selezionata nel documento seleziona il suo file e viceversa (il file
// di una schermata porta `data-node-id` = l'id del frame).

const TOKEN_CLS: Record<TokenKind, string> = {
  plain: "",
  kw: "text-flow",
  str: "text-ok",
  com: "italic text-fg-subtle",
  tag: "text-accent",
  attr: "text-warn",
  num: "text-warn",
  fn: "text-accent",
  type: "font-medium text-fg",
};

// Un file molto lungo non si monta tutto insieme (decine di migliaia di <span>):
// le prime righe subito, il resto a richiesta.
const MAX_LINES = 1500;

const TARGETS: readonly { id: CodeTarget; label: string }[] = [
  { id: "react", label: "React + Tailwind" },
  { id: "html", label: "HTML" },
];

// --- albero dei file ---------------------------------------------------------

function FileTree({
  files, target, selected, onPick,
}: { files: readonly CodeFile[]; target: CodeTarget; selected: string; onPick: (f: CodeFile) => void }) {
  const groups = useMemo(() => groupFiles(files, target), [files, target]);
  return (
    <nav aria-label="File generati" className="flex min-h-0 w-52 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface-2 pb-16 pt-1">
      {groups.map((g) => (
        <section key={g.id} aria-label={g.label} className="pb-1">
          <h3 className="flex h-6 items-center gap-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">
            <DevIcon name="folder" size={12} />
            {g.label}
            <span className="font-normal tabular-nums">{g.files.length}</span>
          </h3>
          {g.files.map((f) => {
            const on = f.path === selected;
            const name = f.path.slice(f.path.lastIndexOf("/") + 1);
            return (
              <RacButton
                key={f.path}
                onPress={() => onPick(f)}
                aria-current={on ? "true" : undefined}
                aria-label={f.path}
                className={`flex h-7 w-full items-center gap-1.5 px-3 text-left text-[13px] outline-none ` +
                  `focus-visible:shadow-[var(--ring)] ${on ? "bg-accent-soft font-medium text-accent" : "text-fg-muted hover:bg-surface-3 hover:text-fg"}`}
              >
                <DevIcon name="file" size={13} className="shrink-0 opacity-70" />
                <span className="truncate" title={f.path}>{name}</span>
              </RacButton>
            );
          })}
        </section>
      ))}
    </nav>
  );
}

// --- codice ------------------------------------------------------------------

const CodeLines = memo(function CodeLines({ file, showAll }: { file: CodeFile; showAll: boolean }) {
  const text = textOf(file);
  const lines = useMemo(() => highlight(text, langOf(file.path)), [text, file.path]);
  const shown = showAll ? lines : lines.slice(0, MAX_LINES);
  const gutter = useMemo(() => shown.map((_, i) => i + 1).join("\n"), [shown.length]);
  return (
    <div className="flex min-w-max font-mono text-[12px] leading-5">
      <pre aria-hidden="true" className="sticky left-0 select-none bg-surface py-2 pl-3 pr-3 text-right text-fg-subtle tabular-nums">{gutter}</pre>
      <pre className="py-2 pr-6 text-fg" data-testid="code-text">
        <code>
          {shown.map((line, i) => (
            <span key={i}>
              {line.map((t, j) => (t.k === "plain" ? t.s : <span key={j} className={TOKEN_CLS[t.k]}>{t.s}</span>))}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
});

function CodeView({ file }: { file: CodeFile }) {
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [file.path]);
  const binary = isBinaryPath(file.path);
  const text = binary ? "" : textOf(file);
  const total = useMemo(() => (binary ? 0 : text.split("\n").length), [binary, text]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 truncate font-mono text-[12px] text-fg-muted" title={file.path}>{file.path}</span>
        {!binary && <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-fg-subtle">{total} righe</span>}
        <span className="ml-auto" />
        {!binary && <CopyButton text={text} label="Copia il codice" doneLabel="Copiato" />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-surface pb-16" tabIndex={0} aria-label={`Codice di ${file.path}`}>
        {binary ? (
          <EmptyState icon="image" title="File binario" hint={`${(file.bytes.length / 1024).toFixed(1)} KB: finisce nello zip, qui non si mostra.`} />
        ) : (
          <>
            <CodeLines file={file} showAll={showAll} />
            {!showAll && total > MAX_LINES && (
              <div className="border-t border-line p-2 text-center">
                <Button variant="secondary" onPress={() => setShowAll(true)}>Mostra tutte le {total} righe</Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- anteprima ---------------------------------------------------------------

function Preview({ files, path, onNavigate }: { files: readonly CodeFile[]; path: string | null; onNavigate: (path: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const doc = useMemo(() => (path ? previewDoc(files, path) : null), [files, path]);
  // Un click su un link dentro la schermata chiede alla madre di mostrare l'altra.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const href = (e.data as Record<string, unknown> | null)?.[PREVIEW_MSG];
      if (typeof href !== "string") return;
      const to = resolvePreviewHref(files, href);
      if (to) onNavigate(to);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [files, onNavigate]);
  return (
    <section aria-label="Anteprima" className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-line bg-canvas">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <Icon name="eye" size={13} className="text-fg-subtle" />
        <span className="text-[12px] font-medium text-fg-muted">Anteprima</span>
        {path && <span className="min-w-0 truncate font-mono text-[11px] text-fg-subtle">{path}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {doc ? (
          <iframe
            ref={frame}
            title="Anteprima della schermata generata"
            srcDoc={doc}
            sandbox="allow-scripts"
            // `light`: la schermata generata ha il suo sfondo e non deve ereditare il tema dell'editor.
            style={{ colorScheme: "light" }}
            className="h-full min-h-[320px] w-full rounded-md border border-line shadow-sm"
          />
        ) : (
          <EmptyState icon="eye" title="Nessuna schermata da mostrare" hint="Seleziona una schermata o attendi la generazione." />
        )}
      </div>
    </section>
  );
}

// --- la vista ----------------------------------------------------------------

const PREVIEW_KEY = "od.devPreview";
const TARGET_KEY = "od.devTarget";

function readStored<T extends string>(key: string, ok: readonly T[], dflt: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && ok.includes(v) ? v : dflt;
  } catch { return dflt; }
}
function store(key: string, v: string): void {
  try { localStorage.setItem(key, v); } catch { /* niente storage */ }
}

export function CodeWorkbench() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const readiness = useReadiness();
  const [target, setTargetState] = useState<CodeTarget>(() => readStored(TARGET_KEY, ["react", "html"] as const, "react"));
  const [preview, setPreviewState] = useState(() => readStored(PREVIEW_KEY, ["on", "off"] as const, "off") === "on");
  const setTarget = (t: CodeTarget) => { setTargetState(t); store(TARGET_KEY, t); };
  const setPreview = (v: boolean) => { setPreviewState(v); store(PREVIEW_KEY, v ? "on" : "off"); };

  // Montata SOLO in modalità Sviluppo (App): è qui che si accendono l'analisi dei
  // flussi (per la checklist) e la generazione del codice. Smontando, si fermano
  // e annullano la richiesta in volo -- fuori da Sviluppo non si fa lavoro.
  useFlowAnalysis(true);
  useCodeExport(true, preview ? [target, "html"] : [target]);

  const code = useCodegen((s) => s.byTarget[target]);
  const html = useCodegen((s) => s.byTarget.html);
  const files = code.docId === scene?.id ? code.files : EMPTY_FILES;
  const htmlFiles = html.docId === scene?.id ? html.files : EMPTY_FILES;

  // La schermata selezionata nel documento (l'antenato-o-sé di primo livello).
  const screenId = useMemo(() => {
    if (!scene || selection.length === 0) return null;
    return screenOf(scene, selection[0])?.id ?? null;
  }, [scene, selection]);

  // Il file scelto a mano vale finché non cambia la selezione nel documento.
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [screenId]);
  const effective = useMemo<CodeFile | null>(() => {
    const manual = picked ? files.find((f) => f.path === picked) : undefined;
    if (manual) return manual;
    const forScreen = screenId ? fileForNode(files, target, screenId) : undefined;
    if (forScreen) return forScreen;
    return groupFiles(files, target)[0]?.files[0] ?? null;
  }, [files, picked, screenId, target]);

  const pick = (f: CodeFile) => {
    setPicked(f.path);
    // Un file di schermata seleziona anche la schermata nel documento: design e codice restano allineati.
    const id = nodeIdOfFile(f);
    if (scene && id && scene.nodes.has(id)) {
      const sc = screenOf(scene, id);
      if (sc && sc.id === id) selectScreen(scene, id);
    }
  };

  // Anteprima: il file HTML della schermata selezionata (navigabile dai link), altrimenti index.html.
  const [navPath, setNavPath] = useState<string | null>(null);
  useEffect(() => setNavPath(null), [screenId]);
  const previewPath = useMemo(() => {
    if (!preview) return null;
    if (navPath && htmlFiles.some((f) => f.path === navPath)) return navPath;
    const f = screenId ? fileForNode(htmlFiles, "html", screenId) : undefined;
    return f?.path ?? htmlFiles.find((x) => x.path === "index.html")?.path ?? htmlFiles.find((x) => x.path.endsWith(".html"))?.path ?? null;
  }, [preview, navPath, htmlFiles, screenId]);
  const onNavigate = (p: string) => {
    setNavPath(p);
    const f = htmlFiles.find((x) => x.path === p);
    const id = f ? nodeIdOfFile(f) : null;
    if (scene && id && scene.nodes.has(id)) selectScreen(scene, id);
  };

  const noScreens = !!readiness && readiness.screens.length === 0;
  const loading = code.status === "loading";

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-surface" data-testid="code-workbench">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-2">
        <PipelineStepper />
        <span className="ml-auto" />
        {loading && <span className="flex items-center gap-1.5 text-[12px] text-fg-subtle" role="status"><Icon name="rotate" size={12} className="animate-spin" />Genero il codice…</span>}
        {code.warnings.length > 0 && !loading && <Badge tone="warn">{code.warnings.length} avvisi</Badge>}
        <RadioGroup aria-label="Target" orientation="horizontal" value={target} onChange={(v) => setTarget(v as CodeTarget)} className={SEGMENTED_TRACK}>
          {TARGETS.map((t) => (
            <Radio key={t.id} value={t.id} className={SEGMENT}>{t.label}</Radio>
          ))}
        </RadioGroup>
        <ToggleButton
          isSelected={preview}
          onChange={setPreview}
          aria-label="Anteprima"
          className={({ isSelected }) =>
            `flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium outline-none focus-visible:shadow-[var(--ring)] ` +
            (isSelected ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg")
          }
        >
          <DevIcon name="split" size={14} />
          Anteprima
        </ToggleButton>
      </div>

      {code.warnings.length > 0 && <Warnings items={code.warnings} />}

      <div className="flex min-h-0 flex-1">
        {noScreens && files.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon="code" title="Niente da esportare, per ora" hint="Disegna almeno una schermata (un frame): il codice compare qui, e si aggiorna mentre lavori." />
          </div>
        ) : code.status === "error" && files.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon="warning"
              title="Non riesco a generare il codice"
              hint={code.error ?? undefined}
              action={<Button variant="secondary" icon="rotate" onPress={() => void refreshCode(target)}>Riprova</Button>}
            />
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-fg-subtle" role="status">Genero il codice…</div>
        ) : (
          <>
            <FileTree files={files} target={target} selected={effective?.path ?? ""} onPick={pick} />
            {effective && <CodeView file={effective} />}
            {preview && <Preview files={htmlFiles} path={previewPath} onNavigate={onNavigate} />}
          </>
        )}
      </div>
      {code.status === "error" && files.length > 0 && (
        <div role="alert" className="flex items-center gap-2 border-t border-line bg-danger-soft px-3 py-1 text-[12px] text-danger">
          <Icon name="warning" size={13} />
          Aggiornamento non riuscito ({code.error}): si vede l'ultima versione generata.
          <Button variant="ghost" className="ml-auto h-6 text-danger" onPress={() => void refreshCode(target)}>Riprova</Button>
        </div>
      )}
    </div>
  );
}

const EMPTY_FILES: CodeFile[] = [];

function Warnings({ items }: { items: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0 border-b border-line bg-warn-soft text-[12px] text-warn">
      <RacButton onPress={() => setOpen(!open)} aria-expanded={open} className="flex h-6 w-full items-center gap-1.5 px-3 text-left font-medium outline-none focus-visible:shadow-[var(--ring)]">
        <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />
        Il generatore ha segnalato {items.length} {items.length === 1 ? "approssimazione" : "approssimazioni"}
      </RacButton>
      {open && <ul className="max-h-24 list-disc overflow-y-auto pb-1.5 pl-8 pr-3">{items.map((w, i) => <li key={i}>{w}</li>)}</ul>}
    </div>
  );
}
