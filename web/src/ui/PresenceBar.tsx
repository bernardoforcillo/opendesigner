import { useState } from "react";
import { usePresence, peerColor, saveNickname } from "../store/presence";

/**
 * Nickname, chi c'è e il pulsante per invitare. Nessun account: il nome lo
 * sceglie ognuno ed è solo un'etichetta per la sessione.
 */
export function PresenceBar({
  nickname, onNickname,
}: {
  nickname: string;
  onNickname: (n: string) => void;
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

  return (
    <div className="flex items-center gap-2">
      <div role="list" aria-label="Persone nel documento" className="flex -space-x-1">
        {others.map((p) => (
          <div
            key={p.clientId}
            role="listitem"
            title={p.nickname}
            aria-label={p.nickname}
            style={{ backgroundColor: peerColor(p.clientId) }}
            className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white"
          >
            {p.nickname.slice(0, 1).toUpperCase()}
          </div>
        ))}
      </div>
      <input
        aria-label="Il tuo nickname"
        value={draft}
        maxLength={32}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        className="w-28 rounded border border-neutral-200 bg-white px-2 py-0.5 text-sm outline-none focus:border-sky-500"
      />
      <button
        type="button"
        onClick={share}
        className="rounded border border-neutral-200 px-2 py-0.5 text-sm hover:bg-neutral-50"
      >
        {copied ? "Link copiato" : "Condividi"}
      </button>
    </div>
  );
}
