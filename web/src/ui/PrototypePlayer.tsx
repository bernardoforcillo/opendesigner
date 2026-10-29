import { resolveScene } from "@/store/variables";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button as RacButton } from "react-aria-components";
import { useScene } from "@/store/store";
import { resolveFlow, useFlowUi } from "@/store/flowUi";
import { worldBoundsOfNode } from "@/canvas/transform";
import type { Bounds } from "@/canvas/geometry";
import { drawScene, resizeCanvasToDisplaySize } from "@/renderer/canvasRenderer";
import { imageCache } from "@/renderer/imageCache";
import { sceneForScreen, PROTO_PAGE_ID } from "@/flow/protoScene";
import { useProtoAnimation } from "@/ui/protoAnim";
import { animOf, layersAt, progressOf, smartScene, type TransitionAnim } from "@/flow/transitionAnim";
import { screenName } from "@/flow/screens";
import { Badge, Icon, IconButton } from "@/ui/ds";
import { AnyIcon, FlowIcon, FlowIconButton } from "@/ui/ds/flow-parts";
import { DeviceBody, DeviceOverlay } from "@/ui/DeviceChrome";
import { makeSetDocSettingsOp } from "@/tools/ops";
import { DEVICES, deviceById, deviceGeometry, type DeviceId } from "@/flow/devices";
import "@/ui/ds/flow-stage.css";
import {
  applyVariants, back, backTo, canGoBack, closeOverlay, follow, restoreVariant, SET_VARIANT, isGestureTrigger, optionsFrom, startState, trail, varEntries,
  type Option, type ProtoState,
} from "@/flow/prototype";

// THE PLAYABLE PROTOTYPE ("Present"). A full-screen overlay that shows the
// flow's current screen -- the document's real frame, drawn by the usual
// renderer, without editor chrome -- and makes it navigable:
//  - a transition with `elementId` is a CLICKABLE REGION over that element;
//  - the others sit in the bottom bar, as buttons;
//  - a transition whose guard is not satisfied (or cannot be evaluated) stays
//    visible but disabled, with the WHY.
// The logic (state, guards, effects) is in flow/prototype.ts; here is only the view.

const PAD = 48; // margin around the screen, px
// The space at the bottom reserved for the floating group (actions + control bar):
// the screen is centered in the area ABOVE, so the controls do not cover it. Constant
// (does not depend on the screen's exits) so the zoom does not "jump" at every step.
const DOCK_RESERVE = 124;
// How long the hotspot pulse stays visible after entering a screen.
const HINT_MS = 4200;
const MAX_ZOOM = 2;
// The device frame has two levels: the DOCUMENT's (DocSettings.present_device, set with set_document_settings
// or "Make default" below; generic when unset) and the person's own pick, remembered in this browser, which
// overrides it for them. null = no personal pick: follow the document.
const DEVICE_KEY = "od.protoDevice";
function loadPersonalDevice(): DeviceId | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    return raw && DEVICES.some((d) => d.id === raw) ? (raw as DeviceId) : null;
  } catch { return null; }
}

function fitCamera(b: Bounds, w: number, h: number) {
  const zoom = Math.min(MAX_ZOOM, Math.max(0.05, Math.min((w - PAD * 2) / Math.max(1, b.width), (h - PAD * 2) / Math.max(1, b.height))));
  return { zoom, x: w / 2 - (b.x + b.width / 2) * zoom, y: h / 2 - (b.y + b.height / 2) * zoom };
}

function optionLabel(scene: Parameters<typeof screenName>[0], o: Option): string {
  const t = o.transition;
  return t.label.trim() !== "" ? t.label : `Go to ${screenName(scene, t.toId)}`;
}

