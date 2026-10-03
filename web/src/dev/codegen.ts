import { useEffect } from "react";
import { create } from "zustand";
import { docClient } from "../rpc/client";
import { useScene } from "../store/store";

// IL CODICE GENERATO, lato client: chiede al server `ExportCode` (la stessa
// implementazione di CLI e MCP, internal/codegen) e tiene l'ultimo risultato in
// uno store, per target. Qui non si genera niente: il server è l'unica fonte.
//
// Costo: la generazione gira sul server a ogni richiesta, quindi (a) parte solo
// finché la modalità Sviluppo è montata, (b) è DEBOUNCED sul documento
// CONFERMATO (non su quello ottimistico: il server genera da ciò che ha, e
// chiedere prima che abbia ricevuto l'op darebbe codice già vecchio), (c) mai a
// gesto aperto (un drag cambia i nodi a ogni pixel) e (d) la richiesta in volo
// viene ANNULLATA (AbortController) quando ne parte una nuova o si esce.

export type CodeTarget = "react" | "html";

export interface CodeFile {
  path: string;
  bytes: Uint8Array;
}

export interface CodeResult {
  files: CodeFile[];
  warnings: string[];
}

export type CodeFetcher = (docId: string, target: CodeTarget, signal: AbortSignal) => Promise<CodeResult>;

const defaultFetcher: CodeFetcher = async (docId, target, signal) => {
  const r = await docClient.exportCode({ docId, target, flowId: "" }, { signal });
  return { files: r.files.map((f) => ({ path: f.path, bytes: f.content })), warnings: [...r.warnings] };
};

let fetcher: CodeFetcher = defaultFetcher;
/** Sostituisce il trasporto (i test iniettano un finto server). Senza argomenti ripristina. */
export function setCodeFetcher(f?: CodeFetcher): void {
  fetcher = f ?? defaultFetcher;
}

export interface TargetState {
  files: CodeFile[];
  warnings: string[];
  status: "idle" | "loading" | "error";
  error: string | null;
  /** Il documento a cui si riferiscono i file (non mostrare il codice di un altro). */
  docId: string | null;
}

const EMPTY: TargetState = { files: [], warnings: [], status: "idle", error: null, docId: null };

export interface CodegenState {
  byTarget: Record<CodeTarget, TargetState>;
}

export const useCodegen = create<CodegenState>(() => ({ byTarget: { react: EMPTY, html: EMPTY } }));

/** Svuota lo store (cambio documento, test). */
export function resetCodegen(): void {
  useCodegen.setState({ byTarget: { react: EMPTY, html: EMPTY } });
}

function patch(target: CodeTarget, p: Partial<TargetState>): void {
  useCodegen.setState((s) => ({ byTarget: { ...s.byTarget, [target]: { ...s.byTarget[target], ...p } } }));
}

const inflight = new Map<CodeTarget, AbortController>();

/** Annulla la richiesta in volo di un target (o di tutti). */
export function cancelCodegen(target?: CodeTarget): void {
  for (const [t, c] of inflight) {
    if (target === undefined || t === target) {
      c.abort();
      inflight.delete(t);
    }
  }
}

