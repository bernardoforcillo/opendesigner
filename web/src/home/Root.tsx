import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { App } from "../ui/App";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { Home } from "./Home";
import { routeFromHash } from "./route";

// THE ROOT: chooses between Home and editor by looking at the hash (see route.ts). No
// external router: the only navigation state is `location.hash`, so the shared
// `#doc=` links, the browser's Back button and "Back to Home" all work
// for the same reason.

const APP_TITLE = "opendesigner";

/** The browser tab title: `Name — opendesigner` (or just the app, in Home). */
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
  // `key` = the id: switching from one document to another (a pasted link, the Back
  // button) remounts the editor from scratch, with a new SyncClient.
  return <EditorHost key={route.id}>{editor}</EditorHost>;
}

// The editor shell. The editor shares the stores (scene, flows view)
// with the rest of the app, which are global: on exit they must be brought back to the
// initial state, otherwise the next document would open showing for an
// instant the previous one's drawing, in its mode and with its prototype
// open.
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
