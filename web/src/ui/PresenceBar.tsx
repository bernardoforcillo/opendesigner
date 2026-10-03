import { useState } from "react";
import { Button as RacButton, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { usePresence, peerColor, saveNickname } from "../store/presence";
import { Button, Icon } from "./ds";

// Quanti avatar si mostrano prima del "+N": nella barra in alto lo spazio è poco.
const MAX_AVATARS = 4;

/**
 * Nickname, chi c'è e il pulsante per invitare. Nessun account: il nome lo
 * sceglie ognuno ed è solo un'etichetta per la sessione.
 *
 * Gli avatar si sovrappongono con un anello del colore della barra (così si
 * leggono anche uno sopra l'altro); il nickname è una pillola modificabile in
 * linea -- resta un <input> con lo stesso nome accessibile, ma a riposo non ha
 * cornice e si accende al passaggio e al fuoco.
 */
export function PresenceBar({
  nickname, onNickname, compact = false,
}: {
  nickname: string;
  onNickname: (n: string) => void;
  // Nel dock: gli avatar sono un solo pulsante "Persone" che apre un popover con
  // il nickname e il link da condividere -- tre controlli diventano uno.
  compact?: boolean;
}) {
  const peers = usePresence((s) => s.peers);
  const [draft, setDraft] = useState(nickname);
  const [copied, setCopied] = useState(false);
  const others = Object.values(peers);

  const commit = () => {
    const n = draft.trim();
    if (n === "") { setDraft(nickname); return; }
    if (n !== nickname) { saveNickname(n); onNickname(n); }
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Niente clipboard (http fuori da localhost): il link è comunque nella
      // barra degli indirizzi, che è esattamente ciò che si copierebbe.
      window.prompt("Copia questo link e mandalo a chi vuoi invitare:", location.href);
    }
  };

  const shown = others.slice(0, MAX_AVATARS);
  const extra = others.length - shown.length;

  const avatars = (
    <div role="list" aria-label="Persone nel documento" className="flex items-center -space-x-1.5">
      {shown.map((p) => (
        <div
          key={p.clientId}
          role="listitem"
          title={p.nickname}
          aria-label={p.nickname}
          style={{ backgroundColor: peerColor(p.clientId) }}
          className="flex h-6 w-6 select-none items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ring-surface"
        >
          {p.nickname.slice(0, 1).toUpperCase()}
        </div>
      ))}
      {extra > 0 && (
        <div
          role="listitem"
          aria-label={`Altre ${extra} persone`}
          className="flex h-6 min-w-6 select-none items-center justify-center rounded-full bg-surface-3 px-1 text-[10px] font-semibold text-fg-muted ring-2 ring-surface"
        >
          {`+${extra}`}
        </div>
      )}
    </div>
  );
  const nameField = (
    <span className="relative block">
      <Icon name="user" size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle" />
      <input
        aria-label="Il tuo nickname"
        value={draft}
        maxLength={32}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        className={`h-7 ${compact ? "w-full" : "w-28"} rounded-full border border-transparent bg-transparent pl-6 pr-2 text-[12px] font-medium text-fg hover:border-line-strong hover:bg-surface-2 focus:border-accent focus:bg-surface focus:outline-none`}
      />
    </span>
  );
  const shareButton = (
    <Button
      variant="secondary"
      icon={copied ? "check" : "link"}
      onPress={share}
      aria-label={copied ? "Link copiato" : "Condividi"}
      className={copied ? "text-ok" : ""}
    >
      {/* Sotto i 1600px di finestra resta la sola icona: il dock deve starci. */}
      <span className={compact ? "" : "max-[1600px]:hidden"}>{copied ? "Link copiato" : "Condividi"}</span>
    </Button>
  );

  if (compact) {
    return (
      <DialogTrigger>
        <RacButton
          aria-label="Persone"
          className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-fg-muted outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)]"
        >
          {others.length > 0 ? avatars : <Icon name="user" size={16} />}
          <span className="text-[12px] font-medium tabular-nums">{others.length + 1}</span>
        </RacButton>
        <Popover placement="top" offset={10} className="w-[248px] rounded-xl bg-raised p-3 text-fg shadow-pop">
          <Dialog aria-label="Persone" className="flex flex-col gap-3 outline-none">
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Tu</span>
              {nameField}
            </div>
            {others.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Nel documento · {others.length}</span>
                <ul className="flex flex-col gap-1">
                  {others.map((p) => (
                    <li key={p.clientId} className="flex items-center gap-2 text-[13px]">
                      <span style={{ backgroundColor: peerColor(p.clientId) }} className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white">
                        {p.nickname.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="truncate">{p.nickname}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {shareButton}
          </Dialog>
        </Popover>
      </DialogTrigger>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {avatars}
      {nameField}
      {shareButton}
    </div>
  );
}
