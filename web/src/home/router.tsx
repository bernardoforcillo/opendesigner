import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  Outlet,
  RouterProvider,
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { parseAsBoolean, parseAsStringLiteral, useQueryState } from "nuqs";
import { App } from "../ui/App";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { useRenderer } from "../store/rendererChoice";
import { Home } from "./Home";
import { DocIdContext } from "./DocIdContext";
import { legacyRedirect, normalizeDocId } from "./route";
import { documentTitleFor } from "./title";

// THE APP ROUTER (TanStack Router, path history) + the query-string state
// (nuqs). The routes are described in route.ts; the shared links are
// `/doc/<id>`. The server answers index.html for those paths (internal/server/webui.go).

export const RENDERERS = ["cpu", "gpu"] as const;

type HomeSearch = { templates?: true };
type DocSearch = { renderer?: (typeof RENDERERS)[number] };

export interface RouterSlots {
  /** The editor (tests pass a stand-in). */
  editor?: ReactNode;
  /** The Home (tests pass a stand-in). */
  home?: ReactNode;
}

export function createAppRouter({ editor, home, history }: RouterSlots & { history?: RouterHistory } = {}) {
  const rootRoute = createRootRoute({
    // Links from before the router: `#doc=<id>` and `#new`.
    beforeLoad: ({ location }) => {
      const r = legacyRedirect(location.hash);
      if (r?.to === "/doc/$docId") throw redirect({ to: r.to, params: r.params, replace: true });
      if (r?.to === "/") throw redirect({ to: r.to, search: r.search, replace: true });
    },
    component: () => (
      <NuqsAdapter>
        <TitleSync />
        <Outlet />
      </NuqsAdapter>
    ),
  });

  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    validateSearch: (s: Record<string, unknown>): HomeSearch => (s.templates === true || s.templates === "true" ? { templates: true } : {}),
    component: function HomeRoute() {
      const [templates] = useQueryState("templates", parseAsBoolean.withDefault(false));
      return <>{home ?? <Home focusTemplates={templates} />}</>;
    },
  });

  const docRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/doc/$docId",
    validateSearch: (s: Record<string, unknown>): DocSearch =>
      s.renderer === "cpu" || s.renderer === "gpu" ? { renderer: s.renderer } : {},
    // An id that is not a well-formed one is not an editor: back to Home.
    beforeLoad: ({ params }) => {
      if (!normalizeDocId(params.docId)) throw redirect({ to: "/", replace: true });
    },
    component: function DocRoute() {
      const { docId } = docRoute.useParams();
      // `key` = the id: switching from one document to another (a pasted link, the
      // Back button) remounts the editor from scratch, with a new SyncClient.
      return (
        <DocIdContext.Provider value={docId.toLowerCase()}>
          <EditorHost key={docId}>{editor ?? <App />}</EditorHost>
        </DocIdContext.Provider>
      );
    },
  });

  return createRouter({
    routeTree: rootRoute.addChildren([homeRoute, docRoute]),
    history: history ?? createBrowserHistory(),
    // The only dynamic content is the editor itself; no data loading.
    defaultPreload: false,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

export function AppRouter({ router }: { router: ReturnType<typeof createAppRouter> }) {
  return <RouterProvider router={router} />;
}

/** The browser tab title: the document's name in the editor, the app's in Home. */
function TitleSync() {
  const inEditor = useLocation({ select: (l) => l.pathname.startsWith("/doc/") });
  const name = useScene((s) => s.scene?.name ?? "");
  const title = documentTitleFor(inEditor && name.trim() !== "" ? name : null);
  useEffect(() => {
    document.title = title;
  }, [title]);
  return null;
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
  return (
    <>
      <RendererQuerySync />
      {children}
    </>
  );
}

// `?renderer=cpu|gpu` <-> the renderer choice. The URL wins on load (the store
// is already initialised from it) and follows later changes of the choice, so
// the link in the address bar reproduces what you see.
function RendererQuerySync() {
  const [param, setParam] = useQueryState("renderer", parseAsStringLiteral(RENDERERS));
  const choice = useRenderer((s) => s.choice);
  const setChoice = useRenderer((s) => s.setChoice);
  useLayoutEffect(() => {
    if (param && param !== useRenderer.getState().choice) setChoice(param);
  }, [param, setChoice]);
  // Only CHANGES of the choice are written to the URL (not the initial value, which
  // came from it or from the saved preference): otherwise the two effects
  // would chase each other on the first render.
  const previous = useRef(choice);
  useLayoutEffect(() => {
    if (previous.current === choice) return;
    previous.current = choice;
    // Keep the address bar clean until the choice leaves the default.
    const wanted = choice === "gpu" ? "gpu" : param === null ? null : "cpu";
    if (wanted !== param) void setParam(wanted, { history: "replace" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice]);
  return null;
}
