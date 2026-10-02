import { useEffect, useRef, useState } from "react";
import { ConnectError } from "@connectrpc/connect";
import { Button, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { docClient } from "../rpc/client";
import { SyncClient } from "../rpc/syncClient";
import { PresenceClient } from "../rpc/presence";
import { usePresence, loadNickname } from "../store/presence";
import { drawLayoutDrop, drawPeers } from "../renderer/peersRenderer";
import { PresenceBar } from "./PresenceBar";
import { useScene } from "../store/store";
import { resizeCanvasToDisplaySize } from "../renderer/canvasRenderer";
import { attachImageRecovery, imageCache } from "../renderer/imageCache";
import { SETTLE_MS } from "../renderer/layerCache";
import { SceneSurface } from "../renderer/sceneSurface";
import { useRenderer } from "../store/rendererChoice";
import { RendererToggle } from "./RendererToggle";
import { drawOverlay } from "../renderer/overlayRenderer";
import { screenToWorld } from "../canvas/camera";
import { attachTools, eventToCanvasPoint } from "../tools/toolManager";
import { attachClipboardShortcuts } from "../tools/clipboard";
import { attachImageDrop } from "../tools/imageDrop";
import { ExportButton } from "./ExportButton";
import { TextEditorOverlay } from "./TextEditorOverlay";
import { LayersPanel } from "./LayersPanel";
import { ComponentsPanel } from "./ComponentsPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { PageBar } from "./PageBar";
import type { Tool, ToolContext, ToolId } from "../tools/types";
import { selectTool } from "../tools/selectTool";
import { rectTool } from "../tools/rectTool";
import { frameTool } from "../tools/frameTool";
import { ellipseTool } from "../tools/ellipseTool";
import { textTool } from "../tools/textTool";
import { penTool } from "../tools/penTool";
import { handTool } from "../tools/handTool";

// Registro dei tool disponibili: la toolbar sceglie una chiave, attachTools
// instrada gli eventi al tool corrispondente.
//
// Esportati (con TOOL_LABELS) perché sono l'UNICO punto in cui un ToolId
// diventa raggiungibile davvero: una voce in TOOL_LABELS senza la sua entry
// qui ricadrebbe in silenzio su selectTool (vedi il `?? selectTool` più
// sotto), cioè un pulsante che non fa quello che dice. È un invariante, e
// come tale ha un test (App.test.tsx) invece di una convenzione a memoria.
export const TOOLS: Partial<Record<ToolId, Tool>> = {
  select: selectTool,
  frame: frameTool,
  rect: rectTool,
  ellipse: ellipseTool,
  text: textTool,
  pen: penTool,
  hand: handTool,
};

export const TOOL_LABELS: { id: ToolId; label: string }[] = [
  { id: "select", label: "Seleziona" },
  { id: "frame", label: "Frame" },
  { id: "rect", label: "Rettangolo" },
  { id: "ellipse", label: "Ellisse" },
  { id: "text", label: "Testo" },
  { id: "pen", label: "Penna" },
  { id: "hand", label: "Mano" },
];

const CLIENT_ID = crypto.randomUUID();
const DOC_KEY = "opendesigner.docId";

// Il documento si sceglie dal link: `#doc=<id>`. È ciò che permette a un altro
// computer sulla stessa rete di entrare nello STESSO documento invece di
// crearne uno proprio (il localStorage è per-browser, quindi da solo non basta).
// Un id non ben formato si ignora: HubFor lo rifiuterebbe comunque.
const DOC_HASH_RE = /^#doc=([0-9a-fA-F-]{36})$/;
export function docIdFromHash(hash: string): string | null {
  const m = DOC_HASH_RE.exec(hash);
  return m ? m[1].toLowerCase() : null;
}

// Un campo di testo (input/textarea/contentEditable): Ctrl/Cmd+Z lì dentro è
// affare del campo stesso (annullare la digitazione), non della scena --
// servirà in M1b quando arriverà il primo campo editabile (testo, proprietà).
// Duck-typing sul target come in tools/toolManager.ts::swallowsSpace: stesso
// motivo, i test possono passare eventi senza un vero HTMLElement.
function isTextField(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  // Il canvas WebGL del renderer su GPU, SOTTO quello 2D (che resta in cima perché
  // riceve gli eventi): vedi renderer/sceneSurface.ts.
  const glRef = useRef<HTMLCanvasElement>(null);
  // Il manager legge il tool attivo da un ref: attachTools viene collegato una
  // volta sola al mount, quindi non deve dipendere dall'identità della closure.
  const toolRef = useRef<ToolId>("select");
  // Il nickname vive in un ref oltre che nello stato: il bootstrap parte una
  // volta sola e deve leggere quello CORRENTE quando apre la presenza.
  const [nickname, setNickname] = useState(loadNickname);
  const nicknameRef = useRef(nickname);
  const presenceRef = useRef<PresenceClient | null>(null);
  const [toolId, setToolId] = useState<ToolId>("select");
  // Un op rifiutato dal server viene annullato in locale (la modifica
  // ottimistica sparisce dal canvas, vedi store/store.ts::rejectPending). Un
  // rollback SILENZIOSO è quasi peggio di nessun rollback: qui è l'unico posto
  // in cui l'utente può capire perché il rettangolo appena disegnato è sparito.
  // Sottoscrizioni con selettore: il resto della UI non si ridisegna a ogni op.
  const lastError = useScene((s) => s.lastError);
  const clearError = useScene((s) => s.clearError);
  // Il contrario di lastError: una modifica data per persa che si è invece
  // rivelata salvata (store.ts: revoca del rollback). Va detto, e va detto in un
  // banner DIVERSO -- annunciarlo in quello rosso, sotto la scritta "modifica
  // non salvata e annullata", sarebbe la seconda bugia dopo la prima.
  const notice = useScene((s) => s.notice);
  const clearNotice = useScene((s) => s.clearNotice);
  // Stato del collegamento (store.ts::ConnectionStatus) e il suo perché. Non è
  // dismissibile come lastError: la condizione non passa perché l'utente chiude
  // un avviso, e finché dura le modifiche restano ottimistiche -- deve poterlo
  // sapere PRIMA di continuare a lavorare, non al reload successivo.
  const connection = useScene((s) => s.connection);
  const syncError = useScene((s) => s.syncError);
  // Il nodo che si sta scrivendo (lo accendono textTool alla creazione e il
  // doppio click di selectTool). È l'UNICO punto in cui il campo di editing
  // diventa raggiungibile dall'utente: senza questa riga TextEditorOverlay è
  // codice compilato che nessuno monta, e il testo si può creare ma non
  // scrivere. Selettore, quindi l'app si ridisegna solo quando si entra o si
  // esce dall'editing.
  const editingNodeId = useScene((s) => s.editingNodeId);

  // bootstrap: documento + SyncClient + tool
  useEffect(() => {
    let cleanup = () => {};
    let cancelled = false;
    // Il client va tenuto QUI e non dentro l'async: la cleanup deve poterlo
    // fermare anche quando lo smontaggio arriva mentre il bootstrap è ancora a
    // metà. Senza stop(), StrictMode (main.tsx) lascia una subscription
    // orfana per tutta la sessione: due stream sul server e ogni record remoto
    // applicato due volte nello stesso store.
    let sync: SyncClient | null = null;

    (async () => {
      try {
        // Il link vince sul localStorage: chi riceve un invito vuole QUEL
        // documento, non l'ultimo che aveva aperto.
        let docId = docIdFromHash(location.hash) ?? localStorage.getItem(DOC_KEY);
        if (!docId) {
          const info = await docClient.createDocument({ name: "Untitled" });
          docId = info.id;
        }
        localStorage.setItem(DOC_KEY, docId);
        // Il link nella barra degli indirizzi è sempre quello da condividere.
        history.replaceState(null, "", `#doc=${docId}`);
        sync = new SyncClient(docId, CLIENT_ID);
        // Smontati mentre creavamo il client: fermarlo prima ancora di
        // aprire il documento (start() su un client fermato è un no-op).
        if (cancelled) {
          sync.stop();
          return;
        }
        await sync.start();
        // L'effetto può essere già stato smontato (StrictMode in dev, o unmount
        // rapido): in quel caso non agganciare listener che nessuno rimuoverà.
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        // Il contesto è l'unico ponte fra i tool e il resto dell'app: store,
        // camera e la sola conversione schermo -> mondo (via canvas/camera.ts).
        const ctx: ToolContext = {
          sync,
          canvas,
          getScene: () => useScene.getState().scene,
          getCamera: () => useScene.getState().camera,
          setCamera: (c) => useScene.getState().setCamera(c),
          toWorld: (e) => {
            const p = eventToCanvasPoint(canvas, e);
            return screenToWorld(useScene.getState().camera, p.x, p.y);
          },
        };
        // La presenza: chi altro c'è, e dove ho io il cursore e la selezione.
        // Parte dopo sync.start() perché non deve mai ritardare il documento.
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
          // La pagina EFFETTIVA: con currentPageId null la vista mostra la prima.
          presence.setLocal({ selection: st.selection, pageId: st.currentPageId ?? st.scene?.pages[0]?.id ?? "" });
        };
        sendView();
        const unsubView = useScene.subscribe((st, prev) => {
          if (st.selection !== prev.selection || st.currentPageId !== prev.currentPageId) sendView();
        });
        const detachTools = attachTools(ctx, () => TOOLS[toolRef.current] ?? selectTool);
        // Trascinare un'immagine sul canvas (traccia 3, task 3). Sta accanto ai
        // tool e non dentro il registro perché non è un tool: non ha un pulsante
        // in toolbar e non ha modo -- il rilascio funziona qualunque tool sia
        // attivo. Il punto passa dalla STESSA conversione schermo -> mondo dei
        // tool (ctx.toWorld); un DragEvent ha clientX/clientY come un
        // PointerEvent, che è tutto ciò che quella conversione legge.
        const detachDrop = attachImageDrop(canvas, (e) => ctx.toWorld(e as PointerEvent));
        cleanup = () => {
          detachTools();
          detachDrop();
          canvas.removeEventListener("pointermove", onMove);
          canvas.removeEventListener("pointerleave", onLeave);
          unsubView();
          presence.stop();
          presenceRef.current = null;
        };
      } catch (err) {
        console.error("bootstrap failed", err);
        // Il bootstrap fallito è uno stato di collegamento come gli altri: non
        // si riprende da solo (nessuno stream da riabbonare), quindi "error".
        if (!cancelled) {
          useScene.getState().setConnection("error", ConnectError.from(err).message);
        }
      }
    })();

    return () => {
      cancelled = true;
      sync?.stop();
      cleanup();
    };
  }, []);

  // IL CICLO DI DISEGNO, A INVALIDAZIONE. Scena e overlay sono due canvas
  // separati (scena sotto, overlay sopra, vedi il contenitore "relative" più
  // sotto) così l'overlay -- bbox di selezione, maniglie, marquee -- può
  // ridisegnarsi in spazio schermo senza mai toccare i pixel della scena.
  //
  // Prima girava a 60 fps SEMPRE, anche con l'editor fermo: ridisegnare la scena
  // intera sessanta volte al secondo per niente (batteria, ventola, e un
  // documento grande che non lascia spazio a nient'altro). Ora si disegna UN
  // frame ogni volta che qualcosa che si vede è cambiato: la scena o la
  // camera/selezione/anteprime (lo store), gli altri utenti (la presenza), un'
  // immagine arrivata, un font caricato, il canvas ridimensionato. Più
  // invalidazioni nello stesso frame se ne fanno una sola.
  //
  // La scena passa da SceneLayerCache: un documento pesante, mentre solo la
  // camera si muove, riusa l'ultima immagine invece di ridisegnare, e a
  // movimento finito (SETTLE_MS) rifà il frame esatto.
  useEffect(() => {
    // Il disegno vero lo fa SceneSurface: sceglie fra Canvas 2D (CPU) e CanvasKit
    // (GPU) e ripiega sulla CPU se la GPU non va. Senza il canvas WebGL (i test
    // sotto jsdom) disegna sempre in CPU.
    const surface = canvasRef.current && glRef.current
      ? new SceneSurface(canvasRef.current, glRef.current, imageCache, () => invalidate())
      : null;
    let raf = 0;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let force = false;

    const frame = () => {
      raf = 0;
      const canvas = canvasRef.current;
      const overlay = overlayRef.current;
      const scene = useScene.getState().scene;
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
        // snapGuides: le guide di allineamento del gesto in corso (T2).
        // penPreview: il path che il pen tool sta disegnando. Nessuno dei due è
        // documento (il nodo vettoriale non esiste finché il path non è finito),
        // quindi passano dallo store all'overlay come il marquee -- ed è l'UNICO
        // modo in cui chi disegna vede quello che sta facendo.
        const { camera, selection, marquee, snapGuides, penPreview } = useScene.getState();
        if (octx) {
          drawOverlay(octx, scene, camera, selection, marquee, snapGuides, penPreview);
          const peers = usePresence.getState().peers;
          if (Object.keys(peers).length > 0) {
            drawPeers(octx, scene, camera, peers, useScene.getState().currentPageId ?? null);
          }
          const layoutDrop = useScene.getState().layoutDrop;
          if (layoutDrop) drawLayoutDrop(octx, camera, layoutDrop);
        }
      }
    };

    const invalidate = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const unsubs = [
      useScene.subscribe(invalidate),
      usePresence.subscribe(invalidate),
      imageCache.subscribe(invalidate),
      // Cambiare renderer (o la sua scelta, che il guasto della GPU riporta in
      // CPU) va ridisegnato subito.
      useRenderer.subscribe((st, prev) => {
        if (st.choice !== prev.choice) invalidate();
      }),
    ];
    // Ridimensionare il canvas lo svuota: va ridisegnato. ResizeObserver non c'è
    // in ogni ambiente (jsdom): lì basta il frame iniziale.
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(invalidate) : null;
    if (canvasRef.current) observer?.observe(canvasRef.current);
    // Un font che arriva cambia le misure del testo.
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

  // Scorciatoie undo/redo: sulla window (non sul canvas) perché il canvas non
  // è focusabile -- stesso motivo per cui toolManager.ts ascolta Escape/Delete
  // lì. Ctrl (Windows/Linux) o Cmd (Mac, e.metaKey) + Z = undo, + Shift+Z (o
  // Ctrl+Y) = redo. Ignorate dentro un campo di testo (isTextField) e SEMPRE
  // con preventDefault quando gestite, altrimenti Ctrl+Z fa anche l'undo
  // nativo del browser (es. su un contentEditable) in parallelo al nostro.
  //
  // Guardia extra su useScene.getState().gesture (bug trovato in review): un
  // gesto (drag di selectTool -- sposta/resize) resta aperto finché il
  // pointerup non arriva, indipendentemente dalla tastiera. Se Ctrl/Cmd+Z
  // arriva a metà drag, store.ts::undo()/redo() sono già la guardia che
  // conta (bloccano da soli, per qualunque chiamante): questo controllo qui è
  // difesa in profondità, non l'unica barriera. preventDefault resta comunque
  // per evitare l'undo nativo del browser.
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
      if (useScene.getState().gesture) return; // gesto in corso: rimandato, vedi store.ts
      if (isRedo) useScene.getState().redo();
      else useScene.getState().undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Copia / incolla / duplica (Ctrl/Cmd+C, +V, +D). Sulla finestra come le
  // scorciatoie qui sopra e per lo stesso motivo (il canvas non è focusabile);
  // la logica sta tutta in tools/clipboard.ts, qui c'è solo il montaggio --
  // che però è l'unico punto in cui la funzione diventa raggiungibile.
  useEffect(() => attachClipboardShortcuts(), []);

  // Le immagini che non si erano caricate si riprovano quando la rete torna o
  // quando la scheda torna in primo piano (traccia 3, task 3). Senza, un
  // disservizio di un istante lascerebbe quel nodo come segnaposto per tutta la
  // vita della pagina, con il file ancora lì sul disco.
  useEffect(() => attachImageRecovery(), []);

  // La pillola diceva "connesso" anche a stream morto: il bootstrap era andato
  // a buon fine e nessuno rivedeva più quello stato. Adesso è SyncClient a
  // tenere aggiornato `connection` per tutta la vita dello stream, riconnessioni
  // comprese, e la pillola non fa che leggerlo.
  const statusLabel =
    connection === "connected"
      ? "connesso"
      : connection === "reconnecting"
        ? "riconnessione…"
        : connection === "error"
          ? "sconnesso"
          : "connessione…";

  return (
    <div className="flex h-screen flex-col">
      <div
        role="toolbar"
        aria-label="Strumenti"
        className="flex items-center gap-2 border-b border-neutral-200 p-2"
      >
        <ToggleButtonGroup
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[toolId]}
          className="flex gap-1"
          onSelectionChange={(keys) => {
            const next = (keys.values().next().value as ToolId | undefined) ?? "select";
            toolRef.current = next;
            setToolId(next);
          }}
        >
          {TOOL_LABELS.map((t) => (
            <ToggleButton
              key={t.id}
              id={t.id}
              className="rounded px-3 py-1 text-sm data-[selected]:bg-neutral-800 data-[selected]:text-white"
            >
              {t.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Button
          className="rounded px-3 py-1 text-sm hover:bg-neutral-100"
          onPress={() => {
            localStorage.removeItem(DOC_KEY);
            // Senza svuotare l'hash il reload riaprirebbe lo stesso documento.
            history.replaceState(null, "", location.pathname);
            location.reload();
          }}
        >
          Nuovo documento
        </Button>
        {/* Export PNG/SVG (traccia 3, task 2). Tutta la logica sta in
            export/ e in ui/ExportButton.tsx: qui c'è solo il montaggio, che
            però è l'unico punto in cui la funzione diventa raggiungibile. */}
        <ExportButton />
        <div className="ml-auto">
          <PresenceBar
            nickname={nickname}
            onNickname={(n) => {
              nicknameRef.current = n;
              setNickname(n);
              presenceRef.current?.setNickname(n);
            }}
          />
        </div>
        <RendererToggle />
        <span aria-live="polite" className="text-sm text-neutral-500">
          {statusLabel}
        </span>
      </div>
      {/* Due avvisi diversi perché le due situazioni chiedono cose diverse: in
          riconnessione l'utente può aspettare (le modifiche restano in coda e
          il backlog le confermerà), a tentativi esauriti no. */}
      {connection === "reconnecting" && (
        <div
          role="alert"
          className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Connessione al server persa ({syncError}). Riconnessione in corso: le modifiche fatte
          nel frattempo restano in attesa e verranno confermate al rientro.
        </div>
      )}
      {connection === "error" && (
        <div
          role="alert"
          className="border-b border-amber-300 bg-amber-100 px-3 py-2 text-sm text-amber-900"
        >
          Connessione al server persa ({syncError}). I tentativi di riconnessione sono finiti: le
          modifiche non vengono più confermate, ricarica la pagina per riprendere.
        </div>
      )}
      {lastError && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          <span className="flex-1">Modifica non salvata e annullata: {lastError}</span>
          <Button
            aria-label="Chiudi l'avviso"
            className="rounded px-2 py-0.5 text-sm hover:bg-red-100"
            onPress={clearError}
          >
            Chiudi
          </Button>
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900"
        >
          <span className="flex-1">{notice}</span>
          <Button
            aria-label="Chiudi l'avviso"
            className="rounded px-2 py-0.5 text-sm hover:bg-sky-100"
            onPress={clearNotice}
          >
            Chiudi
          </Button>
        </div>
      )}
      {/* Selettore di pagina: una riga AGGIUNTIVA sopra le tre colonne, così il
          layout a tre colonne resta intatto. Il canvas mostra la sola pagina
          corrente (currentPageId, stato di vista nello store). */}
      <PageBar />
      {/* LE TRE COLONNE: livelli a sinistra, canvas al centro, proprietà a
          destra. `min-h-0` sulla riga e `min-w-0` sulla colonna centrale non
          sono decorazioni: senza, un figlio flex non scende MAI sotto la
          propria dimensione naturale (min-height/min-width valgono `auto`), e
          basta un elenco di livelli lungo perché la riga sfondi l'altezza
          della finestra spingendo il canvas fuori schermo. */}
      <div className="flex min-h-0 flex-1">
        {/* I pannelli sono FRATELLI del canvas, non gli stanno sopra: non c'è
            nessun evento da rubargli, e la larghezza che occupano la toglie
            il layout al canvas invece di coprirla. Il canvas si ridimensiona
            di conseguenza da solo -- resizeCanvasToDisplaySize legge
            clientWidth/clientHeight ad ogni frame -- e eventToCanvasPoint
            parte da getBoundingClientRect, quindi le coordinate del puntatore
            restano giuste anche con una colonna a sinistra. */}
        {/* Colonna sinistra: i livelli in alto (occupano lo spazio, min-h-0 così
            un elenco lungo scrolla invece di sfondare) e i componenti sotto,
            AGGIUNTIVI -- il pannello componenti (M4) è montato qui senza toccare
            il resto del layout a tre colonne. */}
        <aside
          aria-label="Livelli e componenti"
          className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-neutral-200 bg-white"
        >
          <div className="min-h-0 flex-1 overflow-hidden">
            <LayersPanel />
          </div>
          <ComponentsPanel />
        </aside>
        <div className="relative min-w-0 flex-1">
          {/* Il cursore viene dal tool attivo; durante un pan temporaneo (spazio
              o tasto centrale) è il tool manager a sovrascriverlo sul DOM. */}
          {/* Il canvas WebGL della GPU: sotto, senza eventi, nascosto finché la
              GPU non è scelta e pronta. */}
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
          {/* overlay: bbox di selezione + maniglie + marquee, in spazio schermo.
              pointer-events-none: tutti i listener restano sul canvas "scene",
              l'overlay è puramente visivo e non deve rubare eventi. */}
          <canvas id="overlay" ref={overlayRef} className="pointer-events-none absolute inset-0 block h-full w-full" />
          {/* Il campo di editing del testo: DENTRO questo contenitore perché si
              posiziona in `absolute` sulle coordinate schermo del nodo, e sopra
              i due canvas perché li deve coprire. `key`: una sessione per nodo,
              così passare da un testo a un altro rimonta il campo invece di
              riusarlo. */}
          {editingNodeId && <TextEditorOverlay key={editingNodeId} nodeId={editingNodeId} />}
        </div>
        <aside
          aria-label="Proprietà"
          className="w-64 shrink-0 overflow-hidden border-l border-neutral-200 bg-white"
        >
          <PropertiesPanel />
        </aside>
      </div>
    </div>
  );
}
