import { useState } from "react";
import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { EXAMPLE_PLUGIN, loadPlugins, parsePlugin, savePlugins, type Plugin } from "@/plugins/manifest";
import { runPlugin } from "@/plugins/run";
import { exampleWasmPlugin } from "@/plugins/wasmExample";
import { Button, cls, EmptyState } from "@/ui/ds";

// PLUGINS (document menu → Plugins…): small scripts that edit the document through a narrow API, run in
// a sandbox with no network. They are installed in THIS browser (a JSON file or pasted text), shown
// with the permissions they ask for, and every run is one undo step.

export function PluginsDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tx } = useT();
  const [plugins, setPlugins] = useState<Plugin[]>(loadPlugins);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const store = (next: Plugin[]) => { setPlugins(next); savePlugins(next); };

  const install = (source: string) => {
    const r = parsePlugin(source);
    if ("error" in r) { setError(r.error); return; }
    setError(null);
    store([...plugins, r.plugin]);
    setText("");
    setStatus(t("Installed {name}.", { name: r.plugin.name }));
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    install(await file.text());
  };

  const run = async (p: Plugin) => {
    setRunning(p.id);
    setStatus(null);
    setError(null);
    const notes: string[] = [];
    const result = await runPlugin(p, { notify: (m) => notes.push(m) });
    setRunning(null);
    if (result.ok) setStatus(notes.length > 0 ? notes.join(" ") : t("{name} finished.", { name: p.name }));
    else setError(`${p.name}: ${result.error}`);
  };

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[560px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Plugins")} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{t("Plugins")}</h2>
          <p className="text-fg-subtle">
            {t("A plugin is a small script that reads and edits the document through a fixed set of calls. It runs in a sandbox with no network and no access to anything else in the editor; each run is one undo step, and nothing is kept if it fails. Only install plugins you trust.")}
          </p>

          {plugins.length === 0 ? (
            <EmptyState icon="code" title={t("No plugins yet")} hint={t("Install one from a file or paste its JSON below.")} />
          ) : (
            <ul aria-label={t("Installed plugins")} className="flex flex-col gap-1">
              {plugins.map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.name} <span className="font-normal text-fg-subtle">{p.version}</span></span>
                    <span className="block truncate text-[11px] text-fg-subtle">
                      {p.wasm !== undefined ? "WebAssembly · " : ""}{p.description || t("No description.")} · {t("can {permissions}", { permissions: p.permissions.map((x) => tx(x)).join(` ${t("and")} `) })}
                    </span>
                  </span>
                  <Button isDisabled={running !== null} onPress={() => void run(p)} aria-label={t("Run {name}", { name: p.name })}>{running === p.id ? t("Running…") : t("Run")}</Button>
                  <button type="button" aria-label={t("Remove {name}", { name: p.name })} className="text-fg-subtle hover:text-danger" onClick={() => store(plugins.filter((q) => q.id !== p.id))}>×</button>
                </li>
              ))}
            </ul>
          )}

          <textarea
            aria-label={t("Plugin JSON")} className={`${cls.input} h-28 font-mono text-[12px]`} value={text} spellCheck={false}
            placeholder='{ "name": "…", "permissions": ["read", "write"], "code": "…" }'
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" isDisabled={text.trim() === ""} onPress={() => install(text)}>{t("Install")}</Button>
            <label className="cursor-pointer rounded-md px-2 py-1 text-fg-muted hover:bg-surface-3">
              {t("From a file…")}
              <input type="file" accept=".json,application/json" aria-label={t("Plugin file")} className="hidden" onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            <button type="button" className="rounded-md px-2 py-1 text-fg-muted hover:bg-surface-3" onClick={() => setText(JSON.stringify(EXAMPLE_PLUGIN, null, 2))}>
              {t("Show an example")}
            </button>
            <button type="button" className="rounded-md px-2 py-1 text-fg-muted hover:bg-surface-3" onClick={() => setText(JSON.stringify(exampleWasmPlugin(), null, 2))}>
              {t("Show a WebAssembly example")}
            </button>
          </div>

          <details className="text-fg-subtle">
            <summary className="cursor-pointer">{t("What a plugin can call")}</summary>
            <p className="mt-1 leading-snug">
              <code>read</code>: <code>od.selection()</code>, <code>od.getNode(id)</code>, <code>od.listNodes(parentId?)</code>, <code>od.page()</code>.{" "}
              <code>write</code>: <code>od.createRect / createEllipse / createFrame({"{x, y, width, height, fill, name, parentId}"})</code>,{" "}
              <code>od.createText({"{text, fontSize, x, y}"})</code>, <code>od.setProps(id, {"{x, y, width, height, rotation, opacity, name, visible, fill}"})</code>,{" "}
              <code>od.deleteNode(id)</code>, <code>od.select(ids)</code>. Always: <code>od.notify(message)</code>. Colors are {"{r, g, b, a}"} from 0 to 1.
            </p>
          </details>

          {status && <p role="status" className="text-ok">{status}</p>}
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-end border-t border-line pt-3"><Button onPress={() => onOpenChange(false)}>{t("Done")}</Button></div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
