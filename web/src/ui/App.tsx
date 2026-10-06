import { useEffect, useRef, useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { Banner, Icon } from "./ds";
import { ToolDock } from "./shell/ToolDock";
import { ISLAND_CLS, TopBar } from "./shell/TopBar";
import { usePanels } from "./shell/panels";
import { SyncClient } from "../rpc/syncClient";
import { PresenceClient } from "../rpc/presence";
import { usePresence, loadNickname } from "../store/presence";
import { useFacilitation, tally } from "../store/facilitation";
import { FacilitationBar } from "./FacilitationBar";
import { drawLayoutDrop, drawPeers, drawVotes } from "../renderer/peersRenderer";
import { drawCommentPins } from "../renderer/commentsRenderer";
import { draftWorld, pinsOf } from "../comments/pins";
import { useCommentsUi } from "../store/commentsUi";
import { commentTool } from "../tools/commentTool";
import { CommentsPanel } from "./CommentsPanel";
import { PresenceBar } from "./PresenceBar";
import { useScene } from "../store/store";
import { resizeCanvasToDisplaySize } from "../renderer/canvasRenderer";
import { attachImageRecovery, imageCache } from "../renderer/imageCache";
import { SETTLE_MS } from "../renderer/layerCache";
import { SceneSurface } from "../renderer/sceneSurface";
import { useRenderer } from "../store/rendererChoice";
import { drawOverlay, drawNodeEdit } from "../renderer/overlayRenderer";
import { screenToWorld } from "../canvas/camera";
import { attachTools, eventToCanvasPoint } from "../tools/toolManager";
import { attachClipboardShortcuts } from "../tools/clipboard";
import { attachImageDrop } from "../tools/imageDrop";
import { HOME_TEMPLATES_PATH, docIdFromHash } from "../home/route";
import { useAppNavigate } from "../home/nav";
import { useRouteDocId } from "../home/DocIdContext";
import { DocUnavailable } from "../home/DocUnavailable";
import { CanvasOnboarding } from "../home/CanvasOnboarding";
import { TextEditorOverlay } from "./TextEditorOverlay";
import { LayersPanel } from "./LayersPanel";
import { ComponentsPanel } from "./ComponentsPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { PageBar } from "./PageBar";
import { FlowPanel } from "./FlowPanel";
import { ScreenMetaEditor } from "./ScreenMetaEditor";
import { PrototypePlayer } from "./PrototypePlayer";
import { ReadinessPanel } from "./dev/ReadinessPanel";
import { CodeWorkbench } from "./dev/CodeWorkbench";
import { ShipPanel } from "./dev/ShipPanel";
import { TimelinePanel } from "./timeline/TimelinePanel";
import { useTimeline } from "../animation/timelineStore";
import { posedScene } from "../animation/posedScene";
import { attachTimelineShortcuts } from "./timeline/shortcuts";
import { resolveFlow, useFlowUi, type EditorMode } from "../store/flowUi";
import { drawFlows } from "../renderer/flowRenderer";
import type { Tool, ToolContext, ToolId } from "../tools/types";
import { selectTool } from "../tools/selectTool";
import { rectTool } from "../tools/rectTool";
import { frameTool } from "../tools/frameTool";
import { ellipseTool } from "../tools/ellipseTool";
import { textTool } from "../tools/textTool";
import { penTool } from "../tools/penTool";
import { handTool } from "../tools/handTool";
import { connectTool } from "../tools/connectTool";
import { linkTool } from "../tools/linkTool";
import { stickyTool } from "../tools/stickyTool";
import { voteTool } from "../tools/voteTool";
import { nodeTool } from "../tools/nodeTool";
import { withFlowArrows } from "../tools/flowSelect";

// Registry of the available tools: the toolbar picks a key, attachTools
// routes events to the matching tool.
//
// Exported (with TOOL_LABELS) because they are the ONLY point where a ToolId
// becomes truly reachable: an entry in TOOL_LABELS without its entry
// here would silently fall back to selectTool (see the `?? selectTool` further
// below), that is a button that does not do what it says. It is an invariant, and
// as such it has a test (App.test.tsx) instead of a convention kept in memory.
export const TOOLS: Partial<Record<ToolId, Tool>> = {
  // In Flows mode the click first looks for an arrow (tools/flowSelect.ts); in
  // Design the wrapper delegates without changing anything.
  select: withFlowArrows(selectTool),
  connect: connectTool,
  frame: frameTool,
  rect: rectTool,
  ellipse: ellipseTool,
  text: textTool,
  pen: penTool,
  hand: handTool,
  comment: commentTool,
  sticky: stickyTool,
  link: linkTool,
  vote: voteTool,
  node: nodeTool,
};

export const TOOL_LABELS: { id: ToolId; label: string }[] = [
  { id: "select", label: "Select" },
  { id: "connect", label: "Connect" },
  { id: "sticky", label: "Sticky note" },
  { id: "link", label: "Link" },
  { id: "vote", label: "Vote" },
  { id: "frame", label: "Frame" },
  { id: "rect", label: "Rectangle" },
  { id: "ellipse", label: "Ellipse" },
  { id: "text", label: "Text" },
  { id: "pen", label: "Pen" },
  { id: "node", label: "Node" },
  { id: "hand", label: "Hand" },
  { id: "comment", label: "Comment" },
];

// The tools that make sense in Flows mode: flows do not draw, they
// connect the screens that already exist. "Connect" exists ONLY there.
const FLOW_TOOL_IDS: readonly ToolId[] = ["select", "connect", "hand"];
// In Develop the canvas is read-only: you look, you do not draw.
const DEV_TOOL_IDS: readonly ToolId[] = ["select", "hand"];
// The Board: notes, text, arrows and free drawing on an infinite page; no frames, no shapes of a layout.
const BOARD_TOOL_IDS: readonly ToolId[] = ["select", "sticky", "text", "link", "vote", "pen", "node", "hand", "comment"];
// Only the Board has these two.
const BOARD_ONLY: readonly ToolId[] = ["sticky", "link", "vote"];
function toolIdsOf(mode: EditorMode): readonly ToolId[] | null {
  return mode === "flows" ? FLOW_TOOL_IDS : mode === "dev" ? DEV_TOOL_IDS : mode === "board" ? BOARD_TOOL_IDS : null;
}
// Which tools the toolbar shows in a mode: in Design all except
// "Connect", in Flows and in Develop only those listed above.
export function toolsForMode(mode: EditorMode): { id: ToolId; label: string }[] {
  const ids = toolIdsOf(mode);
  return TOOL_LABELS.filter((t) => (ids ? ids.includes(t.id) : t.id !== "connect" && !BOARD_ONLY.includes(t.id)));
}

const CLIENT_ID = crypto.randomUUID();
const DOC_KEY = "opendesigner.docId";

// The document is chosen from the link: `/doc/<id>` (the router hands the id over
// through DocIdContext; the old `#doc=<id>` hash is still understood). It is what lets another
// computer on the same network enter the SAME document instead of
// creating its own (localStorage is per-browser, so alone it is not enough).
// A malformed id is ignored: HubFor would reject it anyway.
// The parsing lives in home/route.ts (the Root uses it to choose between Home and
// editor); here it is re-exported because it has always been an export of this module.
export { docIdFromHash };

// A text field (input/textarea/contentEditable): Ctrl/Cmd+Z inside it is
// the field's own business (undoing the typing), not the scene's --
// it will be needed in M1b when the first editable field arrives (text, properties).
// Duck-typing on the target as in tools/toolManager.ts::swallowsSpace: same
// reason, tests can pass events without a real HTMLElement.
function isTextField(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function App() {
  const routeDocId = useRouteDocId();
  const navigate = useAppNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  // The renderer's WebGL canvas on GPU, BELOW the 2D one (which stays on top because
  // it receives events): see renderer/sceneSurface.ts.
  const glRef = useRef<HTMLCanvasElement>(null);
  // The manager reads the active tool from a ref: attachTools is wired
  // only once at mount, so it must not depend on the closure's identity.
  const toolRef = useRef<ToolId>("select");
  // The nickname lives in a ref as well as in state: the bootstrap starts
  // only once and must read the CURRENT one when it opens presence.
  const [nickname, setNickname] = useState(loadNickname);
  // The left panel's tab. The comment tool brings Comments to the front (revealRequested), and
  // opens the left panel if it was closed.
  const [leftTab, setLeftTab] = useState("layers");
  const reveal = useCommentsUi((c) => c.revealRequested);
  useEffect(() => {
    if (reveal === 0) return;
    setLeftTab("comments");
    if (!usePanels.getState().left) usePanels.getState().toggle("left");
  }, [reveal]);
  const nicknameRef = useRef(nickname);
  const presenceRef = useRef<PresenceClient | null>(null);
  const [toolId, setToolId] = useState<ToolId>("select");
  // The document does not open (it does not exist): in place of the editor, a card with "Back to Home".
  const [docError, setDocError] = useState<{ notFound: boolean; message: string } | null>(null);
  // The mode (Design | Flows) and the prototype: view state in useFlowUi.
  const mode = useFlowUi((st) => st.mode);
  const presenting = useFlowUi((st) => st.presenting);
  // Changes the active tool: the ref is read by the tool manager, the state by the toolbar.
  const chooseTool = (id: ToolId) => {
    toolRef.current = id;
    setToolId(id);
    useScene.getState().enterNodeEdit(id === "node");
  };
  // An op rejected by the server is undone locally (the optimistic change
  // disappears from the canvas, see store/store.ts::rejectPending). A
  // SILENT rollback is almost worse than no rollback: here is the only place
  // where the user can understand why the rectangle they just drew vanished.
  // Subscriptions with a selector: the rest of the UI does not redraw on every op.
  const lastError = useScene((s) => s.lastError);
  const clearError = useScene((s) => s.clearError);
  // The opposite of lastError: a change given up for lost that turned out
  // to be saved (store.ts: rollback revocation). It must be said, and said in a
  // DIFFERENT banner -- announcing it in the red one, under the text "change
  // not saved and rolled back", would be the second lie after the first.
  const notice = useScene((s) => s.notice);
  const clearNotice = useScene((s) => s.clearNotice);
  // The connection status (store.ts::ConnectionStatus) and its why. It is not
  // dismissible like lastError: the condition does not pass because the user closes
  // a notice, and while it lasts the changes stay optimistic -- they must be able to know it
  // BEFORE continuing to work, not at the next reload.
  const connection = useScene((s) => s.connection);
  const syncError = useScene((s) => s.syncError);
  // The node being written (turned on by textTool at creation and by selectTool's
  // double click). It is the ONLY point where the editing field
  // becomes reachable by the user: without this line TextEditorOverlay is
  // compiled code that nobody mounts, and text can be created but not
  // written. A selector, so the app redraws only when entering or
  // leaving editing.
  const editingNodeId = useScene((s) => s.editingNodeId);

  // bootstrap: document + SyncClient + tools
  useEffect(() => {
    let cleanup = () => {};
    let cancelled = false;
    // The client must be kept HERE and not inside the async: the cleanup must be able to
    // stop it even when the unmount arrives while the bootstrap is still
    // halfway. Without stop(), StrictMode (main.tsx) leaves an orphan subscription
    // for the whole session: two streams on the server and every remote record
    // applied twice in the same store.
    let sync: SyncClient | null = null;

    (async () => {
      try {
        // The link wins over localStorage: whoever receives an invite wants THAT
        // document, not the last one they had opened. The editor NO longer creates
        // documents on its own: the Root (home/Root.tsx) mounts it only with a
        // `/doc/<id>` route, and documents are born from Home. Without an id (never in
        // production) it is an error, not a surprise empty document.
        const docId = routeDocId ?? docIdFromHash(location.hash) ?? localStorage.getItem(DOC_KEY);
        if (!docId) throw new Error("no document to open");
        localStorage.setItem(DOC_KEY, docId);
        sync = new SyncClient(docId, CLIENT_ID);
        // Unmounted while we were creating the client: stop it before even
        // opening the document (start() on a stopped client is a no-op).
        if (cancelled) {
          sync.stop();
          return;
        }
        await sync.start();
        // The effect may already have been unmounted (StrictMode in dev, or quick
        // unmount): in that case do not attach listeners nobody will remove.
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        // The context is the only bridge between the tools and the rest of the app: store,
        // camera and the sole screen -> world conversion (via canvas/camera.ts).
        const ctx: ToolContext = {
          sync,
          canvas,
          // The scene that is SEEN: with the timeline posed it is the derived one (so
          // what is on screen is dragged, not the base value); otherwise it is
          // the same instance as the store (animation/posedScene.ts).
          getScene: () => posedScene(),
          getCamera: () => useScene.getState().camera,
          setCamera: (c) => useScene.getState().setCamera(c),
          toWorld: (e) => {
            const p = eventToCanvasPoint(canvas, e);
            return screenToWorld(useScene.getState().camera, p.x, p.y);
          },
        };
        // Presence: who else is here, and where my cursor and selection are.
        // It starts after sync.start() because it must never delay the document.
        const presence = new PresenceClient(docId, CLIENT_ID, nicknameRef.current);
        presenceRef.current = presence;
        presence.start();
        const onMove = (e: PointerEvent) => {
          const w = ctx.toWorld(e);
          presence.setLocal({ hasCursor: true, cursorX: w.x, cursorY: w.y });
        };
        const onLeave = () => presence.setLocal({ hasCursor: false });
        canvas.addEventListener("pointermove", onMove);
        canvas.addEventListener("pointerleave", onLeave);
        const sendView = () => {
          const st = useScene.getState();
          // The EFFECTIVE page: with currentPageId null the view shows the first.
          presence.setLocal({ selection: st.selection, pageId: st.currentPageId ?? st.scene?.pages[0]?.id ?? "" });
        };
        sendView();
        const unsubView = useScene.subscribe((st, prev) => {
          if (st.selection !== prev.selection || st.currentPageId !== prev.currentPageId) sendView();
        });
        // Facilitation: my dots, timer, chat and reaction, and where my view is (the WORLD point at the
        // center of the canvas, so someone following with another window size sees the same thing).
        const sendFacilitation = () => {
          const f = useFacilitation.getState();
          presence.setLocal({
            chat: f.chat, reaction: f.reaction, emoteSeq: f.emoteSeq, votes: f.votes,
            timerStartedMs: f.timer?.startedMs ?? 0, timerEndMs: f.timer?.endMs ?? 0, timerLabel: f.timer?.label ?? "",
          });
        };
        const sendCamera = () => {
          const cam = useScene.getState().camera;
          const c = screenToWorld(cam, canvas.clientWidth / 2, canvas.clientHeight / 2);
          presence.setLocal({ hasView: true, viewX: c.x, viewY: c.y, viewZoom: cam.zoom });
        };
        sendFacilitation();
        sendCamera();
        const unsubFac = useFacilitation.subscribe(sendFacilitation);
        const unsubCam = useScene.subscribe((st, prev) => { if (st.camera !== prev.camera) sendCamera(); });
        // Follow mode: while someone is followed, my camera takes theirs on every update they send;
        // if they leave, I stop following.
        const unsubFollow = usePresence.subscribe((st) => {
          const id = useFacilitation.getState().following;
          if (!id) return;
          const p = st.peers[id];
          if (!p) { useFacilitation.getState().follow(null); return; }
          if (!p.hasView) return;
          const cur = useScene.getState().camera;
          const next = { x: canvas.clientWidth / 2 - p.viewX * p.viewZoom, y: canvas.clientHeight / 2 - p.viewY * p.viewZoom, zoom: p.viewZoom };
          if (Math.abs(next.x - cur.x) > 0.5 || Math.abs(next.y - cur.y) > 0.5 || next.zoom !== cur.zoom) useScene.getState().setCamera(next);
        });
        const detachTools = attachTools(ctx, () => TOOLS[toolRef.current] ?? selectTool);
        // Dragging an image onto the canvas (track 3, task 3). It sits next to the
        // tools and not inside the registry because it is not a tool: it has no button
        // in the toolbar and no mode -- the drop works whatever tool is
        // active. The point goes through the SAME screen -> world conversion as the
        // tools (ctx.toWorld); a DragEvent has clientX/clientY like a
        // PointerEvent, which is all that conversion reads.
        const detachDrop = attachImageDrop(canvas, (e) => ctx.toWorld(e as PointerEvent));
        cleanup = () => {
          detachTools();
          detachDrop();
          canvas.removeEventListener("pointermove", onMove);
          canvas.removeEventListener("pointerleave", onLeave);
          unsubView();
          unsubFac();
          unsubCam();
          unsubFollow();
          presence.stop();
          presenceRef.current = null;
        };
      } catch (err) {
        console.error("bootstrap failed", err);
        // A failed bootstrap is a connection state like the others: it does not
        // recover on its own (no stream to resubscribe), so "error".
        // A document that does not exist (wrong link, deleted) instead has its
        // own card with the exit towards Home.
        if (!cancelled) {
          const ce = ConnectError.from(err);
          if (ce.code === Code.NotFound) setDocError({ notFound: true, message: ce.message });
          else useScene.getState().setConnection("error", ce.message);
        }
      }
    })();

    return () => {
      cancelled = true;
      sync?.stop();
      cleanup();
    };
  }, []);

  // THE DRAWING LOOP, ON INVALIDATION. Scene and overlay are two separate
  // canvases (scene below, overlay above, see the "relative" container further
  // below) so the overlay -- selection bbox, handles, marquee -- can
  // redraw in screen space without ever touching the scene's pixels.
  //
  // It used to run at 60 fps ALWAYS, even with the editor idle: redrawing the whole
  // scene sixty times a second for nothing (battery, fan, and a large
  // document leaving no room for anything else). Now ONE frame is drawn
  // every time something visible has changed: the scene or the
  // camera/selection/previews (the store), other users (presence), an
  // image that arrived, a font that loaded, the canvas resized. Several
  // invalidations in the same frame make only one.
  //
  // The scene goes through SceneLayerCache: a heavy document, while only the
  // camera moves, reuses the last image instead of redrawing, and when
  // the movement ends (SETTLE_MS) it redoes the exact frame.
  useEffect(() => {
    // The real drawing is done by SceneSurface: it chooses between Canvas 2D (CPU) and CanvasKit
    // (GPU) and falls back to the CPU if the GPU fails. Without the WebGL canvas (tests
    // under jsdom) it always draws on the CPU.
    const surface = canvasRef.current && glRef.current
      ? new SceneSurface(canvasRef.current, glRef.current, imageCache, () => invalidate())
      : null;
    let raf = 0;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let force = false;

    const frame = () => {
      raf = 0;
      // In Develop the canvas is covered by the code view: nothing to draw (and
      // no work). Going back to Design/Flows the view store invalidates.
      if (useFlowUi.getState().mode === "dev") return;
      const canvas = canvasRef.current;
      const overlay = overlayRef.current;
      // The posed scene when the timeline scrubs/plays/records, otherwise
      // the store's scene (same instance: no cost with the timeline idle).
      const scene = posedScene(true);
      if (canvas && scene) {
        resizeCanvasToDisplaySize(canvas);
        const ctx = canvas.getContext("2d");
        if (ctx && surface) {
          const exact = surface.draw(scene, useScene.getState().camera, useScene.getState().currentPageId, force);
          force = false;
          if (settle) clearTimeout(settle);
          settle = exact
            ? null
            : setTimeout(() => {
                settle = null;
                force = true;
                invalidate();
              }, SETTLE_MS);
        }
      }
      if (overlay && scene) {
        resizeCanvasToDisplaySize(overlay);
        const octx = overlay.getContext("2d");
        // snapGuides: the alignment guides of the gesture in progress (T2).
        // penPreview: the path the pen tool is drawing. Neither is
        // document (the vector node does not exist until the path is finished),
        // so they go from the store to the overlay like the marquee -- and it is the ONLY
        // way the person drawing sees what they are doing.
        const { camera, selection, marquee, snapGuides, penPreview, linkPreview } = useScene.getState();
        if (octx) {
          // While the clip PLAYS the handles are not drawn: they would sit on
          // a geometry that changes every frame (and the animated scale is not in the
          // selection box). Paused or scrubbing they follow the posed geometry.
          drawOverlay(octx, scene, camera, useTimeline.getState().playing ? [] : selection, marquee, snapGuides, penPreview, linkPreview);
          const peers = usePresence.getState().peers;
          if (Object.keys(peers).length > 0) {
            drawPeers(octx, scene, camera, peers, useScene.getState().currentPageId ?? null);
          }
          {
            const ne = useScene.getState().nodeEdit;
            if (ne) drawNodeEdit(octx, scene, camera, selection, ne.sel);
          }
          {
            const votes = tally(peers, useFacilitation.getState().votes);
            if (Object.keys(votes).length > 0) drawVotes(octx, scene, camera, votes, useFacilitation.getState().votes);
          }
          // Comment pins (all modes): the threads of this page, plus the pin being placed.
          {
            const cu = useCommentsUi.getState();
            const pageId = useScene.getState().currentPageId ?? scene.pages[0]?.id ?? "";
            const pins = Object.keys(scene.comments).length > 0 ? pinsOf(scene, pageId, cu.showResolved) : [];
            if (pins.length > 0 || cu.draft) {
              drawCommentPins(octx, pins, camera, cu.activeId, cu.draft ? draftWorld(scene, cu.draft) : null);
            }
          }
          const layoutDrop = useScene.getState().layoutDrop;
          if (layoutDrop) drawLayoutDrop(octx, camera, layoutDrop);
          // The flows' arrows, above everything else of the overlay.
          const fu = useFlowUi.getState();
          if (fu.mode === "flows") {
            const flow = resolveFlow(scene, fu.currentFlowId);
            drawFlows(octx, scene, camera, {
              flowId: flow?.id ?? null,
              startId: flow?.startId ?? "",
              showAllFlows: fu.showAllFlows,
              selectedTransitionId: fu.selectedTransitionId,
              hoverTransitionId: fu.hoverTransitionId,
              connectPreview: fu.connectPreview,
              issueNodeIds: fu.issueNodeIds,
              issueTransitionIds: fu.issueTransitionIds,
            }, useScene.getState().currentPageId ?? null);
          }
        }
      }
    };

    const invalidate = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const unsubs = [
      useScene.subscribe(invalidate),
      usePresence.subscribe(invalidate),
      useFacilitation.subscribe(invalidate),
      useFlowUi.subscribe(invalidate),
      useCommentsUi.subscribe(invalidate),
      // The playhead, the pose and the recording draft: the playback tick
      // is the only frame producer while animating, with the timeline idle nothing
      // arrives and the editor stays at zero frames.
      useTimeline.subscribe(invalidate),
      imageCache.subscribe(invalidate),
      // Changing renderer (or its choice, which a GPU failure brings back to
      // CPU) must be redrawn right away.
      useRenderer.subscribe((st, prev) => {
        if (st.choice !== prev.choice) invalidate();
      }),
    ];
    // Resizing the canvas empties it: it must be redrawn. ResizeObserver is not
    // in every environment (jsdom): there the initial frame is enough.
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(invalidate) : null;
    if (canvasRef.current) observer?.observe(canvasRef.current);
    // A font that arrives changes the text measures.
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", invalidate);
    window.addEventListener("resize", invalidate);
    invalidate();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (settle) clearTimeout(settle);
      for (const u of unsubs) u();
      observer?.disconnect();
      surface?.dispose();
      fonts?.removeEventListener?.("loadingdone", invalidate);
      window.removeEventListener("resize", invalidate);
    };
  }, []);

  // Undo/redo shortcuts: on the window (not on the canvas) because the canvas is
  // not focusable -- same reason toolManager.ts listens to Escape/Delete
  // there. Ctrl (Windows/Linux) or Cmd (Mac, e.metaKey) + Z = undo, + Shift+Z (or
  // Ctrl+Y) = redo. Ignored inside a text field (isTextField) and ALWAYS
  // with preventDefault when handled, otherwise Ctrl+Z also does the browser's
  // native undo (e.g. on a contentEditable) in parallel to ours.
  //
  // Extra guard on useScene.getState().gesture (bug found in review): a
  // gesture (selectTool drag -- move/resize) stays open until the
  // pointerup arrives, regardless of the keyboard. If Ctrl/Cmd+Z
  // arrives mid-drag, store.ts::undo()/redo() are already the guard that
  // counts (they block by themselves, for any caller): this check here is
  // defense in depth, not the only barrier. preventDefault stays anyway
  // to avoid the browser's native undo.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextField(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      const isRedo = (key === "z" && e.shiftKey) || key === "y";
      const isUndo = key === "z" && !e.shiftKey;
      if (!isRedo && !isUndo) return;
      e.preventDefault();
      if (useScene.getState().gesture) return; // gesture in progress: deferred, see store.ts
      if (isRedo) useScene.getState().redo();
      else useScene.getState().undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Mode shortcuts: F toggles Design / Flows, B opens the Board (and back), S opens Develop (and
  // S again goes back to Design), K activates "Connect" (entering Flows if needed). On the window, like the others, and
  // never inside a text field (isTextField) nor with a modifier pressed
  // (Ctrl+Alt+K belongs to the selection tool).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextField(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (useFlowUi.getState().presenting) return;
      const key = e.key.toLowerCase();
      if (key === "f") {
        e.preventDefault();
        useFlowUi.getState().toggleMode();
      } else if (key === "s") {
        e.preventDefault();
        const fu = useFlowUi.getState();
        fu.setMode(fu.mode === "dev" ? "design" : "dev");
      } else if (key === "b") {
        e.preventDefault();
        const fu = useFlowUi.getState();
        fu.setMode(fu.mode === "board" ? "design" : "board");
      } else if (key === "k") {
        e.preventDefault();
        useFlowUi.getState().setMode("flows");
        chooseTool("connect");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // chooseTool writes a ref and a setState: stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving Flows brings the tool back to "Select" if it was "Connect"; entering
  // Flows does so if it was a drawing tool: nothing is drawn in flows.
  useEffect(() => {
    const ids = toolIdsOf(mode);
    if (ids ? !ids.includes(toolRef.current) : toolRef.current === "connect" || BOARD_ONLY.includes(toolRef.current)) chooseTool("select");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Copy / paste / duplicate (Ctrl/Cmd+C, +V, +D). On the window like the
  // shortcuts above and for the same reason (the canvas is not focusable);
  // the logic is all in tools/clipboard.ts, here there is only the mounting --
  // which however is the only point where the function becomes reachable.
  useEffect(() => attachClipboardShortcuts(), []);

  // M opens/closes the timeline (ui/timeline/shortcuts.ts).
  useEffect(() => attachTimelineShortcuts(), []);

  // Images that failed to load are retried when the network comes back or
  // when the tab returns to the foreground (track 3, task 3). Without it, a
  // momentary outage would leave that node as a placeholder for the whole
  // life of the page, with the file still there on disk.
  useEffect(() => attachImageRecovery(), []);

  // The pill said "connected" even with a dead stream: the bootstrap had succeeded
  // and nobody looked at that state again. Now it is SyncClient that
  // keeps `connection` up to date for the whole life of the stream, reconnections
  // included, and the pill just reads it.
  const statusLabel =
    connection === "connected"
      ? "connected"
      : connection === "reconnecting"
        ? "reconnecting…"
        : connection === "error"
          ? "disconnected"
          : "connecting…";

  const leftOpen = usePanels((s) => s.left);
  const rightOpen = usePanels((s) => s.right);

  if (docError) return <DocUnavailable notFound={docError.notFound} message={docError.message} />;

  return (
    <div className="flex h-screen flex-col gap-2 bg-surface-3 p-2 text-fg">
      {/* Two different notices because the two situations ask for different things: while
          reconnecting the user can wait (changes stay queued and
          the backlog will confirm them), with attempts exhausted they cannot. */}
      {connection === "reconnecting" && (
        <Banner tone="warn">
          Connection to the server lost ({syncError}). Reconnecting: changes made
          in the meantime stay queued and will be confirmed on return.
        </Banner>
      )}
      {connection === "error" && (
        <Banner tone="warn">
          Connection to the server lost ({syncError}). Reconnection attempts are over: changes
          are no longer confirmed, reload the page to resume.
        </Banner>
      )}
      {lastError && (
        <Banner tone="danger" onClose={clearError}>Change not saved and rolled back: {lastError}</Banner>
      )}
      {notice && <Banner tone="info" onClose={clearNotice}>{notice}</Banner>}
      {/* The document bar: a full-width island above the columns. */}
      <TopBar mode={mode} presence={<PresenceBar compact nickname={nickname} onNickname={(n) => { nicknameRef.current = n; setNickname(n); presenceRef.current?.setNickname(n); }} />} onNewDocument={() => navigate(HOME_TEMPLATES_PATH)} connection={connection} statusLabel={statusLabel} />
      {/* THE THREE COLUMNS: left panel, canvas in the middle, properties on the right.
          `min-h-0` on the row and `min-w-0` on the central column are not
          decorations: without them, a flex child NEVER shrinks below its own
          natural size, and a long list is enough for the row to burst
          the window's height pushing the canvas off screen.
          The panels are SIBLINGS of the canvas, they do not sit on top of it: they do not steal
          events and the width they occupy is taken away from the layout (the canvas
          resizes on its own: resizeCanvasToDisplaySize reads clientWidth on
          every frame and eventToCanvasPoint starts from getBoundingClientRect).
          Each column is an island (ISLAND_CLS) set apart from the others by the gap. */}
      <div className="flex min-h-0 flex-1 gap-2">
        {mode === "dev" ? (
          <aside aria-label="Readiness" className={`${leftOpen ? "flex" : "hidden"} w-72 shrink-0 flex-col overflow-hidden ${ISLAND_CLS}`}>
            <ReadinessPanel />
          </aside>
        ) : mode === "flows" ? (
          <aside aria-label="Flows" className={`${leftOpen ? "flex" : "hidden"} w-72 shrink-0 flex-col overflow-hidden ${ISLAND_CLS}`}>
            <FlowPanel />
          </aside>
        ) : (
          <aside aria-label="Layers and components" className={`${leftOpen ? "flex" : "hidden"} w-64 shrink-0 flex-col overflow-hidden ${ISLAND_CLS}`}>
            <Tabs className="flex min-h-0 flex-1 flex-col" selectedKey={leftTab} onSelectionChange={(k) => setLeftTab(String(k))}>
              {/* Tabs and page selector in the SAME row: 40px less. */}
              <div className="flex shrink-0 items-center border-b border-line pr-1.5">
              <TabList aria-label="Panel" className="flex min-w-0 flex-1 gap-0.5 px-1.5 pt-1">
                {([["layers", "Layers", "layers"], ["components", "Components", "components"], ["comments", "Comments", "comment"]] as const).map(([id, label, icon]) => (
                  <Tab
                    key={id}
                    id={id}
                    aria-label={label}
                    className={({ isSelected }) =>
                      `flex h-9 cursor-default items-center gap-1.5 border-b-2 px-1.5 text-[13px] font-medium outline-none ` +
                      `focus-visible:shadow-[var(--ring)] ` +
                      (isSelected ? "border-accent text-fg" : "border-transparent text-fg-subtle hover:text-fg")
                    }
                  >
                    {({ isSelected }) => (
                      <>
                        <Icon name={icon} size={14} />
                        {/* Only the active tab carries the text: the row also hosts the
                            page selector. The name stays in the aria-label. */}
                        {isSelected && id !== "comments" && label}
                      </>
                    )}
                  </Tab>
                ))}
              </TabList>
              <PageBar compact />
              </div>
              <TabPanel id="layers" className="min-h-0 flex-1 overflow-hidden outline-none">
                <LayersPanel />
              </TabPanel>
              <TabPanel id="components" className="min-h-0 flex-1 overflow-y-auto outline-none">
                <ComponentsPanel />
              </TabPanel>
              <TabPanel id="comments" className="min-h-0 flex-1 overflow-hidden outline-none">
                <CommentsPanel />
              </TabPanel>
            </Tabs>
          </aside>
        )}
        {/* The central column: the canvas and, below, the timeline (only in Design, opened
            with M or from the dock). The timeline is a SIBLING of the canvas like the side
            panels: the canvas resizes on its own (resize -> invalidation). */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-canvas">
          {/* The cursor comes from the active tool; during a temporary pan (space
              or middle button) the tool manager overrides it on the DOM. */}
          {/* The GPU's WebGL canvas: below, without events, hidden until the
              GPU is chosen and ready. */}
          <canvas
            id="scene-gl"
            ref={glRef}
            style={{ display: "none" }}
            className="pointer-events-none absolute inset-0 block h-full w-full"
          />
          <canvas
            id="scene"
            ref={canvasRef}
            style={{ cursor: (TOOLS[toolId] ?? selectTool).cursor }}
            className="absolute inset-0 block h-full w-full touch-none"
          />
          {/* overlay: selection bbox + handles + marquee, in screen space.
              pointer-events-none: all listeners stay on the "scene" canvas,
              the overlay is purely visual and must not steal events. */}
          <canvas id="overlay" ref={overlayRef} className="pointer-events-none absolute inset-0 block h-full w-full" />
          {/* Onboarding: "Where do you start?" on an empty document, then the first steps. It does not
              capture the canvas's events outside the card (home/CanvasOnboarding.tsx). */}
          <CanvasOnboarding onDrawScreen={() => chooseTool("frame")} />
          {/* The text editing field: INSIDE this container because it is
              positioned `absolute` on the node's screen coordinates, and above
              the two canvases because it must cover them. `key`: one session per node,
              so going from one text to another remounts the field instead of
              reusing it. */}
          {editingNodeId && <TextEditorOverlay key={editingNodeId} nodeId={editingNodeId} />}
          {/* Develop: the code view covers the canvas (which stays mounted: the tools and the
              drawing loop use it) and sits BELOW the dock (z-20). */}
          {mode === "dev" && <CodeWorkbench />}
          {mode === "board" && <FacilitationBar myId={CLIENT_ID} />}
          <ToolDock tools={toolsForMode(mode)} toolId={toolId} onChoose={chooseTool} mode={mode} />
        </div>
        {mode === "design" && <TimelinePanel />}
        </div>
        <aside aria-label={mode === "dev" ? "Ship" : "Properties"} className={`${rightOpen ? "block" : "hidden"} ${mode === "dev" ? "w-72" : "w-64"} shrink-0 overflow-hidden ${ISLAND_CLS}`}>
          {mode === "dev" ? (
            <ShipPanel />
          ) : mode === "flows" ? (
            // The screen's metadata at the top, the usual properties below.
            <div className="flex h-full flex-col">
              <ScreenMetaEditor />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <PropertiesPanel />
              </div>
            </div>
          ) : (
            <PropertiesPanel />
          )}
        </aside>
      </div>
      {presenting && <PrototypePlayer onClose={() => useFlowUi.getState().setPresenting(false)} />}
    </div>
  );
}
