import { Button as RacButton, Menu, MenuItem, MenuTrigger, Popover, Separator } from "react-aria-components";
import { Icon } from "../ds";
import { AnimIcon } from "../ds/anim-parts";
import { useScene } from "../../store/store";
import { useTimeline, addPropertyTracks, applyPreset } from "../../animation/timelineStore";
import { PROP_LABEL, findTrack, isInside, propsFor } from "../../animation/timelineLogic";
import { PRESETS } from "../../animation/presets";

// I DUE MENU che portano un livello dentro un'animazione: "+ Proprietà" (una
// traccia per volta, su ciò che è selezionato) e "Anima con un preset" (una clip
// già pronta). Compaiono come bottoni compatti nella testata della timeline.

const TRIGGER =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-[12px] font-medium text-fg outline-none " +
  "border border-line transition-colors hover:bg-surface-3 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 " +
  "data-[focus-visible]:shadow-[var(--ring)]";
const POPOVER = "z-50 min-w-[190px] rounded-xl bg-raised p-1 text-[13px] text-fg shadow-pop";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3 " +
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40";

/** "+ Proprietà": le proprietà animabili del nodo selezionato. */
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
        aria-label="Aggiungi proprietà"
        isDisabled={!node}
        className={TRIGGER}
      >
        <Icon name="plus" size={12} />
        Proprietà
      </RacButton>
      <Popover placement="bottom start" offset={6} className={POPOVER}>
        {outside && (
          <p className="max-w-[220px] px-2 py-1.5 text-[12px] leading-snug text-warn">
            Il livello sta fuori dal bersaglio della clip: scegli un altro bersaglio o un'altra clip.
          </p>
        )}
        <Menu
          aria-label="Proprietà da animare"
          className="outline-none"
          onAction={(k) => scene && addPropertyTracks(scene, selection, String(k))}
        >
          {props.map((p) => {
            const have = !!(clip && node && findTrack(clip, node.id, p) >= 0);
            return (
              <MenuItem key={p} id={p} isDisabled={outside || have} textValue={PROP_LABEL[p]} className={ITEM}>
                <AnimIcon name="diamond" size={11} className="text-fg-subtle" />
                {PROP_LABEL[p]}
                {have && <span className="ml-auto text-[11px] text-fg-subtle">già animata</span>}
              </MenuItem>
            );
          })}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

/** "Anima con un preset": clip pronte per il nodo selezionato. */
export function PresetMenu() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const node = scene && selection.length > 0 ? scene.nodes.get(selection[0]) : undefined;

  return (
    <MenuTrigger>
      <RacButton aria-label="Anima con un preset" isDisabled={!node} className={TRIGGER}>
        <AnimIcon name="wand" size={13} />
        Preset
      </RacButton>
      <Popover placement="bottom start" offset={6} className={POPOVER}>
        <Menu
          aria-label="Preset di animazione"
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
        <p className="px-2 py-1 text-[11px] text-fg-subtle">Crea una clip nuova sul livello selezionato.</p>
      </Popover>
    </MenuTrigger>
  );
}
