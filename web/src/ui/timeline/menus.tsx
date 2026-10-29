import { Button as RacButton, Header, Menu, MenuItem, MenuSection, MenuTrigger, Popover, Separator, SubmenuTrigger } from "react-aria-components";
import { Icon } from "@/ui/ds";
import { AnimIcon } from "@/ui/ds/anim-parts";
import { useScene } from "@/store/store";
import { useTimeline, addPropertyTracks, applyPreset } from "@/animation/timelineStore";
import { findTrack, fxPropsFor, isInside, propLabel, propsFor } from "@/animation/timelineLogic";
import { fxLayerProp, parseFxProp } from "@/animation/fx/props";
import { FX_CATALOG } from "@/animation/fx/catalog";
import { fxDef, hasFx } from "@/animation/fx/library";
import { PRESETS } from "@/animation/presets";

// THE TWO MENUS that bring a layer into an animation: "+ Property" (one
// track at a time, on what is selected) and "Animate with a preset" (a ready-made
// clip). They appear as compact buttons in the timeline's header.

const TRIGGER =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-[12px] font-medium text-fg outline-none " +
  "border border-line transition-colors hover:bg-surface-3 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 " +
  "data-[focus-visible]:shadow-[var(--ring)]";
const POPOVER = "z-50 min-w-[190px] rounded-xl bg-raised p-1 text-[13px] text-fg shadow-pop";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3 " +
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40";

/** "+ Property": the animatable properties of the selected node. */
export function AddPropertyMenu() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const clipId = useTimeline((s) => s.clipId);
  const nodes = scene ? selection.map((id) => scene.nodes.get(id)).filter((n) => !!n) : [];
  const node = nodes[0];
  const clip = scene && clipId ? scene.clips[clipId] : undefined;
  const outside = !!(scene && node && clip && !nodes.some((n) => n && isInside(scene, n.id, clip.targetId)));
  const props: string[] = node ? [...propsFor(node)] : [];
  // The other parameters of the effects this node already has in the clip.
  if (node && clip) {
    const active = new Set(clip.tracks.filter((t) => t.nodeId === node.id).map((t) => parseFxProp(t.prop)?.effect).filter((e): e is string => !!e));
    for (const id of active) props.push(...fxPropsFor(id));
  }

  return (
    <MenuTrigger>
      <RacButton
        aria-label="Add property"
        isDisabled={!node}
        className={TRIGGER}
      >
        <Icon name="plus" size={12} />
        Property
      </RacButton>
      <Popover placement="bottom start" offset={6} className={POPOVER}>
        {outside && (
          <p className="max-w-[220px] px-2 py-1.5 text-[12px] leading-snug text-warn">
            The layer is outside the clip's target: choose another target or another clip.
          </p>
        )}
        <Menu
          aria-label="Property to animate"
          className="outline-none"
          onAction={(k) => scene && addPropertyTracks(scene, selection, String(k))}
        >
          {props.map((p) => {
            const have = !!(clip && node && findTrack(clip, node.id, p) >= 0);
            return (
              <MenuItem key={p} id={p} isDisabled={outside || have} textValue={propLabel(p)} className={ITEM}>
                <AnimIcon name="diamond" size={11} className="text-fg-subtle" />
                {propLabel(p)}
                {have && <span className="ml-auto text-[11px] text-fg-subtle">already animated</span>}
              </MenuItem>
            );
          })}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

/** "Animate with a preset": ready-made clips for the selected node. */
export function PresetMenu() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const node = scene && selection.length > 0 ? scene.nodes.get(selection[0]) : undefined;

  return (
    <MenuTrigger>
      <RacButton aria-label="Animate with a preset" isDisabled={!node} className={TRIGGER}>
        <AnimIcon name="wand" size={13} />
        Preset
      </RacButton>
      <Popover placement="bottom start" offset={6} className={POPOVER}>
        <Menu
          aria-label="Animation presets"
          className="outline-none"
          onAction={(k) => scene && node && applyPreset(scene, node.id, k as (typeof PRESETS)[number]["id"])}
        >
          {PRESETS.map((p) => (
            <MenuItem key={p.id} id={p.id} isDisabled={!node || !p.applicable(node)} textValue={p.label} className={ITEM}>
              <span className="flex flex-col">
                <span>{p.label}</span>
                <span className="text-[11px] text-fg-subtle">{p.hint}</span>
              </span>
            </MenuItem>
          ))}
        </Menu>
        <Separator className="mx-1 my-1 border-t border-line" />
        <p className="px-2 py-1 text-[11px] text-fg-subtle">Creates a new clip on the selected layer.</p>
      </Popover>
    </MenuTrigger>
  );
}

