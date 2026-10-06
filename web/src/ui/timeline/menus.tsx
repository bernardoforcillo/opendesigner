import { Button as RacButton, Menu, MenuItem, MenuTrigger, Popover, Separator } from "react-aria-components";
import { Icon } from "../ds";
import { AnimIcon } from "../ds/anim-parts";
import { useScene } from "../../store/store";
import { useTimeline, addPropertyTracks, applyPreset } from "../../animation/timelineStore";
import { PROP_LABEL, findTrack, isInside, propsFor } from "../../animation/timelineLogic";
import { PRESETS } from "../../animation/presets";

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
  const props = node ? propsFor(node) : [];

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
              <MenuItem key={p} id={p} isDisabled={outside || have} textValue={PROP_LABEL[p]} className={ITEM}>
                <AnimIcon name="diamond" size={11} className="text-fg-subtle" />
                {PROP_LABEL[p]}
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
