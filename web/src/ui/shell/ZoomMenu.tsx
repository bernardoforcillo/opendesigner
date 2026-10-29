import { Button as RacButton, Menu, MenuItem, MenuTrigger, Popover, Separator } from "react-aria-components";
import { useScene } from "@/store/store";
import { Icon, Kbd } from "@/ui/ds";
import { runZoom, type ZoomCommand } from "@/canvas/zoomCommands";

// THE ZOOM MENU: the zoom on screen as a button, and the commands under it -- zoom in and out, actual
// size, fit, zoom to the selection -- with their shortcuts (canvas/zoomCommands.ts).
const ITEMS: readonly { id: ZoomCommand | "sep"; label: string; keys?: string }[] = [
  { id: "in", label: "Zoom in", keys: "⌘+" },
  { id: "out", label: "Zoom out", keys: "⌘−" },
  { id: "sep", label: "" },
  { id: "100", label: "Zoom to 100%", keys: "⇧0" },
  { id: "fit", label: "Zoom to fit", keys: "⇧1" },
  { id: "selection", label: "Zoom to selection", keys: "⇧2" },
];

export function ZoomMenu() {
  const zoom = useScene((s) => s.camera.zoom);
  return (
    <MenuTrigger>
      <RacButton
        aria-label="Zoom"
        className="flex h-7 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] tabular-nums text-fg-muted outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)] data-[pressed]:bg-surface-3"
      >
        {Math.round(zoom * 100)}%
        <Icon name="chevronDown" size={10} />
      </RacButton>
      <Popover placement="bottom end" offset={4} className="z-50 min-w-[200px] rounded-lg bg-raised p-1 text-[12px] text-fg shadow-pop">
        <Menu className="outline-none" onAction={(k) => runZoom(String(k) as ZoomCommand)}>
          {ITEMS.map((it, i) => it.id === "sep"
            ? <Separator key={i} className="my-1 h-px bg-line" />
            : (
              <MenuItem key={it.id} id={it.id} className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3">
                {it.label}
                {it.keys && <span className="ml-auto"><Kbd>{it.keys}</Kbd></span>}
              </MenuItem>
            ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
