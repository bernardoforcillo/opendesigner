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

## Renderer GPU (CanvasKit)

Oltre a Canvas 2D c'è un secondo renderer della scena: **CanvasKit** (Skia in
WebAssembly) su WebGL, in `renderer/ck/`. Si sceglie dal pulsante CPU/GPU nella
barra (o con `?renderer=gpu`); la scelta si ricorda. **Il predefinito resta la
CPU**, per due ragioni:

- **Non ho misurato un vantaggio.** L'ambiente di sviluppo non ha una GPU: WebGL
  gira in software (SwiftShader), e lì CanvasKit è PIÙ LENTO di Canvas 2D (20.000
  nodi inquadrati: ~104 ms contro ~76 ms; zoomato: pari). Su una GPU vera è
  plausibile che vada meglio, ma Canvas 2D in Chrome è accelerato dalla GPU
  anch'esso, quindi non è scontato. Il pulsante mostra il tempo dell'ultimo
  frame, così il confronto si fa sulla propria macchina.
- **Il testo è diverso.** Il WASM non ha font di sistema: il testo si disegna con
  Inter (inclusa in `public/fonts`, licenza OFL, quattro pesi), che è già il
  carattere predefinito del modello. Un testo con un'altra famiglia ricade su
  Inter, e CanvasKit non fa la crenatura (differenze di sub-pixel).

Cosa c'è: stesse regole di Canvas 2D per istanze e override, frame ritaglianti e
trasparenti, gradienti, tratti centro/dentro/fuori, ombra e sfocatura (qui per
l'intero nodo), vettoriale, immagini e segnaposto, indice di scena, scarto e
livelli di dettaglio. CanvasKit si scarica solo alla prima scelta della GPU (~7
MB, in file separati dal bundle principale). Se non si carica, WebGL manca o il
contesto si perde, l'app torna alla CPU e lo dice nel pulsante.

**Parità.** `pnpm parity` disegna una galleria con entrambi i renderer a quattro
zoom e fallisce se più dell'1,5% dei pixel differisce di oltre 32/255. Oggi:
0,87% a zoom 1 (tutto testo), 0,08% a 2, 0,15% a 0,35 e 0,01% a 0,08.

## Modifica di documenti grandi (20.000 nodi)

Misurato con `go run ./scripts/gen-large-doc -workspace DIR -nodes 20000` e un
profilo CDP durante un trascinamento:

- apertura fino a "connesso": 46 s -> ~1.7 s (figli indicizzati una volta, Livelli virtualizzato e con rami richiusi sopra 2000 nodi);
- trascinamento: p90 268 ms -> ~44 ms, mediana ~8 ms;
- `applyOp` registra la *provenienza* della scena (`store/sceneDelta.ts`): l'indice di scena aggiorna solo i nodi toccati senza confrontare tutta la mappa (`updateIndex` 18% -> 4%);
- snap con `SnapIndex` (linee ordinate, ricerca binaria) invece di una scansione lineare;
- `relayout` non copia la mappa dei nodi se nessun frame ha auto layout.

Lato server `Hub.Submit` clonava a fondo l'intero documento a ogni op (85% del
costo). Ora è copy-on-write (`core.ApplyShared`: la mappa dei nodi si copia per
puntatori, si clonano solo i nodi scritti): 5.000 nodi 5.5 -> 0.65 ms, 20.000
nodi >22 -> 2.2 ms per op (`go test ./internal/server -bench SubmitLargeDoc`).

Lato client la mappa dei nodi (`SceneState.nodes`) non è più un oggetto copiato
a ogni op (~9 ms a 20.000 nodi) ma una mappa PERSISTENTE a 256 secchi
(`store/nodeMap.ts`): una modifica copia 256 puntatori e i soli secchi toccati,
il confronto fra due scene salta i secchi condivisi, e anche gli extent
dell'indice di scena la usano. Nel profilo di un trascinamento a 20.000 nodi
`applyOp` e `updateIndex` non compaiono più fra i primi costi (p90 ~33 ms,
nessun long task regolare). Il costo che resta è React (pannello proprietà).

## Limiti noti

- A **inquadratura piena di decine di migliaia di nodi** il costo è del
  rasterizzatore (`fill`, `roundRect`): in CPU resta ~100 ms, ed è la ragione per
  cui il riuso dell'immagine copre il movimento. Il renderer GPU (sopra) esiste
  ma il suo vantaggio va misurato su hardware vero.
- `applyOp` copia la mappa dei nodi a ogni op (12 ms a 20.000 nodi), e il
  confronto per l'indice è lineare nel numero di nodi. Servono strutture dati
  persistenti per andare oltre.
- I documenti con componenti ricostruiscono l'indice intero quando cambia un
  nodo dentro un master.
