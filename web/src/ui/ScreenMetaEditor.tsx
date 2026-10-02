import { useScene } from "../store/store";
import { FLOW_KINDS, FLOW_KIND_LABELS, META_KEYS, STATUSES, STATUS_LABELS, STATUS_COLORS, kindOf, metaValue, statusOf } from "../flow/meta";
import { setMetaOp, submit } from "../flow/commands";
import { layerDisplayName } from "./LayersPanel";
import { CommitField } from "./fields/CommitField";

// L'EDITOR DEI METADATI DI SCHERMATA (modalità Flussi, colonna destra). Scrive
// Node.meta: tipo nel flusso, route e componente del codice, id e testo del test,
// stato di avanzamento. Sono ciò che CLI e MCP leggono per generare spec e test.
//
// La mask "meta" di setProps SOSTITUISCE l'intera mappa: setMetaOp legge la mappa
// corrente e riscrive TUTTE le chiavi (comprese quelle che questo editor non
// conosce), cambiando solo quella toccata.

const SELECT_CLASS =
  "w-full min-w-0 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-sm outline-none focus:border-sky-500";

export function ScreenMetaEditor() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const node = scene && selection.length === 1 ? scene.nodes.at(selection[0]) : undefined;

  if (!scene || !node) {
    return (
      <div className="border-b border-neutral-200 px-2 py-3 text-sm text-neutral-400">
        Seleziona una schermata per modificarne i metadati.
      </div>
    );
  }

  const write = (key: string, value: string) => {
    const op = setMetaOp(node, key, value);
    if (op) submit([op]);
  };
  const status = statusOf(node);

  return (
    <section aria-label="Metadati della schermata" className="border-b border-neutral-200 text-sm text-neutral-700">
      <div className="flex items-center gap-1.5 border-b border-neutral-200 px-2 py-1.5">
        <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: STATUS_COLORS[status] }} />
        <span className="min-w-0 flex-1 truncate font-medium text-neutral-600">{layerDisplayName(node)}</span>
      </div>
      <div className="flex flex-col gap-1.5 p-2">
        <label className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 text-xs text-neutral-400">Tipo</span>
          <select
            aria-label="Tipo"
            value={kindOf(node)}
            onChange={(e) => write(META_KEYS.kind, e.target.value)}
            className={SELECT_CLASS}
          >
            {FLOW_KINDS.map((k) => (
              <option key={k} value={k}>{FLOW_KIND_LABELS[k]}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 text-xs text-neutral-400">Stato</span>
          <select
            aria-label="Stato"
            value={status}
            onChange={(e) => write(META_KEYS.status, e.target.value)}
            className={SELECT_CLASS}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 text-xs text-neutral-400">Route</span>
          <CommitField label="Route" value={metaValue(node, META_KEYS.route)} onCommit={(v) => write(META_KEYS.route, v)} placeholder="es. /login" />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 text-xs text-neutral-400">Componente</span>
          <CommitField label="Componente" value={metaValue(node, META_KEYS.component)} onCommit={(v) => write(META_KEYS.component, v)} placeholder="es. LoginPage" />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 text-xs text-neutral-400">Test id</span>
          <CommitField label="Test id" value={metaValue(node, META_KEYS.testId)} onCommit={(v) => write(META_KEYS.testId, v)} placeholder="es. login-submit" />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 text-xs text-neutral-400">Test testo</span>
          <CommitField label="Test testo" value={metaValue(node, META_KEYS.testText)} onCommit={(v) => write(META_KEYS.testText, v)} placeholder="es. Accedi" />
        </label>
      </div>
    </section>
  );
}
