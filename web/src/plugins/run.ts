import { PluginError, PluginSession } from "./api";
import type { Plugin } from "./manifest";

// RUNNING A PLUGIN. The code runs in a sandboxed <iframe> (sandbox="allow-scripts" only: an opaque
// origin, so no access to the editor, its storage or its cookies) whose CSP forbids every network
// request. The only way out is postMessage, and the only thing on the other side is
// PluginSession.call. A run ends when the script returns (its edits become ONE undo step), throws
// (nothing is kept) or takes too long (nothing is kept).

export const PLUGIN_TIMEOUT_MS = 15_000;

/** The page the sandbox loads: a message channel, `od`, and a listener that runs the code it is sent. */
export const SANDBOX_HTML = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'">
<script>
(() => {
  const pending = new Map();
  let n = 0;
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = ++n;
    pending.set(id, { resolve, reject });
    parent.postMessage({ od: 1, id, method, args }, "*");
  });
  const od = new Proxy({}, { get: (_, method) => (...args) => call(String(method), args) });
  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.od !== 2) return;
    if (m.run !== undefined) {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      Promise.resolve()
        .then(() => new AsyncFunction("od", m.run)(od))
        .then(() => parent.postMessage({ od: 1, done: true }, "*"), (err) => parent.postMessage({ od: 1, error: String((err && err.message) || err) }, "*"));
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error !== undefined) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  parent.postMessage({ od: 1, ready: true }, "*");
})();
</script>`;

/** The bit of an iframe the runner needs (so a test can stand in for it). */
export interface Frame {
  readonly window: { postMessage(message: unknown, target: string): void };
  remove(): void;
}

export function createSandboxFrame(): Frame {
  const el = document.createElement("iframe");
  el.setAttribute("sandbox", "allow-scripts");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  el.srcdoc = SANDBOX_HTML;
  document.body.appendChild(el);
  return { window: el.contentWindow as Frame["window"], remove: () => el.remove() };
}

export type RunResult = { ok: true } | { ok: false; error: string };

export function runPlugin(
  plugin: Plugin,
  opts: { notify?: (message: string) => void; timeoutMs?: number; frame?: Frame } = {},
): Promise<RunResult> {
  const frame = opts.frame ?? createSandboxFrame();
  const session = new PluginSession(plugin.permissions, opts.notify);
  return new Promise<RunResult>((resolve) => {
    let over = false;
    const end = (result: RunResult) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      if (result.ok) session.finish(); else session.abort();
      frame.remove();
      resolve(result);
    };
    const timer = setTimeout(() => end({ ok: false, error: `The plugin took longer than ${(opts.timeoutMs ?? PLUGIN_TIMEOUT_MS) / 1000} seconds and was stopped.` }), opts.timeoutMs ?? PLUGIN_TIMEOUT_MS);

    function onMessage(e: MessageEvent) {
      // Only what comes from OUR frame.
      if (e.source !== frame.window) return;
      const m = e.data as { od?: number; id?: number; method?: string; args?: unknown[]; ready?: boolean; done?: boolean; error?: string } | null;
      if (!m || m.od !== 1) return;
      if (m.ready) { frame.window.postMessage({ od: 2, run: plugin.code }, "*"); return; }
      if (m.done) { end({ ok: true }); return; }
      if (m.error !== undefined) { end({ ok: false, error: String(m.error).slice(0, 300) }); return; }
      if (typeof m.id === "number" && typeof m.method === "string") {
        try {
          const result = session.call(m.method, Array.isArray(m.args) ? m.args : []);
          frame.window.postMessage({ od: 2, id: m.id, result: result ?? null }, "*");
        } catch (err) {
          frame.window.postMessage({ od: 2, id: m.id, error: err instanceof PluginError ? err.message : "the call failed" }, "*");
        }
      }
    }
    addEventListener("message", onMessage);
  });
}
