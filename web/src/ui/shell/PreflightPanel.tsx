import { useScene } from "@/store/store";
import { usePreflight } from "@/ui/shell/preflightIssues";
import type { PreflightIssue, Severity } from "@/export/preflight";

// THE PREFLIGHT PANEL (Publishing dock): every problem the editor can see in the document -- fonts that
// cannot be embedded, text that does not fit, unsized pages, layers that do not print -- grouped by how
// serious it is. Choosing one goes to its page and selects the object, so the fix is one click away.
// It is the same check the print dialog runs (export/preflight.ts), run live; it is a checklist of known
// problems, not a PDF/X validator.
const GROUPS: readonly { severity: Severity; title: string; dot: string }[] = [
  { severity: "error", title: "Errors", dot: "bg-danger" },
  { severity: "warning", title: "Warnings", dot: "bg-warn" },
  { severity: "info", title: "Notes", dot: "bg-fg-subtle" },
];

export function goToIssue(issue: PreflightIssue): void {
  const st = useScene.getState();
  if (issue.pageId && issue.pageId !== st.currentPageId) st.setCurrentPage(issue.pageId);
  if (issue.nodeId) st.setSelection([issue.nodeId]);
}

export function PreflightPanel() {
  const issues = usePreflight();
  return (
    <div role="region" aria-label="Preflight" className="flex h-full flex-col overflow-y-auto">
      {issues.length === 0 ? (
        <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
          <span className="h-2.5 w-2.5 rounded-full bg-ok" aria-hidden="true" />
          <p className="text-[13px] font-medium text-fg">No errors</p>
          <p className="text-[12px] text-fg-subtle">Nothing to fix before you export.</p>
        </div>
      ) : (
        GROUPS.map(({ severity, title, dot }) => {
          const rows = issues.filter((i) => i.severity === severity);
          if (rows.length === 0) return null;
          return (
            <section key={severity} aria-label={title} className="border-b border-line py-1">
              <h3 className="px-3 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">{title} · {rows.length}</h3>
              <ul>
                {rows.map((issue, i) => (
                  <li key={`${issue.code}-${issue.nodeId ?? issue.pageId ?? ""}-${i}`}>
                    <button
                      type="button"
                      onClick={() => goToIssue(issue)}
                      className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px] text-fg outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]"
                    >
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">{issue.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
