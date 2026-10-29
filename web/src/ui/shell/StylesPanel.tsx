import { useMemo, useState } from "react";
import { useScene } from "@/store/store";
import { Button } from "@/ui/ds";
import { StylesDialog } from "@/ui/StylesDialog";
import { characterStyleOf, formatOps, paragraphStyleOf } from "@/ui/typographyOps";
import type { TextStyleDefLite } from "@/store/types";

// THE STYLES PANEL (Publishing dock): the document's paragraph styles and character styles in one place.
// A paragraph style sets the look of whole paragraphs; a character style overrides a few fields over a
// range of characters (docs/rich-text.md). Choosing one applies it to the selected text frames (every
// paragraph, or the whole text); the one in use is marked, "None" clears it. Creating and editing styles
// is the Styles dialog, one click away. Inside a text being edited the pickers of the text editor apply
// a style to the selection instead.
export function applyStyle(ids: readonly string[], f: { paragraph?: string; character?: string }): void {
  const store = useScene.getState();
  if (!store.scene) return;
  const ops = formatOps(store.scene, ids, f);
  if (ops.length === 0) return;
  store.beginGesture();
  store.endGesture(ops);
}

function Row({ def, active, disabled, onPress }: { def: TextStyleDefLite | null; active: boolean; disabled: boolean; onPress: () => void }) {
  const s = def?.style;
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        disabled={disabled}
        onClick={onPress}
        className={
          "flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] outline-none focus-visible:shadow-[var(--ring)] disabled:opacity-50 " +
          (active ? "bg-accent-soft font-medium text-accent" : "text-fg hover:bg-surface-3")
        }
      >
        <span className="min-w-0 flex-1 truncate">{def ? def.name : "None"}</span>
        {s && s.fontSize > 0 && <span className="shrink-0 text-[11px] text-fg-subtle">{s.fontSize} pt</span>}
      </button>
    </li>
  );
}

export function StylesPanel() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const [editing, setEditing] = useState(false);

  const { paragraph, character } = useMemo(() => {
    const all = Object.values(scene?.textStyles ?? {}).sort((a, b) => a.name.localeCompare(b.name));
    return { paragraph: all.filter((d) => d.kind !== "character"), character: all.filter((d) => d.kind === "character") };
  }, [scene?.textStyles]);
  const textIds = useMemo(
    () => (scene ? selection.filter((id) => scene.nodes.at(id)?.kind === "text") : []),
    [scene, selection],
  );
  const noText = textIds.length === 0;
  const curP = scene && !noText ? paragraphStyleOf(scene, textIds) : undefined;
  const curC = scene && !noText ? characterStyleOf(scene, textIds) : undefined;

  return (
    <div role="region" aria-label="Styles" className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <p className="min-w-0 flex-1 text-[12px] text-fg-subtle">{noText ? "Select a text frame to apply a style." : `${textIds.length === 1 ? "1 text frame" : `${textIds.length} text frames`} selected`}</p>
        <Button onPress={() => setEditing(true)}>Edit styles…</Button>
      </div>
      <section aria-label="Paragraph styles" className="border-b border-line py-1">
        <h3 className="px-3 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Paragraph styles</h3>
        <ul>
          <Row def={null} active={curP === ""} disabled={noText} onPress={() => applyStyle(textIds, { paragraph: "" })} />
          {paragraph.map((d) => <Row key={d.id} def={d} active={curP === d.id} disabled={noText} onPress={() => applyStyle(textIds, { paragraph: d.id })} />)}
        </ul>
        {paragraph.length === 0 && <p className="px-3 py-1 text-[12px] text-fg-subtle">No paragraph styles yet.</p>}
      </section>
      <section aria-label="Character styles" className="py-1">
        <h3 className="px-3 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Character styles</h3>
        <ul>
          <Row def={null} active={curC === ""} disabled={noText} onPress={() => applyStyle(textIds, { character: "" })} />
          {character.map((d) => <Row key={d.id} def={d} active={curC === d.id} disabled={noText} onPress={() => applyStyle(textIds, { character: d.id })} />)}
        </ul>
        {character.length === 0 && <p className="px-3 py-1 text-[12px] text-fg-subtle">No character styles yet.</p>}
      </section>
      <StylesDialog isOpen={editing} onOpenChange={setEditing} />
    </div>
  );
}
