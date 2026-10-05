import { useState } from "react";
import { Button as RacButton } from "react-aria-components";
import { useScene } from "../../store/store";
import type { Progress, ReadinessItem } from "../../dev/readiness";
import { Badge, Button, EmptyState, Icon, cls } from "../ds";
import { DevIcon, type DevIconName } from "../ds/dev-parts";
import { applyFix, selectScreen, useReadiness } from "./useReadiness";

// "READINESS" (left column of Develop): the checklist that says whether the
// document is ready to become code. Failures rise to the top, each
// with its one-click "Fix" when possible; passed checks sit at the
// bottom, faint. The computation is pure (dev/readiness.ts); here there is only the view.

const STATE_ICON: Record<ReadinessItem["state"], { icon: DevIconName; cls: string }> = {
  pass: { icon: "circleCheck", cls: "text-ok" },
  fail: { icon: "circleX", cls: "text-danger" },
  warn: { icon: "circleWarn", cls: "text-warn" },
  pending: { icon: "circleDot", cls: "text-fg-subtle" },
};

const ROWS_SHOWN = 4;

function ItemRow({ item }: { item: ReadinessItem }) {
  const scene = useScene((s) => s.scene);
  const [all, setAll] = useState(false);
  const si = STATE_ICON[item.state];
  const rows = all ? item.rows : item.rows.slice(0, ROWS_SHOWN);
  const failing = item.state === "fail" || item.state === "warn";
  return (
    <li className="px-3 py-2" data-state={item.state} data-testid={`ready-${item.id}`}>
      <div className="flex items-start gap-2">
        <DevIcon name={si.icon} size={15} className={`mt-px shrink-0 ${si.cls}`} />
        <div className="min-w-0 flex-1">
          <p className={`text-[13px] leading-snug ${failing ? "font-medium text-fg" : "text-fg-muted"}`}>{item.title}</p>
          <p className="text-[12px] leading-snug text-fg-subtle">{item.detail}</p>
        </div>
      </div>
      {item.fix && scene && failing && (
        <div className="mt-1.5 pl-[23px]">
          <Button
            variant={item.fix.kind === "assign-routes" || item.fix.kind === "set-starts" ? "primary" : "secondary"}
            className="h-6 px-2 text-[12px]"
            onPress={() => applyFix(scene, item.fix!)}
          >
            {item.fix.label}
          </Button>
        </div>
      )}
      {failing && item.rows.length > 0 && scene && (
        <ul className="mt-1.5 flex flex-col gap-px pl-[23px]">
          {rows.map((r, i) => (
            <li key={`${r.label}-${i}`}>
              {r.nodeId ? (
                <RacButton
                  aria-label={`Select the screen: ${r.label}`}
                  onPress={() => selectScreen(scene, r.nodeId!)}
                  className="group flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[12px] text-fg-muted outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)]"
                >
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  <Icon name="chevronRight" size={11} className="shrink-0 text-fg-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                </RacButton>
              ) : (
                <span className="block truncate px-1.5 py-0.5 text-[12px] text-fg-muted">{r.label}</span>
              )}
            </li>
          ))}
          {item.rows.length > ROWS_SHOWN && (
            <li>
              <RacButton
                onPress={() => setAll(!all)}
                className="rounded px-1.5 py-0.5 text-[12px] text-accent outline-none hover:underline focus-visible:shadow-[var(--ring)]"
              >
                {all ? "Less" : `and ${item.rows.length - ROWS_SHOWN} more`}
              </RacButton>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

// Progress: a segmented bar (tested | implemented | planned) and the
// numbers below. It is information, not a control: "planned" is not an error.
function ProgressBar({ p }: { p: Progress }) {
  const pct = (n: number) => (p.total === 0 ? 0 : (n / p.total) * 100);
  const parts: { key: string; n: number; bar: string; dot: string; label: string }[] = [
    { key: "tested", n: p.tested, bar: "bg-ok", dot: "bg-ok", label: "tested" },
    { key: "implemented", n: p.implemented, bar: "bg-accent", dot: "bg-accent", label: "implemented" },
    { key: "planned", n: p.planned, bar: "bg-line-strong", dot: "bg-fg-subtle", label: "planned" },
  ];
  return (
    <div className="px-3 pb-3 pt-1" data-testid="ready-progress">
      <div role="img" aria-label={`${p.tested} tested, ${p.implemented} implemented, ${p.planned} planned out of ${p.total}`}
        className="flex h-1.5 overflow-hidden rounded-full bg-surface-3">
        {parts.map((x) => (
          <span key={x.key} className={x.bar} style={{ width: `${pct(x.n)}%` }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-fg-muted tabular-nums">
        {parts.map((x) => (
          <span key={x.key} className="flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${x.dot}`} />
            {x.n} {x.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ReadinessPanel() {
  const r = useReadiness();
  if (!r) return <EmptyState icon="info" title="No document" />;
  const todo = r.items.filter((i) => i.state === "fail" || i.state === "warn");
  todo.sort((a, b) => Number(b.blocking && b.state === "fail") - Number(a.blocking && a.state === "fail"));
  const rest = r.items.filter((i) => i.state === "pass" || i.state === "pending");
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="readiness">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="text-[13px] font-semibold text-fg">Readiness</h2>
        <span className="ml-auto" />
        {r.blockers > 0 ? (
          <Badge tone="danger">{r.blockers} {r.blockers === 1 ? "blocker" : "blockers"}</Badge>
        ) : (
          <Badge tone="ok">Ready</Badge>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section>
          <h3 className={`${cls.sectionTitle} px-3 pb-1 pt-3`}>Progress</h3>
          <ProgressBar p={r.progress} />
        </section>
        {todo.length > 0 && (
          <section className="border-t border-line">
            <h3 className={`${cls.sectionTitle} px-3 pb-0.5 pt-3`}>To fix</h3>
            <ul>{todo.map((i) => <ItemRow key={i.id} item={i} />)}</ul>
          </section>
        )}
        {rest.length > 0 && (
          <section className="border-t border-line">
            <h3 className={`${cls.sectionTitle} px-3 pb-0.5 pt-3`}>All good</h3>
            <ul className="pb-2">{rest.map((i) => <ItemRow key={i.id} item={i} />)}</ul>
          </section>
        )}
      </div>
    </div>
  );
}
