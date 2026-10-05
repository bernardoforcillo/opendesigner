import { Label, Radio, RadioGroup } from "react-aria-components";
import { useScene } from "../store/store";
import { FLOW_KINDS, FLOW_KIND_LABELS, META_KEYS, STATUSES, STATUS_LABELS, kindOf, metaValue, statusOf, type FlowKind, type Status } from "../flow/meta";
import { setMetaOp, submit } from "../flow/commands";
import { layerDisplayName } from "./LayersPanel";
import { CommitField } from "./fields/CommitField";
import { Section, cls } from "./ds";
import { Field, FlowIcon, type FlowIconName } from "./ds/flow-parts";

// THE SCREEN METADATA EDITOR (Flows mode, right column). It writes
// Node.meta: type in the flow, code route and component, test id and text,
// progress status. They are what the CLI and MCP read to generate specs and tests.
//
// The setProps "meta" mask REPLACES the whole map: setMetaOp reads the current
// map and rewrites ALL the keys (including those this editor does not
// know about), changing only the one touched.

// The icon of each type: the same family of strokes that the canvas draws in the
// screen's badge (renderer/flowRenderer.ts::drawKindIcon).
const KIND_ICONS: Record<FlowKind, FlowIconName> = {
  screen: "kScreen",
  decision: "kDecision",
  action: "kAction",
  start: "kStart",
  end: "kEnd",
  note: "kNote",
};

// The status as three colored chips, from "not done" to "verified": faint,
// accent, green -- the same colors as the dot on the badge on the canvas.
const STATUS_STYLE: Record<Status, { dot: string; on: string }> = {
  planned: { dot: "bg-fg-subtle", on: "data-[selected]:bg-surface-3 data-[selected]:text-fg data-[selected]:border-line-strong" },
  implemented: { dot: "bg-accent", on: "data-[selected]:bg-accent-soft data-[selected]:text-accent data-[selected]:border-accent" },
  tested: { dot: "bg-ok", on: "data-[selected]:bg-ok-soft data-[selected]:text-ok data-[selected]:border-ok" },
};

// A "code" field: monospace, with its icon.
// Short labels: the three chips fit in one row (the full name is the aria-label).
const STATUS_SHORT: Record<Status, string> = { planned: "Plan", implemented: "Done", tested: "Tested" };
const CODE = "font-mono text-[12px]";

export function ScreenMetaEditor() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const node = scene && selection.length === 1 ? scene.nodes.at(selection[0]) : undefined;

  if (!scene || !node) {
    return (
      <div className="flex items-center gap-2 border-b border-line px-3 py-3 text-[12px] text-fg-subtle">
        <FlowIcon name="device" size={14} className="shrink-0" />
        <span>Select a screen to edit its metadata.</span>
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
    <div aria-label="Screen metadata" role="region" className="border-b border-line bg-surface text-[13px] text-fg">
      <Section
        title="Screen"
        actions={
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-muted">
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[status].dot}`} />
            <span className="min-w-0 max-w-[110px] truncate font-medium">{layerDisplayName(node)}</span>
          </span>
        }
      >
        <div className="flex flex-col gap-2">
        <Field label="Type" wide>
          <span className="relative block min-w-0 flex-1">
            <FlowIcon name={KIND_ICONS[kind]} size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" />
            <select
              aria-label="Type"
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
          aria-label="Status"
          value={status}
          onChange={(v) => write(META_KEYS.status, v)}
          orientation="horizontal"
          className="flex flex-col gap-1"
        >
          <Label className="text-[11px] font-medium text-fg-subtle">Status</Label>
          <div className="grid grid-cols-3 gap-1">
            {STATUSES.map((s) => (
              <Radio
                key={s}
                value={s}
                aria-label={STATUS_LABELS[s]}
                className={
                  "inline-flex h-6 cursor-pointer select-none items-center justify-center gap-1.5 rounded-full border border-line px-2 " +
                  "text-[11px] font-medium text-fg-muted outline-none transition-colors hover:bg-surface-3 " +
                  `data-[focus-visible]:shadow-[var(--ring)] ${STATUS_STYLE[s].on}`
                }
              >
                <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_STYLE[s].dot}`} />
                <span className="truncate">{STATUS_SHORT[s]}</span>
              </Radio>
            ))}
          </div>
        </RadioGroup>

        {/* The link to the code: four fields in a 2x2 grid -- the name is in the
            placeholder and in the tooltip, not in a column of labels. */}
        <div className="mt-1 grid grid-cols-2 gap-1.5 border-t border-line pt-2.5">
          <CommitField label="Route" title="The app route that implements the screen (e.g. /login)" value={metaValue(node, META_KEYS.route)} onCommit={(v) => write(META_KEYS.route, v)} placeholder="Route" className={CODE} />
          <CommitField label="Component" title="Code component (e.g. LoginPage)" value={metaValue(node, META_KEYS.component)} onCommit={(v) => write(META_KEYS.component, v)} placeholder="Component" className={CODE} />
          <CommitField label="Test id" title="data-testid with which a test finds the element (e.g. login-submit)" value={metaValue(node, META_KEYS.testId)} onCommit={(v) => write(META_KEYS.testId, v)} placeholder="Test id" className={CODE} />
          <CommitField label="Test text" title="Accessible text with which a test finds the element (e.g. Log in)" value={metaValue(node, META_KEYS.testText)} onCommit={(v) => write(META_KEYS.testText, v)} placeholder="Test text" className={CODE} />
        </div>
        </div>
      </Section>
    </div>
  );
}

