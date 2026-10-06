import { useEffect, useState } from "react";
import { useScene } from "../store/store";
import { usePresence } from "../store/presence";
import {
  CHAT_MAX, REACTIONS, activeTimer, formatRemaining, ranking, tally, useFacilitation,
} from "../store/facilitation";

const BTN = "h-7 rounded-md px-2 text-[12px] text-fg-muted outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)] disabled:opacity-40";

/** A clock that re-renders twice a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [on]);
  return on ? now : Date.now();
}

/**
 * The facilitator's strip, at the top of the Board: a countdown everyone sees, dot voting with its
 * results, cursor chat and reactions, and follow mode. Everything here is shared through presence
 * (store/facilitation.ts) and nothing is written to the document.
 */
export function FacilitationBar({ myId }: { myId: string }) {
  const f = useFacilitation();
  const peers = usePresence((s) => s.peers);
  const scene = useScene((s) => s.scene);
  const [draft, setDraft] = useState("");
  const [showResults, setShowResults] = useState(false);
  const timer = activeTimer(peers, f.timer, Date.now(), 8000, myId);
  const now = useNow(timer !== null);
  const counts = tally(peers, f.votes);
  const ranked = ranking(counts);
  const others = Object.values(peers).filter((p) => p.hasView);

  return (
    <div role="group" aria-label="Facilitation" className="absolute left-1/2 top-3 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-xl bg-raised p-1 text-[12px] text-fg shadow-bar">
      {timer ? (
        <span className="flex items-center gap-1 px-1" role="timer" aria-label="Timer">
          <span className={`font-mono text-[13px] font-semibold tabular-nums ${now >= timer.endMs ? "text-danger" : ""}`}>{formatRemaining(timer.endMs, now)}</span>
          {timer.label && <span className="text-fg-subtle">{timer.label}</span>}
          {timer.owner === myId && <button type="button" className={BTN} onClick={() => f.stopTimer()}>Stop</button>}
        </span>
      ) : (
        <span className="flex items-center gap-0.5" role="group" aria-label="Start a timer">
          {[1, 3, 5].map((m) => (
            <button key={m} type="button" className={BTN} onClick={() => f.startTimer(m * 60)}>{m} min</button>
          ))}
        </span>
      )}
      <span className="mx-1 h-5 w-px bg-line" />
      <span className="px-1 tabular-nums" aria-label="Dots left">{f.votesPerPerson - f.votes.length} of {f.votesPerPerson} dots</span>
      <button type="button" className={BTN} disabled={f.votes.length === 0} onClick={() => f.clearVotes()}>Take back</button>
      <button type="button" className={BTN} aria-pressed={showResults} onClick={() => setShowResults((v) => !v)}>Results</button>
      <span className="mx-1 h-5 w-px bg-line" />
      <span role="group" aria-label="Reactions" className="flex items-center">
        {REACTIONS.map((r) => (
          <button key={r} type="button" className={BTN} aria-label={`React ${r}`} onClick={() => f.react(r)}>{r}</button>
        ))}
      </span>
      <form
        className="flex items-center"
        onSubmit={(e) => { e.preventDefault(); f.say(draft); setDraft(""); }}
      >
        <input
          aria-label="Say something at your cursor"
          placeholder="Say something…"
          maxLength={CHAT_MAX}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-7 w-36 rounded-md bg-surface-3 px-2 text-[12px] outline-none focus-visible:shadow-[var(--ring)]"
        />
      </form>
      <span className="mx-1 h-5 w-px bg-line" />
      <label className="flex items-center gap-1 px-1 text-fg-muted">
        Follow
        <select
          aria-label="Follow"
          value={f.following ?? ""}
          onChange={(e) => f.follow(e.target.value || null)}
          className="h-7 rounded-md bg-surface-3 px-1 text-[12px] text-fg outline-none focus-visible:shadow-[var(--ring)]"
        >
          <option value="">Nobody</option>
          {others.map((p) => <option key={p.clientId} value={p.clientId}>{p.nickname}</option>)}
        </select>
      </label>
      {showResults && (
        <ol aria-label="Voting results" className="mt-1 flex w-full flex-col gap-0.5 border-t border-line px-1 pt-1">
          {ranked.length === 0 && <li className="text-fg-subtle">No dots yet.</li>}
          {ranked.slice(0, 8).map((r) => (
            <li key={r.id}>
              <button type="button" className={`${BTN} flex w-full items-center gap-2 text-left`} onClick={() => useScene.getState().setSelection([r.id])}>
                <span className="w-5 font-semibold tabular-nums text-fg">{r.votes}</span>
                <span className="truncate">{scene?.nodes.get(r.id)?.name ?? r.id}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
