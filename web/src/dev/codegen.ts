import { useEffect } from "react";
import { create } from "zustand";
import { docClient } from "../rpc/client";
import { useScene } from "../store/store";

// THE GENERATED CODE, client side: asks the server for `ExportCode` (the same
// implementation as CLI and MCP, internal/codegen) and keeps the last result in
// a store, per target. Nothing is generated here: the server is the only source.
//
// Cost: generation runs on the server on every request, so (a) it starts only
// while Develop mode is mounted, (b) it is DEBOUNCED on the CONFIRMED
// document (not on the optimistic one: the server generates from what it has, and
// asking before it has received the op would give already-stale code), (c) never with a
// gesture open (a drag changes nodes at every pixel) and (d) the in-flight request
// is CANCELLED (AbortController) when a new one starts or on exit.

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
/** Replaces the transport (tests inject a fake server). With no arguments it restores. */
export function setCodeFetcher(f?: CodeFetcher): void {
  fetcher = f ?? defaultFetcher;
}

export interface TargetState {
  files: CodeFile[];
  warnings: string[];
  status: "idle" | "loading" | "error";
  error: string | null;
  /** The document the files refer to (do not show another one's code). */
  docId: string | null;
}

const EMPTY: TargetState = { files: [], warnings: [], status: "idle", error: null, docId: null };

export interface CodegenState {
  byTarget: Record<CodeTarget, TargetState>;
}

export const useCodegen = create<CodegenState>(() => ({ byTarget: { react: EMPTY, html: EMPTY } }));

/** Empties the store (document change, tests). */
export function resetCodegen(): void {
  useCodegen.setState({ byTarget: { react: EMPTY, html: EMPTY } });
}

function patch(target: CodeTarget, p: Partial<TargetState>): void {
  useCodegen.setState((s) => ({ byTarget: { ...s.byTarget, [target]: { ...s.byTarget[target], ...p } } }));
}

const inflight = new Map<CodeTarget, AbortController>();

/** Cancels the in-flight request of a target (or of all). */
export function cancelCodegen(target?: CodeTarget): void {
  for (const [t, c] of inflight) {
    if (target === undefined || t === target) {
      c.abort();
      inflight.delete(t);
    }
  }
}

/** A request: cancels the previous one of the same target; an old response never overwrites the new one. */
export async function refreshCode(target: CodeTarget): Promise<void> {
  const scene = useScene.getState().scene;
  if (!scene) return;
  cancelCodegen(target);
  const ctl = new AbortController();
  inflight.set(target, ctl);
  // Document changed: the old files are not even shown in the meantime.
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
 * Keeps the code of the `targets` up to date while mounted (enabled): requests
 * right away and then on every change of the CONFIRMED document that can change the code
 * -- nodes, flows, transitions, components, pages. Unmounted: cancels everything.
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
    // A just-requested target (e.g. Preview turned on) gets its fetch right away;
    // those already warm are not redone if the document has not changed.
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

// --- FILES: groups, decoding, search -----------------------------------------

export type FileGroupId = "screens" | "app" | "config" | "tests" | "assets";

export const FILE_GROUP_LABELS: Record<FileGroupId, string> = {
  screens: "Screens",
  app: "App",
  config: "Configuration",
  tests: "Test",
  assets: "Assets",
};
const GROUP_ORDER: FileGroupId[] = ["screens", "app", "config", "tests", "assets"];

const CONFIG_FILES = new Set(["package.json", "vite.config.ts", "tsconfig.json", "playwright.config.ts", ".gitignore"]);

/** Which group a generated file belongs to (react and html targets). */
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
/** A file's text (memoized per file); "" for binaries. */
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
 * A screen's file: every screen file carries `data-node-id="<id>"` on its own
 * root element (the design <-> code link of the generator), so the right
 * file is the one containing the frame's id -- without replicating client-side
 * the naming rule (PascalCase, accents, numbered duplicates) of internal/codegen.
 */
export function fileForNode(files: readonly CodeFile[], target: CodeTarget, nodeId: string): CodeFile | undefined {
  const needle = `data-node-id="${nodeId}"`;
  return files.find((f) => groupOf(f.path, target) === "screens" && textOf(f).includes(needle));
}

/** The screen node's id of a file (the first data-node-id: the root). */
export function nodeIdOfFile(f: CodeFile): string | null {
  const m = /data-node-id="([^"]+)"/.exec(textOf(f));
  return m ? m[1] : null;
}
