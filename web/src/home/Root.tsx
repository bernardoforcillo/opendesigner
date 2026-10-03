import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { App } from "../ui/App";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { Home } from "./Home";
import { routeFromHash } from "./route";

// LA RADICE: sceglie fra Home ed editor guardando l'hash (vedi route.ts). Nessun
// router esterno: l'unico stato di navigazione è `location.hash`, quindi i link
// `#doc=` condivisi, il tasto Indietro del browser e "Torna alla Home" funzionano
// tutti per lo stesso motivo.

const APP_TITLE = "opendesigner";

/** Il titolo della scheda del browser: `Nome — opendesigner` (o solo l'app, in Home). */
export function documentTitleFor(docName: string | null): string {
  return docName ? `${docName} — ${APP_TITLE}` : APP_TITLE;
}

function useBrowserTitle(inEditor: boolean) {
  const name = useScene((s) => s.scene?.name ?? "");
  const title = inEditor ? documentTitleFor(name.trim() === "" ? null : name) : documentTitleFor(null);
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export function Root({ editor = <App />, home }: { editor?: ReactNode; home?: ReactNode } = {}) {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const route = routeFromHash(hash);
  useBrowserTitle(route.kind === "doc");

  if (route.kind === "home") return <>{home ?? <Home focusTemplates={route.focusTemplates} />}</>;
  // `key` = l'id: passare da un documento a un altro (un link incollato, il tasto
  // Indietro) rimonta l'editor da zero, con un SyncClient nuovo.
  return <EditorHost key={route.id}>{editor}</EditorHost>;
}

// Il guscio dell'editor. L'editor condivide gli store (scena, vista dei flussi)
// con il resto dell'app, che sono globali: uscendo vanno riportati allo stato
// iniziale, altrimenti il documento successivo si aprirebbe mostrando per un
// istante il disegno del precedente, nella sua modalità e col suo prototipo
// aperto.
function EditorHost({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const reset = () => {
      useScene.getState().setScene(null);
      const ui = useFlowUi.getState();
      ui.setPresenting(false);
      ui.setMode("design");
      ui.setCurrentFlow(null);
    };
    reset();
    return reset;
  }, []);
  return <>{children}</>;
}