const CATEGORIES = [...new Set(FX_CATALOG.map((e) => e.category))];
export const FX_AVAILABLE = FX_CATALOG.filter((e) => hasFx(e.id)).length;

/** "+ Effect": the EffectCraft effects, by category; the ones OpenDesigner can draw first. */
export function AddEffectMenu() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const node = scene && selection.length > 0 ? scene.nodes.get(selection[0]) : undefined;
  // the layers an effect can use as its second layer: every other node, in document order, named
  const layers = scene && node
    ? [...scene.nodes.values()].filter((n) => n.id !== node.id && n.kind !== "unknown").map((n) => ({ id: n.id, name: n.name.trim() !== "" ? n.name : n.kind })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 80)
    : [];

  return (
    <MenuTrigger>
      <RacButton aria-label="Add effect" isDisabled={!node} className={TRIGGER}>
        <AnimIcon name="sliders" size={13} />
        Effect
      </RacButton>
      <Popover placement="bottom start" offset={6} className={POPOVER}>
        <Menu
          aria-label="Effect to add"
          className="max-h-[360px] overflow-y-auto outline-none"
          onAction={(k) => {
            // "layer:<effect>:<node>" is a layer picked for an effect that uses a second layer, otherwise "<effect>"
            const [kind, effectId, layerId] = String(k).startsWith("layer:") ? String(k).split(":") : ["fx", String(k), ""];
            const def = fxDef(kind === "layer" ? effectId : String(k));
            if (!scene || !def) return;
            const first = `fx.${def.id}.${def.params[0].id}`;
            addPropertyTracks(scene, selection, kind === "layer" ? [fxLayerProp(def.id, layerId), first] : first);
          }}
        >
          {CATEGORIES.map((cat) => {
            const items = FX_CATALOG.filter((e) => e.category === cat);
            const ready = items.filter((e) => hasFx(e.id));
            if (ready.length === 0) return null;
            return (
              <MenuSection key={cat}>
                <Header className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">{cat}</Header>
                {ready.map((e) =>
                  fxDef(e.id)?.needsLayer ? (
                    <SubmenuTrigger key={e.id}>
                      <MenuItem id={e.id} textValue={e.name} className={ITEM}>
                        {e.name}
                        <span className="ml-auto text-[11px] text-fg-subtle">layer ›</span>
                      </MenuItem>
                      <Popover className={POPOVER} offset={4}>
                        <Menu aria-label={`Layer for ${e.name}`} className="max-h-[300px] overflow-y-auto outline-none">
                          {layers.length === 0 && <MenuItem id="none" isDisabled textValue="No other layers" className={ITEM}>No other layers</MenuItem>}
                          {layers.map((l) => (
                            <MenuItem key={l.id} id={`layer:${e.id}:${l.id}`} textValue={l.name} className={ITEM}>{l.name}</MenuItem>
                          ))}
                        </Menu>
                      </Popover>
                    </SubmenuTrigger>
                  ) : (
                    <MenuItem key={e.id} id={e.id} textValue={e.name} className={ITEM}>{e.name}</MenuItem>
                  ),
                )}
              </MenuSection>
            );
          })}
        </Menu>
        <Separator className="mx-1 my-1 border-t border-line" />
        <p className="max-w-[240px] px-2 py-1 text-[11px] leading-snug text-fg-subtle">
          {FX_AVAILABLE} of {FX_CATALOG.length} EffectCraft effects can be drawn here; add more parameters with + Property.
        </p>
      </Popover>
    </MenuTrigger>
  );
}
