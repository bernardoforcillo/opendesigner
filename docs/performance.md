# Prestazioni del rendering

Il renderer disegna con Canvas 2D. Questo documento dice cosa fa per restare
veloce su documenti grandi, come misurarlo e dove sono i limiti.

## Cosa fa

1. **Disegno a invalidazione** (`ui/App.tsx`). Un frame solo quando cambia
   qualcosa che si vede (scena, camera, selezione, anteprime, presenza, immagini,
   font, dimensione del canvas). Da fermo l'editor non ridisegna niente: prima
   disegnava 60 volte al secondo sempre.
2. **Indice di scena** (`renderer/sceneIndex.ts`). Per ogni scena: i figli già
   ordinati e, per ogni nodo, il rettangolo MONDO di tutto ciò che disegna col suo
   sottoalbero (tratto, ombra, sfocatura, testo che sporge). Si aggiorna in modo
   **incrementale** da una scena all'altra, confrontando gli oggetti per
   identità; un test lo confronta con la ricostruzione completa su sequenze
   casuali di modifiche.
3. **Scarto di ciò che non si vede.** `drawScene`, `hitTest` e `nodesIntersecting`
   saltano interi sottoalberi fuori dalla vista o più piccoli di 0,3 px.
4. **Livelli di dettaglio.** Sotto 4 px un nodo diventa un rettangolo piatto del
   suo colore; un frame ritagliante sotto 12 px non ritaglia.
5. **Riuso dell'ultimo frame** (`renderer/layerCache.ts`). Se un frame è pesante
   (> 20 ms) e cambia solo la camera, si ristampa l'ultima immagine spostata e
   scalata, e a movimento finito (120 ms) si rifà il frame esatto.

## Misure

Chromium headless **senza GPU** (rasterizzazione in CPU, quindi i valori assoluti
sono pessimistici; i confronti valgono). Documento sintetico: frame da 20 figli
(rettangoli, ellissi, testi), 1200x800.

| nodi   | frame, inquadrato (prima → ora) | frame, una schermata (prima → ora) | hit-test (prima → ora) |
|--------|--------------------------------|-----------------------------------|------------------------|
| 1.000  | 7,6 → 8 ms                      | 6,4 → 0,8 ms                      | 0,3 → ~0 ms           |
| 5.000  | 34 → 21 ms                      | 40 → 1,3 ms                       | 1,4 → ~0 ms           |
| 20.000 | 177 → 108 ms                    | 139 → 1,5 ms                      | 7,1 → ~0 ms           |

Costo di UNA modifica (nuova scena, indice e frame zoomato): 150 ms → 27 ms a
20.000 nodi, 6 ms a 5.000. Durante pan/zoom di un documento pesante, un frame
costa ~0 ms (riuso).

## Come rimisurare

```bash
pnpm --dir web vite --port 5199 &
# poi, con Playwright, aprire http://localhost:5199/bench.html e chiamare
# window.runBench([1000, 5000, 20000]) o window.runPan(20000)
```

`web/src/bench/` ha il generatore del documento sintetico.

## Limiti noti

- A **inquadratura piena di decine di migliaia di nodi** il costo è del
  rasterizzatore (`fill`, `roundRect`): in CPU resta ~100 ms, ed è la ragione per
  cui il riuso dell'immagine copre il movimento. Un renderer su GPU (WebGL/WebGPU,
  o Skia/CanvasKit in WASM) è il passo successivo; richiede di portare il testo
  (caricamento dei font) e tutti gli effetti.
- `applyOp` copia la mappa dei nodi a ogni op (12 ms a 20.000 nodi), e il
  confronto per l'indice è lineare nel numero di nodi. Servono strutture dati
  persistenti per andare oltre.
- I documenti con componenti ricostruiscono l'indice intero quando cambia un
  nodo dentro un master.
