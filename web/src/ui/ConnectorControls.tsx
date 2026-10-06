import { useScene } from "../store/store";
import { connectorOf } from "../vector/connector";
import { connectOps, setConnectorOps, type ConnectorOptions } from "../vector/connect";

const BTN = "h-7 flex-1 rounded-md px-2 text-[12px] text-fg-muted outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)]";

/** Connects the two selected nodes with a connector (ONE gesture); the first one selected is where it starts. */
export function runConnect(opts: ConnectorOptions = {}): void {
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene || store.selection.length !== 2) return;
  const res = connectOps(scene, store.selection[0], store.selection[1], opts);
  if (!res) return;
  store.beginGesture();
  store.setSelection(res.selection);
  store.endGesture(res.ops);
}

function runSet(opts: ConnectorOptions): void {
  const store = useScene.getState();
  const n = store.selection.length === 1 ? store.scene?.nodes.at(store.selection[0]) : undefined;
  if (!n) return;
  const ops = setConnectorOps(n, opts);
  if (ops.length === 0) return;
  store.beginGesture();
  store.endGesture(ops);
}

/**
 * Two nodes selected: "Connect". A connector selected: its route and arrowheads. The connector
 * keeps following the shapes it joins (store/connectors.ts).
 */
export function ConnectorControls() {
  const pair = useScene((s) => s.selection.length === 2 && !!s.scene && s.selection.every((id) => !!s.scene!.nodes.at(id)));
  // A string, not the spec object: a selector returning a fresh object every time never settles.
  const key = useScene((s) => {
    const n = s.selection.length === 1 ? s.scene?.nodes.at(s.selection[0]) : undefined;
    const c = n ? connectorOf(n) : null;
    return c ? `${c.route}|${c.head}` : "";
  });
  const spec = key ? { route: key.split("|")[0], head: key.split("|")[1] } : null;
  if (spec) {
    const on = (b: boolean) => (b ? "bg-surface-3 text-fg" : "");
    return (
      <div role="group" aria-label="Connector" className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-line px-2 py-1.5">
        <button type="button" aria-pressed={spec.route === "straight"} className={`${BTN} ${on(spec.route === "straight")}`} onClick={() => runSet({ route: "straight" })}>Straight</button>
        <button type="button" aria-pressed={spec.route === "elbow"} className={`${BTN} ${on(spec.route === "elbow")}`} onClick={() => runSet({ route: "elbow" })}>Elbow</button>
        <button type="button" aria-pressed={spec.head === "none"} className={`${BTN} ${on(spec.head === "none")}`} onClick={() => runSet({ head: "none" })}>No arrow</button>
        <button type="button" aria-pressed={spec.head === "end"} className={`${BTN} ${on(spec.head === "end")}`} onClick={() => runSet({ head: "end" })}>Arrow</button>
        <button type="button" aria-pressed={spec.head === "both"} className={`${BTN} ${on(spec.head === "both")}`} onClick={() => runSet({ head: "both" })}>Both</button>
      </div>
    );
  }
  if (!pair) return null;
  return (
    <div role="group" aria-label="Connect" className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5">
      <button type="button" className={BTN} onClick={() => runConnect()}>Connect with arrow</button>
      <button type="button" className={BTN} onClick={() => runConnect({ route: "elbow" })}>Elbow connector</button>
    </div>
  );
}
