import { useScene } from "../store/store";
import type { VariableKind } from "../store/types";
import { cls } from "./ds";

// The select controls through which the properties panel binds things to variables.
// None of them is drawn when the document has no variable of the kind they need, so
// whoever does not use variables pays nothing for them.

const NO_VAR = "__none__";
const MIXED_VAR = "__mixed__";

function useVariablesOf(kind: VariableKind) {
  const variables = useScene((s) => s.scene?.variables);
  return Object.values(variables ?? {}).filter((v) => v.kind === kind).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Picker for one gradient stop: a colour variable, or "Fixed colour". */
export function StopVariablePicker({ label, bound, onPick }: { label: string; bound: string | null; onPick: (varId: string | null) => void }) {
  const vars = useVariablesOf("color");
  if (vars.length === 0 && bound === null) return null;
  const dangling = bound !== null && !vars.some((v) => v.id === bound);
  return (
    <select aria-label={label} className={`${cls.select} mt-1`} value={bound ?? NO_VAR} onChange={(e) => onPick(e.target.value === NO_VAR ? null : e.target.value)}>
      <option value={NO_VAR}>Fixed colour</option>
      {dangling && <option value={bound!}>Missing variable</option>}
      {vars.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
    </select>
  );
}

/** Picker for a number/text property of the selection. `bound`: id, null, or "mixed". */
export function PropVariablePicker({ label, kind, bound, onPick }: {
  label: string; kind: VariableKind; bound: string | null | "mixed"; onPick: (varId: string | null) => void;
}) {
  const vars = useVariablesOf(kind);
  if (vars.length === 0 && bound === null) return null;
  const value = bound === "mixed" ? MIXED_VAR : (bound ?? NO_VAR);
  const dangling = typeof bound === "string" && bound !== "mixed" && !vars.some((v) => v.id === bound);
  return (
    <label className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[11px] text-fg-subtle">{label}</span>
      <select
        aria-label={`${label} variable`}
        className={cls.select}
        value={value}
        onChange={(e) => {
          if (e.target.value === MIXED_VAR) return;
          onPick(e.target.value === NO_VAR ? null : e.target.value);
        }}
      >
        {bound === "mixed" && <option value={MIXED_VAR}>{"Mixed"}</option>}
        <option value={NO_VAR}>Fixed value</option>
        {dangling && <option value={bound as string}>Missing variable</option>}
        {vars.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>
    </label>
  );
}
