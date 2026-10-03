import { Label, Radio, RadioGroup } from "react-aria-components";
import { useScene } from "../store/store";
import { FLOW_KINDS, FLOW_KIND_LABELS, META_KEYS, STATUSES, STATUS_LABELS, kindOf, metaValue, statusOf, type FlowKind, type Status } from "../flow/meta";
import { setMetaOp, submit } from "../flow/commands";
import { layerDisplayName } from "./LayersPanel";
import { CommitField } from "./fields/CommitField";
import { Section, cls } from "./ds";
import { Field, FlowIcon, type FlowIconName } from "./ds/flow-parts";

// L'EDITOR DEI METADATI DI SCHERMATA (modalità Flussi, colonna destra). Scrive
// Node.meta: tipo nel flusso, route e componente del codice, id e testo del test,
// stato di avanzamento. Sono ciò che CLI e MCP leggono per generare spec e test.
//
// La mask "meta" di setProps SOSTITUISCE l'intera mappa: setMetaOp legge la mappa
// corrente e riscrive TUTTE le chiavi (comprese quelle che questo editor non
// conosce), cambiando solo quella toccata.

// L'icona di ogni tipo: la stessa famiglia di tratti che il canvas disegna nel
// badge della schermata (renderer/flowRenderer.ts::drawKindIcon).
const KIND_ICONS: Record<FlowKind, FlowIconName> = {
  screen: "kScreen",
  decision: "kDecision",
  action: "kAction",
  start: "kStart",
  end: "kEnd",
  note: "kNote",
};

// Lo stato come tre chip colorati, dal "non fatto" al "verificato": tenue,
// accento, verde -- gli stessi colori del pallino sul badge sul canvas.
const STATUS_STYLE: Record<Status, { dot: string; on: string }> = {
  planned: { dot: "bg-fg-subtle", on: "data-[selected]:bg-surface-3 data-[selected]:text-fg data-[selected]:border-line-strong" },
  implemented: { dot: "bg-accent", on: "data-[selected]:bg-accent-soft data-[selected]:text-accent data-[selected]:border-accent" },
  tested: { dot: "bg-ok", on: "data-[selected]:bg-ok-soft data-[selected]:text-ok data-[selected]:border-ok" },
};

// Un campo "da codice": monospazio, con la sua icona.
const CODE = "font-mono text-[12px]";

export function ScreenMetaEditor() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const node = scene && selection.length === 1 ? scene.nodes.at(selection[0]) : undefined;

  if (!scene || !node) {
    return (
      <div className="flex items-center gap-2 border-b border-line px-3 py-3 text-[12px] text-fg-subtle">
        <FlowIcon name="device" size={14} className="shrink-0" />
        <span>Seleziona una schermata per modificarne i metadati.</span>
      </div>
    );
  }

  const write = (key: string, value: string) => {
    const op = setMetaOp(node, key, value);
    if (op) submit([op]);
  };
  const kind = kindOf(node);
  const status = statusOf(node);

  return (
    <div aria-label="Metadati della schermata" role="region" className="border-b border-line bg-surface text-[13px] text-fg">
      <Section
        title="Schermata"
        actions={
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-muted">
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[status].dot}`} />
            <span className="min-w-0 max-w-[110px] truncate font-medium">{layerDisplayName(node)}</span>
          </span>
        }
      >
        <div className="flex flex-col gap-2">
        <Field label="Tipo" wide>
          <span className="relative block min-w-0 flex-1">
            <FlowIcon name={KIND_ICONS[kind]} size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" />
            <select
              aria-label="Tipo"
              value={kind}
              onChange={(e) => write(META_KEYS.kind, e.target.value)}
              className={cls.select + " pl-7"}
            >
              {FLOW_KINDS.map((k) => (
                <option key={k} value={k}>{FLOW_KIND_LABELS[k]}</option>
              ))}
            </select>
          </span>
        </Field>

        <RadioGroup
          aria-label="Stato"
          value={status}
          onChange={(v) => write(META_KEYS.status, v)}
          orientation="horizontal"
          className="flex flex-col gap-1"
        >
          <Label className="text-[11px] font-medium text-fg-subtle">Stato</Label>
          <div className="flex flex-wrap gap-1">
            {STATUSES.map((s) => (
              <Radio
                key={s}
                value={s}
                className={
                  "inline-flex h-6 cursor-pointer select-none items-center justify-center gap-1.5 rounded-full border border-line px-2 " +
                  "text-[11px] font-medium text-fg-muted outline-none transition-colors hover:bg-surface-3 " +
                  `data-[focus-visible]:shadow-[var(--ring)] ${STATUS_STYLE[s].on}`
                }
              >
                <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_STYLE[s].dot}`} />
                <span className="truncate">{STATUS_LABELS[s]}</span>
              </Radio>
            ))}
          </div>
        </RadioGroup>

        {/* Il legame col codice: quattro campi in una griglia 2x2 -- il nome sta nel
            segnaposto e nel tooltip, non in una colonna di etichette. */}
        <div className="mt-1 grid grid-cols-2 gap-1.5 border-t border-line pt-2.5">
          <CommitField label="Route" title="Route dell'app che realizza la schermata (es. /login)" value={metaValue(node, META_KEYS.route)} onCommit={(v) => write(META_KEYS.route, v)} placeholder="Route" className={CODE} />
          <CommitField label="Componente" title="Componente del codice (es. LoginPage)" value={metaValue(node, META_KEYS.component)} onCommit={(v) => write(META_KEYS.component, v)} placeholder="Componente" className={CODE} />
          <CommitField label="Test id" title="data-testid con cui un test trova l'elemento (es. login-submit)" value={metaValue(node, META_KEYS.testId)} onCommit={(v) => write(META_KEYS.testId, v)} placeholder="Test id" className={CODE} />
          <CommitField label="Test testo" title="Testo accessibile con cui un test trova l'elemento (es. Accedi)" value={metaValue(node, META_KEYS.testText)} onCommit={(v) => write(META_KEYS.testText, v)} placeholder="Test testo" className={CODE} />
        </div>
        </div>
      </Section>
    </div>
  );
}

