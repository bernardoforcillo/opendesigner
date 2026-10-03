import { Button as RacButton, Menu, MenuItem, MenuTrigger, Popover, Separator } from "react-aria-components";
import { Icon } from "../ds";
import { useScene } from "../../store/store";
import { useRenderer } from "../../store/rendererChoice";
import { useTheme } from "./theme";

// IL MENU DEL DOCUMENTO: il logo è il pulsante. Dentro: il nome del documento, il
// nuovo documento, il tema, il renderer. Sta nel dock, non in una barra a parte.
function Logo() {
  return (
    <svg viewBox="0 0 28 28" width="24" height="24" aria-hidden="true">
      <rect width="28" height="28" rx="8" fill="var(--accent)" />
      <rect x="6.5" y="6.5" width="8" height="8" rx="2" fill="var(--accent-fg)" opacity="0.95" />
      <circle cx="19.5" cy="19.5" r="3.6" fill="none" stroke="var(--accent-fg)" strokeWidth="2" />
      <path d="M14.8 10.5h3a2.2 2.2 0 012.2 2.2v3.6" stroke="var(--accent-fg)" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.7" />
    </svg>
  );
}


export function DocMenu({ onNewDocument }: { onNewDocument: () => void }) {
  const docName = useScene((s) => s.scene?.name ?? "");
  const theme = useTheme((s) => s.choice);
  const setTheme = useTheme((s) => s.set);
  const renderer = useRenderer((s) => s.choice);
  const setRenderer = useRenderer((s) => s.setChoice);
  return (
    <MenuTrigger>
      <RacButton aria-label="Menu del documento" className="flex h-9 w-9 items-center justify-center rounded-lg outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]">
        <Logo />
      </RacButton>
      <Popover placement="top start" offset={10} className="z-50 min-w-[220px] rounded-xl bg-raised p-1 text-[13px] text-fg shadow-pop">
        <div className="truncate px-2 py-1.5 text-[13px] font-semibold">{docName === "" ? "Senza titolo" : docName}</div>
        <Separator className="my-1 h-px bg-line" />
        <Menu className="outline-none" onAction={(k) => {
          if (k === "new") onNewDocument();
          else if (k === "renderer") setRenderer(renderer === "gpu" ? "cpu" : "gpu");
          else if (k === "system" || k === "light" || k === "dark") setTheme(k);
        }}>
              <MenuItem id="new" className={ITEM}>
                <Icon name="plus" size={14} /> Nuovo documento
              </MenuItem>
              <MenuItem id="renderer" className={ITEM}>
                <Icon name="bolt" size={14} /> Renderer {renderer === "gpu" ? "GPU" : "CPU"}
                <span className="ml-auto text-[11px] text-fg-subtle">passa a {renderer === "gpu" ? "CPU" : "GPU"}</span>
              </MenuItem>
              <Separator className="my-1 h-px bg-line" />
              <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Tema</div>
              {([["system", "Come il sistema", "cpu"], ["light", "Chiaro", "sun"], ["dark", "Scuro", "moon"]] as const).map(([id, label, icon]) => (
                <MenuItem key={id} id={id} className={ITEM}>
                  <Icon name={icon} size={14} /> {label}
                  {theme === id && <Icon name="check" size={14} className="ml-auto text-accent" />}
                </MenuItem>
              ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

const ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none " +
  "data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3";
