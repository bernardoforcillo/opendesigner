import { useScene } from "@/store/store";
import { swapInstance } from "@/store/instanceOps";
import { detachSelectedInstances, goToMainComponent, mainComponentOf, resetSelectedInstances, swapSelectedInstances } from "@/tools/instanceActions";
import { Button, cls, Section } from "@/ui/ds";

// THE COMMANDS of a selected component INSTANCE: go to its main component, swap it for another
// component (keeping the overrides that still fit), reset its overrides -- all of them or
// one layer's -- and detach it into plain nodes. Each is ONE gesture = one undo step; the
// ops are built by tools/instanceActions.ts. Detach is also Ctrl/Cmd+Alt+B.

export function InstanceActions() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length === 0) return null;
  const nodes = selection.map((id) => scene.nodes.at(id));
  if (!nodes.every((n) => n?.kind === "instance" && n.instance)) return null;
  const single = nodes.length === 1 ? nodes[0] : undefined;
  const current = single?.instance?.componentId;
  const choices = Object.entries(scene.components)
    .filter(([id]) => selection.every((sel) => swapInstance(scene, sel, id) !== null))
    .map(([id, c]) => ({ id, name: c.name || "Unnamed" }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const overrides = single?.instance?.overrides ?? [];
  const hasChanges = nodes.some((n) => n!.instance!.overrides.length > 0 || Object.keys(n!.instance!.propertyValues ?? {}).length > 0 || Object.keys(n!.instance!.variantProps ?? {}).length > 0);
  return (
    <Section title="Instance">
      <div className="flex flex-col gap-1.5">
        <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
          <span className={cls.label}>Component</span>
          <select aria-label="Swap instance" className={cls.select} value={current ?? "__mixed"}
            onChange={(e) => swapSelectedInstances(e.target.value)}>
            {current === undefined && <option value="__mixed" disabled>Mixed</option>}
            {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {overrides.map((o) => {
          const target = scene.nodes.at(o.masterNodeId);
          return (
            <div key={o.masterNodeId} className="flex items-center justify-between gap-2 text-[12px] text-fg-muted">
              <span className="truncate">{target?.name || target?.kind || "Layer"}: {o.text !== undefined ? "text" : "fill"}</span>
              <Button variant="ghost" aria-label={`Reset override on ${target?.name || o.masterNodeId}`} onPress={() => resetSelectedInstances(o.masterNodeId)}>Reset</Button>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-1.5">
          {single && mainComponentOf(scene, single.id) && <Button onPress={() => goToMainComponent()}>Go to main component</Button>}
          <Button isDisabled={!hasChanges} onPress={() => resetSelectedInstances()}>Reset all changes</Button>
          <Button onPress={() => detachSelectedInstances()}>Detach instance</Button>
        </div>
      </div>
    </Section>
  );
}
