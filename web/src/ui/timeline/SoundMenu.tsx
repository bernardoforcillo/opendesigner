import { useEffect, useRef, useState } from "react";
import { Button as RacButton, Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import { AnimIcon } from "@/ui/ds/anim-parts";
import { useScene } from "@/store/store";
import { attachAudioFile, removeAudio } from "@/animation/audio/attach";
import { attachAudioPlayer } from "@/animation/audio/player";
import { soundOf } from "@/animation/audio/library";

// "Sound": attach an audio file to the selected layer (the audio effects work on it and it plays with the timeline), or take it off. The
// player itself is mounted here too: it follows the timeline for as long as the transport is on screen. See animation/audio.

const TRIGGER =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-[12px] font-medium text-fg outline-none " +
  "border border-line transition-colors hover:bg-surface-3 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 " +
  "data-[focus-visible]:shadow-[var(--ring)]";
const POPOVER = "z-50 min-w-[210px] rounded-xl bg-raised p-1 text-[13px] text-fg shadow-pop";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3 " +
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40";

export function SoundMenu() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const node = scene && selection.length > 0 ? scene.nodes.get(selection[0]) : undefined;
  const sound = soundOf(node);
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  // the player follows the timeline while this is on screen
  useEffect(() => attachAudioPlayer(), []);
  useEffect(() => {
    if (status === "") return;
    const t = setTimeout(() => setStatus(""), 6000);
    return () => clearTimeout(t);
  }, [status]);

  const onFile = async (file: File | undefined) => {
    if (!file || !node) return;
    setBusy(true);
    setStatus(`Uploading ${file.name}…`);
    try {
      await attachAudioFile(file, node.id);
      setStatus(`Sound attached to ${node.name.trim() !== "" ? node.name : node.kind}.`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not attach the sound.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <>
      <MenuTrigger>
        <RacButton aria-label="Sound" isDisabled={!node || busy} className={TRIGGER}>
          <AnimIcon name="curve" size={12} />
          Sound
        </RacButton>
        <Popover placement="bottom start" offset={6} className={POPOVER}>
          <Menu
            aria-label="Sound of the layer"
            className="outline-none"
            onAction={(k) => {
              if (k === "attach") input.current?.click();
              else if (k === "remove" && node) { removeAudio(node.id); setStatus("Sound removed."); }
            }}
          >
            <MenuItem id="attach" textValue="Attach a sound file" className={ITEM}>{sound ? "Replace the sound file…" : "Attach a sound file…"}</MenuItem>
            <MenuItem id="remove" isDisabled={!sound} textValue="Remove the sound" className={ITEM}>
              Remove the sound
              {sound && <span className="ml-auto max-w-[110px] truncate text-[11px] text-fg-subtle">{sound.name}</span>}
            </MenuItem>
          </Menu>
          <p className="max-w-[240px] px-2 py-1 text-[11px] leading-snug text-fg-subtle">WAV, MP3, Ogg, FLAC or M4A. It plays with the timeline; the Audio effects change it.</p>
        </Popover>
      </MenuTrigger>
      <input ref={input} type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a" aria-label="Sound file" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      {status !== "" && <span role="status" className="max-w-[220px] truncate text-[11px] text-fg-subtle">{status}</span>}
    </>
  );
}
