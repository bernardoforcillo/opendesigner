import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { EXAMPLE_PLUGIN, loadPlugins, parsePlugin, savePlugins, type Plugin } from "../plugins/manifest";
import { runPlugin } from "../plugins/run";
import { Button, cls, EmptyState } from "./ds";

// PLUGINS (document menu → Plugins…): small scripts that edit the document through a narrow API, run in
// a sandbox with no network. They are installed in THIS browser (a JSON file or pasted text), shown
// with the permissions they ask for, and every run is one undo step.

export function PluginsDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
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
    setStatus(`Installed ${r.plugin.name}.`);
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
    if (result.ok) setStatus(notes.length > 0 ? notes.join(" ") : `${p.name} finished.`);
    else setError(`${p.name}: ${result.error}`);
  };

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[560px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Plugins" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Plugins</h2>
          <p className="text-fg-subtle">
            A plugin is a small script that reads and edits the document through a fixed set of calls. It runs in a sandbox with no network
            and no access to anything else in the editor; each run is one undo step, and nothing is kept if it fails. Only install plugins you trust.
          </p>

          {plugins.length === 0 ? (
            <EmptyState icon="code" title="No plugins yet" hint="Install one from a file or paste its JSON below." />
          ) : (
            <ul aria-label="Installed plugins" className="flex flex-col gap-1">
              {plugins.map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.name} <span className="font-normal text-fg-subtle">{p.version}</span></span>
                    <span className="block truncate text-[11px] text-fg-subtle">
                      {p.description || "No description."} · can {p.permissions.join(" and ")}
                    </span>
                  </span>
                  <Button isDisabled={running !== null} onPress={() => void run(p)} aria-label={`Run ${p.name}`}>{running === p.id ? "Running…" : "Run"}</Button>
                  <button type="button" aria-label={`Remove ${p.name}`} className="text-fg-subtle hover:text-danger" onClick={() => store(plugins.filter((q) => q.id !== p.id))}>×</button>
                </li>
              ))}
            </ul>
          )}

          <textarea
            aria-label="Plugin JSON" className={`${cls.input} h-28 font-mono text-[12px]`} value={text} spellCheck={false}
            placeholder='{ "name": "…", "permissions": ["read", "write"], "code": "…" }'
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" isDisabled={text.trim() === ""} onPress={() => install(text)}>Install</Button>
            <label className="cursor-pointer rounded-md px-2 py-1 text-fg-muted hover:bg-surface-3">
              From a file…
              <input type="file" accept=".json,application/json" aria-label="Plugin file" className="hidden" onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            <button type="button" className="rounded-md px-2 py-1 text-fg-muted hover:bg-surface-3" onClick={() => setText(JSON.stringify(EXAMPLE_PLUGIN, null, 2))}>
              Show an example
            </button>
          </div>

          <details className="text-fg-subtle">
            <summary className="cursor-pointer">What a plugin can call</summary>
            <p className="mt-1 leading-snug">
              <code>read</code>: <code>od.selection()</code>, <code>od.getNode(id)</code>, <code>od.listNodes(parentId?)</code>, <code>od.page()</code>.{" "}
              <code>write</code>: <code>od.createRect / createEllipse / createFrame({"{x, y, width, height, fill, name, parentId}"})</code>,{" "}
              <code>od.createText({"{text, fontSize, x, y}"})</code>, <code>od.setProps(id, {"{x, y, width, height, rotation, opacity, name, visible, fill}"})</code>,{" "}
              <code>od.deleteNode(id)</code>, <code>od.select(ids)</code>. Always: <code>od.notify(message)</code>. Colors are {"{r, g, b, a}"} from 0 to 1.
            </p>
          </details>

          {status && <p role="status" className="text-ok">{status}</p>}
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-end border-t border-line pt-3"><Button onPress={() => onOpenChange(false)}>Done</Button></div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