export function PrototypePlayer({ onClose }: { onClose: () => void }) {
  const scene = useScene((s) => s.scene);
  const pageId = useScene((s) => s.currentPageId);
  const currentFlowId = useFlowUi((s) => s.currentFlowId);
  const flow = resolveFlow(scene, currentFlowId);
  const [state, setState] = useState<ProtoState | null>(() => (scene ? startState(scene, flow, pageId) : null));
  const [showVars, setShowVars] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const held = useRef(new Map<string, { id: string; before: Readonly<Record<string, string>> | undefined }>());
  const dragFrom = useRef<{ id: string | null; x: number; y: number } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // It also redraws when an image arrives.
  const [imgTick, setImgTick] = useState(0);
  // The hotspot pulse: it lights up on every new screen and fades on its own.
  // It also flashes again when the person clicks outside every hotspot (`flashes`), and a toggle
  // keeps the hotspots lit (`pinned`).
  const [hint, setHint] = useState(true);
  const [flashes, setFlashes] = useState(0);
  const [pinned, setPinned] = useState(false);
  const [personalDevice, setPersonalDevice] = useState<DeviceId | null>(loadPersonalDevice);
  const docDevice = deviceById(scene?.settings?.presentDevice).id;
  const device = personalDevice ?? docDevice;
  useEffect(() => {
    setHint(true);
    const t = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(t);
  }, [state?.screenId, flashes]);

  // The screen-to-screen animation in progress (see flow/transitionAnim.ts), or null.
  const [tx, setTx] = useState<{ fromId: string; anim: TransitionAnim; start: number } | null>(null);
  // Follows an option, animated if its transition says so.
  const navigate = (o: Option) => {
    if (!scene || !state || !o.enabled) return;
    const next = follow(scene, state, o.transition);
    if (next === state) return;
    const anim = animOf(o.transition);
    setTx(anim ? { fromId: state.screenId, anim, start: performance.now() } : null);
    setState(next);
  };
  // "auto" transitions (trigger "auto"): followed on their own after `delayMs` on the screen.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    if (!scene || !flow || !state) return;
    const auto = optionsFrom(scene, flow.id, state).find((o) => o.enabled && o.transition.trigger === "auto");
    if (!auto) return;
    const id = setTimeout(() => navigateRef.current(auto), auto.transition.delayMs ?? 0);
    return () => clearTimeout(id);
  }, [scene, flow?.id, state?.screenId, state?.overlay]);

  // Esc closes. In capture and stopping propagation: no other global
  // listener (toolManager, selectTool) must react to an Esc that belongs to the prototype.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // The area's measure: ResizeObserver where available (not in jsdom).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => imageCache.subscribe(() => setImgTick((n) => n + 1)), []);

  // The document as resolved, with the component variants the person switched to while playing.
  const live = useMemo(() => (scene ? applyVariants(resolveScene(scene), state?.variants) : null), [scene, state?.variants]);
  const derived = useMemo(() => (live && state ? sceneForScreen(live, state.screenId) : null), [live, state?.screenId]);
  const screenBox = useMemo(() => {
    const n = scene && state ? scene.nodes.at(state.screenId) : undefined;
    return scene && n ? worldBoundsOfNode(scene, n) : null;
  }, [scene, state?.screenId]);
  const cam = useMemo(() => (screenBox && size.w > 0 ? fitCamera(screenBox, size.w, size.h) : null), [screenBox, size]);
  // The overlay: its screen is drawn over the one under it, centred on it. `shift` moves its world into the base screen's.
  const overlayId = state?.overlay ?? null;
  const overlay = useMemo(() => {
    const n = scene && overlayId ? scene.nodes.at(overlayId) : undefined;
    if (!scene || !n || !screenBox) return null;
    const box = worldBoundsOfNode(scene, n);
    const shift = { x: screenBox.x + screenBox.width / 2 - (box.x + box.width / 2), y: screenBox.y + screenBox.height / 2 - (box.y + box.height / 2) };
    return { id: n.id, box, shift, scene: sceneForScreen(live ?? resolveScene(scene), n.id) };
  }, [scene, live, overlayId, screenBox]);

  // The document's clips (enter/loop when the screen appears, hover and tap on the
  // target): frame loop only while one is running, see ui/protoAnim.ts.
  const anim = useProtoAnimation(scene, state?.screenId ?? null, cam, stage);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !derived || !cam || tx) return;
    resizeCanvasToDisplaySize(c);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    drawScene(ctx, anim.pose(derived), cam, PROTO_PAGE_ID);
    if (overlay?.scene) {
      // Dim what is under the overlay, then draw the overlay itself (on its own canvas: drawScene clears what it draws on).
      const off = document.createElement("canvas");
      off.width = c.width;
      off.height = c.height;
      const octx = off.getContext("2d");
      if (octx) {
        drawScene(octx, overlay.scene, { ...cam, x: cam.x - overlay.shift.x * cam.zoom, y: cam.y - overlay.shift.y * cam.zoom }, PROTO_PAGE_ID);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(off, 0, 0);
        ctx.restore();
      }
    }
  }, [derived, cam, size, imgTick, anim.pose, tx, overlay]);

  // The transition: a frame loop for its duration. "smart" draws ONE interpolated scene; the
  // others draw the two screens on their own canvases and lay them over each other.
  useEffect(() => {
    const c = canvas.current;
    if (!tx || !c || !scene || !state || !derived || !cam || !screenBox) { if (tx) setTx(null); return; }
    resizeCanvasToDisplaySize(c);
    const resolved = live ?? resolveScene(scene);
    const fromScene = sceneForScreen(resolved, tx.fromId);
    // The source screen sits elsewhere in the world: it gets the camera that frames IT.
    const fromRoot = scene.nodes.at(tx.fromId);
    const fromCam = fromRoot ? fitCamera(worldBoundsOfNode(scene, fromRoot), size.w, size.h) : cam;
    const layer = () => {
      const o = document.createElement("canvas");
      o.width = c.width;
      o.height = c.height;
      return o;
    };
    const offFrom = layer();
    const offTo = layer();
    const dpr = c.clientWidth > 0 ? c.width / c.clientWidth : 1;
    const w = screenBox.width * cam.zoom;
    const h = screenBox.height * cam.zoom;
    let raf = 0;
    const step = (now: number) => {
      const ctx = c.getContext("2d");
      if (!ctx) { setTx(null); return; }
      const elapsed = now - tx.start;
      const p = progressOf(tx.anim, elapsed);
      if (tx.anim.kind === "smart") {
        const sm = smartScene(resolved, tx.fromId, state.screenId, p);
        if (sm) drawScene(ctx, sm, cam, PROTO_PAGE_ID);
      } else {
        const a = offFrom.getContext("2d");
        const b = offTo.getContext("2d");
        if (a && b && fromScene) {
          drawScene(a, fromScene, fromCam, PROTO_PAGE_ID);
          drawScene(b, derived, cam, PROTO_PAGE_ID);
          const L = layersAt(tx.anim, p);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, c.width, c.height);
          for (const [img, l] of [[offFrom, L.from], [offTo, L.to]] as const) {
            ctx.globalAlpha = l.alpha;
            ctx.drawImage(img, l.dx * w * dpr, l.dy * h * dpr);
          }
          ctx.globalAlpha = 1;
        }
      }
      if (elapsed >= tx.anim.durationMs) { setTx(null); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx]);

  if (!scene) return null;
  const options = flow && state ? optionsFrom(scene, flow.id, state) : [];
  // The hotspots of an open overlay sit in the overlay's own coordinates: this moves them over the screen it covers.
  const hotShift = overlay?.shift ?? { x: 0, y: 0 };
  // A hotspot exists only if the element really has a box in the screen.
  const hotspots: { o: Option; box: Bounds }[] = [];
  const bar: Option[] = [];
  for (const o of options) {
    if (o.superseded) continue; // the other branch of an if / else on this hotspot applies instead
    const el = o.transition.elementId !== "" ? scene.nodes.at(o.transition.elementId) : undefined;
    if (el && cam) {
      const b = worldBoundsOfNode(scene, el);
      hotspots.push({ o, box: { ...b, x: b.x + hotShift.x, y: b.y + hotShift.y } });
    }
    else bar.push(o);
  }
  const go = navigate;

  // A component state change on hover or press lasts while the pointer is on the hotspot (or the button is down);
  // `held` remembers what the instance showed before, to put it back.
  function press(o: Option) {
    const t = o.transition;
    if (t.animation === SET_VARIANT && state) held.current.set(t.id, { id: t.elementId, before: state.variants?.[t.elementId] });
    go(o);
  }
  function release(o: Option) {
    const t = o.transition;
    const h = held.current.get(t.id);
    if (!h || (t.trigger !== "hover" && t.trigger !== "press")) return;
    held.current.delete(t.id);
    setState((s) => (s ? restoreVariant(s, h.id, h.before) : s));
  }

  // Drag: a press that moves far enough on the hotspot (or, for a drag with no element, anywhere on the screen).
  const DRAG_PX = 24;
  function dragMove(e: { clientX: number; clientY: number; buttons: number }, id: string | null) {
    const d = dragFrom.current;
    if (!d || d.id !== id || e.buttons === 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return;
    dragFrom.current = null;
    const o = options.find((x) => x.enabled && x.transition.trigger === "drag" && (id === null ? x.transition.elementId === "" : x.transition.id === id));
    if (o) go(o);
  }
  // Scroll (or drag) on a transition with no element acts on the whole screen.
  function screenGesture(trigger: "scroll", dy: number) {
    if (dy === 0) return;
    const o = options.find((x) => x.enabled && x.transition.trigger === trigger && x.transition.elementId === "");
    if (o) go(o);
  }


  const flowName = flow?.name ?? "";
  const disabledAll = hotspots.filter((h) => !h.o.enabled);
  // The frame and the canvas clipping, in px of the area: the canvas covers the whole
  // area but is SHOWN only inside the screen, with the device's corners.
  const frame = cam && screenBox
    ? {
        x: screenBox.x * cam.zoom + cam.x,
        y: screenBox.y * cam.zoom + cam.y,
        w: screenBox.width * cam.zoom,
        h: screenBox.height * cam.zoom,
      }
    : null;
  const spec = deviceById(device);
  const geo = frame ? deviceGeometry(spec, { left: frame.x, top: frame.y, width: frame.w, height: frame.h }) : null;
  const radius = geo?.screenRadius ?? 0;
  const lit = hint || pinned;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Prototype"
      className="od-island-dark fixed inset-0 z-50 overflow-hidden bg-[radial-gradient(ellipse_at_50%_38%,var(--surface-2),var(--canvas)_72%)] text-[13px] text-fg"
    >
      {/* The stage: the screen at the center of the area above the dock. */}
      <div ref={stage} className="absolute inset-x-0 top-0" style={{ bottom: DOCK_RESERVE }} {...anim.handlers}>
        {state && derived ? (
          <>
            {frame && (
              <DeviceBody
                spec={spec}
                screen={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
                label={screenName(scene, state.screenId)}
              />
            )}
            <canvas
              ref={canvas}
              aria-label={`Screen ${screenName(scene, state.screenId)}`}
              className="absolute inset-0 block h-full w-full"
              // A click that misses every hotspot flashes them: "where can I click?".
              onClick={(e) => {
                // Outside an open overlay closes it.
                if (overlay && cam && state) {
                  const r = e.currentTarget.getBoundingClientRect();
                  const wx = (e.clientX - r.left - cam.x) / cam.zoom - overlay.shift.x, wy = (e.clientY - r.top - cam.y) / cam.zoom - overlay.shift.y;
                  if (wx < overlay.box.x || wy < overlay.box.y || wx > overlay.box.x + overlay.box.width || wy > overlay.box.y + overlay.box.height) {
                    setState(closeOverlay(state));
                    return;
                  }
                }
                setFlashes((n) => n + 1);
              }}
              onWheel={(e) => screenGesture("scroll", e.deltaY)}
              onPointerDown={(e) => { dragFrom.current = { id: null, x: e.clientX, y: e.clientY }; }}
              onPointerMove={(e) => dragMove(e, null)}
              style={
                frame
                  ? {
                      clipPath: `inset(${frame.y}px ${size.w - frame.x - frame.w}px ${size.h - frame.y - frame.h}px ${frame.x}px round ${radius}px)`,
                    }
                  : undefined
              }
            />
            {frame && <DeviceOverlay spec={spec} screen={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }} />}
            {cam &&
              hotspots.map(({ o, box }) => {
                const x = box.x * cam.zoom + cam.x;
                const y = box.y * cam.zoom + cam.y;
                return (
                  <button
                    key={o.transition.id}
                    type="button"
                    aria-label={optionLabel(scene, o)}
                    aria-disabled={!o.enabled}
                    title={o.enabled ? optionLabel(scene, o) : o.reason}
                    // A hover, drag or scroll hotspot is performed by that gesture; a keyboard activation (detail 0) still works.
                    onClick={(e) => { if (isGestureTrigger(o.transition.trigger) && e.detail !== 0) return; go(o); }}
                    onPointerEnter={() => { if (o.transition.trigger === "hover") press(o); }}
                    onPointerLeave={() => release(o)}
                    onPointerUp={() => release(o)}
                    onPointerDown={(e) => { if (o.transition.trigger === "press") press(o); if (o.transition.trigger === "drag") { e.stopPropagation(); dragFrom.current = { id: o.transition.id, x: e.clientX, y: e.clientY }; } }}
                    onPointerMove={(e) => dragMove(e, o.transition.id)}
                    onWheel={(e) => { if (o.transition.trigger === "scroll" && e.deltaY !== 0) go(o); }}
                    style={{ left: x, top: y, width: box.width * cam.zoom, height: box.height * cam.zoom }}
                    className={
                      "absolute rounded-md border-2 outline-none transition-[background-color,border-color] duration-500 " +
                      "focus-visible:shadow-[var(--ring)] " +
                      (o.enabled
                        ? "cursor-pointer hover:border-flow hover:bg-flow/25 hover:duration-150 " +
                          (lit ? "border-flow/80 bg-flow/10" : "border-transparent bg-transparent")
                        : "cursor-not-allowed border-dashed border-danger/60 bg-danger/10")
                    }
                  >
                    {/* The pulse ring: only while the hint lasts. */}
                    {o.enabled && lit && (
                      <span aria-hidden="true" className="od-pulse pointer-events-none absolute -inset-1 rounded-lg border-2 border-flow" />
                    )}
                  </button>
                );
              })}
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-fg-muted">
            No screen to present: add a top-level frame or set the flow's start.
          </div>
        )}
      </div>

      {/* At the top: where you are (left) and the exit (right). */}
      <div className="pointer-events-none absolute inset-x-4 top-4 flex items-start justify-between">
        <div className="pointer-events-auto flex h-8 items-center gap-2 rounded-full bg-raised pl-2.5 pr-3 shadow-bar">
          <Icon name="play" size={12} className="text-flow" />
          <span className="text-[12px] font-semibold text-fg">Present</span>
          {flowName !== "" && <span className="max-w-[200px] truncate text-[12px] text-fg-muted">{flowName}</span>}
        </div>
        <div className="pointer-events-auto rounded-full bg-raised p-1 shadow-bar">
          <IconButton icon="x" label="Close the prototype" shortcut="Esc" onPress={onClose} className="rounded-full" />
        </div>
      </div>

      {/* At the bottom: the screen's exits and the control bar. */}
      <div className="pointer-events-none absolute inset-x-4 bottom-4 flex flex-col items-center gap-3">
        <div
          role="group"
          aria-label="Screen actions"
          className="pointer-events-auto flex max-w-[min(720px,100%)] flex-wrap items-start justify-center gap-2"
        >
          {state && bar.length === 0 && hotspots.length === 0 && (
            <span className="od-rise rounded-full bg-raised px-3 py-1.5 text-[12px] text-fg-muted shadow-bar">
              End of the path: no exit from this screen.
            </span>
          )}
          {bar.map((o) => (
            <div key={`${state?.screenId}-${o.transition.id}`} className="od-rise flex flex-col items-center gap-1">
              <RacButton
                isDisabled={!o.enabled}
                onPress={() => go(o)}
                className={
                  "inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium outline-none transition-colors " +
                  "data-[focus-visible]:shadow-[var(--ring)] " +
                  "bg-flow text-canvas shadow-bar hover:brightness-110 " +
                  "data-[disabled]:cursor-not-allowed data-[disabled]:bg-surface-3 data-[disabled]:text-fg-subtle data-[disabled]:shadow-none data-[disabled]:hover:brightness-100"
                }
              >
                {optionLabel(scene, o)}
                <AnyIcon name={o.enabled ? "arrowRight" : "lock"} size={14} />
              </RacButton>
              {!o.enabled && o.reason && (
                <span className="max-w-64 rounded-md bg-warn-soft px-2 py-0.5 text-center text-[11px] font-medium text-warn">{o.reason}</span>
              )}
            </div>
          ))}
          {disabledAll.length > 0 && (
            <span className="od-rise inline-flex items-center gap-1.5 rounded-md bg-warn-soft px-2 py-1 text-[11px] font-medium text-warn">
              <Icon name="lock" size={12} className="shrink-0" />
              <span>{disabledAll.map((h) => `${optionLabel(scene, h.o)}: ${h.o.reason}`).join(" · ")}</span>
            </span>
          )}
        </div>

        <div className="pointer-events-auto relative flex h-11 max-w-full items-center gap-1 rounded-2xl bg-raised px-1.5 shadow-bar">
          <FlowIconButton
            icon="arrowLeft"
            label="Back"
            isDisabled={!state || !canGoBack(state)}
            onPress={() => { setTx(null); if (state) setState(back(state)); }}
          />
          <FlowIconButton icon="restart" label="Restart" onPress={() => { setTx(null); setState(startState(scene, flow, pageId)); }} />
          {state && (
            <nav
              aria-label="Path"
              className="mx-1 flex min-w-0 max-w-[46vw] items-center gap-0.5 overflow-x-auto border-x border-line px-2 text-[12px] text-fg-subtle"
            >
              {trail(state).map((id, i, all) => {
                const last = i === all.length - 1;
                return (
                  <span key={i} className="flex shrink-0 items-center gap-0.5">
                    {i > 0 && <span aria-hidden="true">›</span>}
                    {last ? (
                      <span aria-current="step" className="rounded-full bg-flow-soft px-2 py-0.5 font-semibold text-flow">{screenName(scene, id)}</span>
                    ) : (
                      <RacButton
                        onPress={() => { setTx(null); setState(backTo(state, i)); }}
                        className="rounded-full px-2 py-0.5 text-fg-muted outline-none hover:bg-surface-3 hover:text-fg data-[focus-visible]:shadow-[var(--ring)]"
                      >
                        {screenName(scene, id)}
                      </RacButton>
                    )}
                  </span>
                );
              })}
            </nav>
          )}
          <FlowIconButton
            icon={pinned ? "eye" : "eyeOff"}
            label="Show hotspots"
            selected={pinned}
            onPress={() => { setPinned((v) => !v); setFlashes((n) => n + 1); }}
          />
          <label className="flex h-7 items-center gap-1 rounded-md px-1 text-fg-muted hover:bg-surface-3">
            <FlowIcon name="device" size={14} />
            <select
              aria-label="Device frame"
              value={device}
              onChange={(e) => {
                const id = deviceById(e.target.value).id;
                setPersonalDevice(id);
                try { localStorage.setItem(DEVICE_KEY, id); } catch { /* no storage */ }
              }}
              className="h-6 cursor-pointer rounded bg-transparent text-[12px] text-fg outline-none focus-visible:shadow-[var(--ring)]"
            >
              {DEVICES.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
            {device !== docDevice && (
              <RacButton
                aria-label="Make this the document's device frame"
                onPress={() => {
                  const store = useScene.getState();
                  store.beginGesture();
                  store.endGesture([makeSetDocSettingsOp({ ...(store.scene?.settings ?? {}), presentDevice: device === "generic" ? undefined : device })]);
                  // The document now says it, so the personal pick is no longer an override.
                  setPersonalDevice(null);
                  try { localStorage.removeItem(DEVICE_KEY); } catch { /* no storage */ }
                }}
                className="h-6 rounded px-1.5 text-[11px] text-fg-muted outline-none hover:bg-surface-3 hover:text-fg data-[focus-visible]:shadow-[var(--ring)]"
              >
                Make default
              </RacButton>
            )}
            {personalDevice !== null && personalDevice !== docDevice && (
              <RacButton
                aria-label="Use the document's device frame"
                onPress={() => {
                  setPersonalDevice(null);
                  try { localStorage.removeItem(DEVICE_KEY); } catch { /* no storage */ }
                }}
                className="h-6 rounded px-1.5 text-[11px] text-fg-muted outline-none hover:bg-surface-3 hover:text-fg data-[focus-visible]:shadow-[var(--ring)]"
              >
                Reset
              </RacButton>
            )}
          </label>
          <FlowIconButton icon="braces" label="Variables" selected={showVars} onPress={() => setShowVars((v) => !v)}>
            {state && Object.keys(state.vars).length > 0 && (
              <Badge tone="flow" className="pointer-events-none absolute -right-1 -top-1 h-4 min-w-4 justify-center px-1 text-[10px]">
                {Object.keys(state.vars).length}
              </Badge>
            )}
          </FlowIconButton>

          {showVars && state && (
            <aside
              aria-label="Prototype variables"
              className="od-rise absolute bottom-0 left-full ml-2 w-60 rounded-xl bg-raised p-3 text-[12px] shadow-pop"
            >
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Variables</h3>
              {varEntries(state.vars).length === 0 ? (
                <div className="text-fg-subtle">No variables set.</div>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {varEntries(state.vars).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-fg-muted">{k}</dt>
                      <dd className="truncate rounded bg-surface-2 px-1.5 font-mono text-fg">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