/** Una richiesta: annulla la precedente dello stesso target; una risposta vecchia non sovrascrive mai la nuova. */
export async function refreshCode(target: CodeTarget): Promise<void> {
  const scene = useScene.getState().scene;
  if (!scene) return;
  cancelCodegen(target);
  const ctl = new AbortController();
  inflight.set(target, ctl);
  // Cambiato documento: i file vecchi non si mostrano nemmeno nel frattempo.
  const prevDoc = useCodegen.getState().byTarget[target].docId;
  patch(target, { status: "loading", error: null, ...(prevDoc !== null && prevDoc !== scene.id ? { files: [], warnings: [], docId: null } : {}) });
  try {
    const r = await fetcher(scene.id, target, ctl.signal);
    if (ctl.signal.aborted) return;
    inflight.delete(target);
    patch(target, { files: r.files, warnings: r.warnings, status: "idle", error: null, docId: scene.id });
  } catch (err) {
    if (ctl.signal.aborted) return;
    inflight.delete(target);
    patch(target, { status: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

export const CODEGEN_DEBOUNCE_MS = 600;

/**
 * Tiene aggiornato il codice dei `targets` finché è montato (enabled): richiede
 * subito e poi a ogni cambio del documento CONFERMATO che può cambiare il codice
 * -- nodi, flussi, transizioni, componenti, pagine. Smontato: annulla tutto.
 */
export function useCodeExport(enabled: boolean, targets: readonly CodeTarget[]): void {
  const key = targets.join(",");
  useEffect(() => {
    if (!enabled) return;
    const wanted = key.split(",").filter(Boolean) as CodeTarget[];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (useScene.getState().gesture) return schedule(CODEGEN_DEBOUNCE_MS);
        for (const t of wanted) void refreshCode(t);
      }, delay);
    };
    // Un target appena richiesto (es. Anteprima accesa) ha subito il suo fetch;
    // quelli già caldi non si rifanno se il documento non è cambiato.
    const stale = wanted.some((t) => useCodegen.getState().byTarget[t].docId !== useScene.getState().scene?.id);
    schedule(stale ? 0 : CODEGEN_DEBOUNCE_MS);
    const unsub = useScene.subscribe((st, prev) => {
      const a = st.confirmed;
      const b = prev.confirmed;
      if (!a) return;
      if (!b || a.nodes !== b.nodes || a.flows !== b.flows || a.transitions !== b.transitions || a.components !== b.components || a.pages !== b.pages) {
        schedule(CODEGEN_DEBOUNCE_MS);
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
      for (const t of wanted) cancelCodegen(t);
    };
  }, [enabled, key]);
}

// --- FILE: gruppi, decodifica, ricerca ---------------------------------------

export type FileGroupId = "screens" | "app" | "config" | "tests" | "assets";

export const FILE_GROUP_LABELS: Record<FileGroupId, string> = {
  screens: "Schermate",
  app: "App",
  config: "Configurazione",
  tests: "Test",
  assets: "Risorse",
};
const GROUP_ORDER: FileGroupId[] = ["screens", "app", "config", "tests", "assets"];

const CONFIG_FILES = new Set(["package.json", "vite.config.ts", "tsconfig.json", "playwright.config.ts", ".gitignore"]);

/** A quale gruppo appartiene un file generato (target react e html). */
export function groupOf(path: string, target: CodeTarget): FileGroupId {
  if (path.startsWith("tests/")) return "tests";
  if (path.startsWith("public/") || path.startsWith("assets/")) return "assets";
  if (path.startsWith("src/screens/")) return "screens";
  if (target === "html" && path.endsWith(".html")) return "screens";
  if (CONFIG_FILES.has(path)) return "config";
  return "app";
}

export interface FileGroup {
  id: FileGroupId;
  label: string;
  files: CodeFile[];
}

export function groupFiles(files: readonly CodeFile[], target: CodeTarget): FileGroup[] {
  const by = new Map<FileGroupId, CodeFile[]>();
  for (const f of files) {
    const g = groupOf(f.path, target);
    by.set(g, [...(by.get(g) ?? []), f]);
  }
  return GROUP_ORDER.filter((g) => by.has(g)).map((id) => ({
    id,
    label: FILE_GROUP_LABELS[id],
    files: by.get(id)!.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  }));
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)$/i;
export const isBinaryPath = (p: string) => BINARY_EXT.test(p);

const decoded = new WeakMap<CodeFile, string>();
const TD = new TextDecoder("utf-8");
/** Il testo di un file (memoizzato per file); "" per i binari. */
export function textOf(f: CodeFile): string {
  if (isBinaryPath(f.path)) return "";
  let t = decoded.get(f);
  if (t === undefined) {
    t = TD.decode(f.bytes);
    decoded.set(f, t);
  }
  return t;
}

/**
 * Il file di una schermata: ogni file di schermata porta `data-node-id="<id>"` sul
 * proprio elemento radice (il legame design <-> codice del generatore), quindi il
 * file giusto è quello che contiene l'id del frame -- senza replicare client-side
 * la regola dei nomi (PascalCase, accenti, duplicati numerati) di internal/codegen.
 */
export function fileForNode(files: readonly CodeFile[], target: CodeTarget, nodeId: string): CodeFile | undefined {
  const needle = `data-node-id="${nodeId}"`;
  return files.find((f) => groupOf(f.path, target) === "screens" && textOf(f).includes(needle));
}

/** L'id del nodo-schermata di un file (il primo data-node-id: la radice). */
export function nodeIdOfFile(f: CodeFile): string | null {
  const m = /data-node-id="([^"]+)"/.exec(textOf(f));
  return m ? m[1] : null;
}
