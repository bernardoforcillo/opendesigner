# Export del design in codice

Chiude il giro **design -> app funzionante**: dal documento (scene graph + flussi)
a un progetto che si apre nel browser, con le transizioni dei flussi cablate e i
test e2e già scritti. Un'unica implementazione, in Go (`internal/codegen`), usata
dalla CLI, dall'RPC e dal tool MCP.

```
Document ──> schermate ──> IR (albero di elementi + proprietà CSS) ──┬─> html   (CSS in un <style>)
                                                                     └─> react  (classi Tailwind v4)
```

L'IR è unico: CSS e Tailwind escono dallo **stesso albero**, quindi non possono
divergere (lo verifica anche lo script di parità, vedi sotto). L'output è
deterministico: stesso documento, stessi byte (golden file, diff nei PR).

## Cosa si genera

### Target `react` (default)

Progetto Vite + React 19 + TypeScript + Tailwind v4 (`@tailwindcss/vite`) +
react-router-dom:

| File | Contenuto |
|---|---|
| `src/screens/<Nome>.tsx` | una schermata = un componente, classi Tailwind |
| `src/App.tsx` | le rotte (`BrowserRouter`); la schermata iniziale del flusso è montata anche su `/` |
| `src/main.tsx`, `src/index.css`, `index.html` | scheletro; `index.css` = `@import "tailwindcss"` + import del font Inter |
| `package.json`, `vite.config.ts`, `tsconfig.json` | script `dev` / `build` / `test`, dipendenze alle major correnti |
| `playwright.config.ts` | `webServer` = dev server di Vite; `PW_CHROMIUM_PATH` (opzionale) per un Chromium già installato |
| `tests/flows.spec.ts` | i test di `opendesigner flow tests`, per ogni flusso |
| `public/assets/<hash>.<ext>` | le immagini del documento |
| `README.md` | come avviarlo, come il design diventa codice, come rigenerare |

Ogni file ha in testa un commento "File generato da opendesigner ... rigenerare
con `opendesigner export`" e ogni elemento porta `data-node-id="<id del nodo>"`:
il legame design <-> codice, a costo quasi nullo.

### Target `html`

Un file `.html` **autocontenuto** per schermata (`<slug>.html`): CSS con una
classe per elemento (`.pulsante-3`) in un `<style>`, navigazione fra schermate
con `<a href>`. La schermata iniziale del flusso è `index.html`; senza flusso,
`index.html` è l'elenco delle schermate. Le immagini sono in `assets/`.

## Che cosa è una schermata

Un **frame di primo livello** di una pagina (i master dei componenti, che sono
frame anch'essi, no) più qualunque nodo di primo livello che un flusso
referenzia. Nome del componente = `meta["code.component"]`, altrimenti il nome
del nodo in PascalCase (`Carrello vuoto` -> `CarrelloVuoto`, accenti tolti,
duplicati numerati). Rotta = `meta["code.route"]`, altrimenti `/` + slug del nome.
Le schermate hanno **dimensione fissa** e stanno in alto a sinistra.

## Regole di mappatura

La semantica è quella del **canvas dell'editor** (`web/src/renderer/canvasRenderer.ts`),
non quella "tipica" di un editor di design: il codice esportato deve apparire
come il canvas, non come ci si aspetterebbe.

| Design | Codice |
|---|---|
| Frame con **auto layout** | `display:flex`, `flex-direction`, `gap`, `padding`, `justify-content` / `align-items` da allineamento principale/trasversale (anche `space-between`); **hug** -> `fit-content`, altrimenti misura fissa. I figli sono in flusso (`relative shrink-0`): il core ha già scritto x/y, qui si dice a CSS di rifare la stessa disposizione |
| Tutto il resto | contenitore posizionato, figli `absolute` a `left`/`top` = x/y (relative al parent, come nel modello) |
| Gruppo | wrapper posizionato **senza paint** |
| `clipsContent` | `overflow: hidden` |
| Rotazione | `transform: rotate(Ndeg)`, origine al centro (stessa convenzione oraria del canvas) |
| Rettangolo | `border-radius` clampato a metà del lato più corto |
| Ellisse | `border-radius: 50%` |
| Riempimento | **solo il primo**: colore, `linear-gradient` / `radial-gradient` con la geometria giusta (vedi sotto). Una forma senza riempimento è grigia `#ccc`; un frame senza riempimento è trasparente |
| Tratto | anelli di `box-shadow`: dentro = `inset 0 0 0 Wpx`, fuori = `0 0 0 Wpx`, centro = i due da W/2. Più tratti si sovrappongono nell'ordine del canvas |
| Ombra | la **prima**: `box-shadow` (il blur del canvas è il blur-radius CSS); `drop-shadow()` se il riempimento o il nodo è traslucido, e per immagini e vettori; `text-shadow` per il testo |
| Sfocatura | la **prima**: `filter: blur(Rpx)` |
| Opacità | per nodo e **non ereditata dai figli** (come il canvas): sulle foglie `opacity`, sui frame con figli e sui nodi con ombra l'alfa è moltiplicata nei colori del nodo |
| Testo | `div` con `font-family` (la famiglia del documento + fallback generico; default `Inter, sans-serif`), `font-size` (16), `font-weight` (400), `line-height` (moltiplicatore, 1.2), `text-align`, colore, `white-space: pre-wrap`, larghezza fissa. Gradiente -> `background-clip: text`; tratto -> `-webkit-text-stroke` |
| Immagine | `<img>` con `object-fit: fill` (il canvas la tira sul box) che punta all'asset copiato; se manca, il **segnaposto** del canvas (riquadro tenue, bordo, croce) |
| Vettoriale | `<svg>` inline: path con cubiche (le maniglie `in`/`out` sono offset relativi all'ancoraggio; senza maniglie `L`), riempimento even-odd dei contorni chiusi e tratto da 1.5px tondo, come il canvas |
| Istanza | espansione **inline** del sottoalbero del master, con gli override (fills / testo per nodo del master) |
| Nodo nascosto | saltato (con tutto il sottoalbero) |

**Gradienti.** Il modello li dà in coordinate normalizzate del box; il canvas
colora in base alla proiezione sull'asse P1->P2. Il generatore ricava l'angolo CSS
dalla direzione dell'asse e riscrive le posizioni degli stop come percentuali
della lunghezza CSS (`|w sin| + |h cos|`), spostate di quanto P1 dista dal centro:
su un box non quadrato la diagonale "(0,0)->(1,1)" non è `to bottom right`. Il
canvas interpola i colori **non premoltiplicati** (giallo -> rosa trasparente
passa per gialli-rosati), CSS premoltiplicato: dove due stop hanno alfa diverse
il segmento è spezzato in 8 punti già interpolati alla maniera del canvas.

## Cablaggio dei flussi

Per ogni transizione dei flussi scelti:

- l'**elemento** (`elementId`) è l'innesco: `onClick={() => navigate("<rotta>")}`,
  `role="button"`, `tabIndex={0}`, `aria-label` = etichetta della transizione,
  classe `cursor-pointer`, e `data-testid` da `meta["test.id"]` (sul target html
  l'elemento diventa un `<a href>`);
- una transizione **senza elemento** (o una seconda sullo stesso elemento) diventa
  un `<button>` in un `<nav>` visivamente nascosto (1px trasparente in alto a
  sinistra, nell'albero di accessibilità col nome dell'etichetta);
- trigger `key` -> ascoltatore `keydown` (la label è il tasto); `back` ->
  `navigate(-1)`; `auto` -> solo un commento;
- commenti `// flow: <id>`, `// guard: ...`, `// effect: ...` accanto all'innesco.

Così i locator dei test generati (`getByTestId`, `getByText`,
`getByRole('button', { name })`) trovano gli elementi nel DOM vero. Le schermate
dei flussi senza `code.route` ricevono la rotta di default **prima** di generare i
test (su una copia del documento: il tuo non cambia), quindi nessun test è
`fixme` per una rotta mancante.

> Il `<nav>` nascosto **non** usa `sr-only` di Tailwind: quella utility ritaglia
> l'elemento (`clip`) e Playwright, che prima di cliccare verifica chi riceve il
> puntatore, lo dà alla radice della schermata ("intercepts pointer events").

## Animazioni

Le **clip** del documento (`Document.clips`, vedi [animation.md](animation.md))
diventano animazioni nel codice esportato. Il **target** di una clip è l'elemento
che porta il trigger; gli elementi animati sono il target stesso e i suoi
discendenti (una traccia fuori dal target è ignorata con un avviso). Le tracce
sui nodi dentro un'istanza di componente non si animano.

Valori nello spazio del codice (il design è assoluto, il codice è **relativo**
alla posizione che CSS/Tailwind hanno già scritto):

| Proprietà | react (Motion) | html (CSS) |
|---|---|---|
| `opacity` | `opacity` (assoluta) | `opacity` |
| `x`, `y` | `x`, `y` = **delta** da `node.x`/`node.y` | `--od-x`/`--od-y` (registrate con `@property`) letti da `translate` |
| `scale` | `scale` | proprietà `scale` |
| `rotation` | `rotate` = **delta** in gradi da `node.rotation` | proprietà `rotate` (compone con `transform: rotate()` di base) |
| `draw` | `pathLength` del `motion.path` del tratto | `pathLength="1"` + `stroke-dasharray: <v> 1` |

### `react`: Motion

`package.json` aggiunge `"motion": "^14.0.0"` **solo** se il documento ha clip
(un export senza clip è identico a prima). Ogni elemento con tracce diventa
`motion.div` (o `motion.img`; un vettoriale con `draw` ha un `motion.path`
dentro l'`<svg>`) e riceve una costante `<nome>Variants: Variants` con una
variante per trigger, che **unisce** le clip che lo toccano (una costante per
elemento e non per clip: un elemento toccato da più clip ha comunque un solo
`variants`; il commento sopra ogni costante nomina le clip). Il **target** porta
le etichette:

| Trigger | Sul target | Variante |
|---|---|---|
| `enter` | `initial="initial" animate="animate"` | `initial` (primo keyframe) + `animate` |
| `loop` | come `enter` | `animate` con `repeat: Infinity`, `repeatType: "reverse"` se yoyo, altrimenti `"loop"` |
| `hover` | `whileHover="hover"` | `hover` |
| `tap` | `whileTap="tap"` | `tap` |
| `manual` | nessuna (un commento) | variante col nome della clip (`animate="<nome>"` o `useAnimate`) |

Le etichette si propagano ai discendenti con `variants` (è il meccanismo di
Motion), quindi hover sul target anima i figli. Per ogni proprietà: keyframe
come array, `times` (0..1 della durata della clip), `ease` per segmento (stringa
se uguale ovunque, array altrimenti), `duration`/`delay` in secondi, `repeat`.
Se il primo keyframe non è a 0 (o l'ultimo non è alla fine) si aggiunge
l'estremo di "hold". `spring` esce come `cubic-bezier(0.32,0.66,0.1,1)`, la
Bézier che meglio approssima la molla smorzata criticamente del motore
(`web/src/animation/engine.ts`, scarto massimo 0.04): Motion non ha molle per
segmento.

### `html`: CSS, senza dipendenze

Per ogni traccia un `@keyframes` (percentuali della durata della clip, easing
del segmento in `animation-timing-function` nel keyframe che lo apre; keyframe
allo stesso tempo si distanziano di 0.0001% per non fondersi) e una voce di
`animation:` con fill-mode `both`, `alternate` se yoyo, `infinite` o `repeat+1`.

- `enter`/`loop`: `animation:` sull'elemento.
- `hover`/`tap`: `.target:hover .elemento { animation }` e `:active`; la regola
  **ripete** le animazioni di base (e, per `:active`, quelle di hover): cambiare
  la lista `animation` rilancia da capo quelle che non ci sono più.
- `manual`: `.target.<variante> .elemento`: si avvia aggiungendo la classe
  `<variante>` al target (`el.classList.add("evidenzia")`).

### Limiti dell'export animato

- Browser: `translate`/`rotate`/`scale` come proprietà e `@property` (Chrome 104+,
  Safari 16.4+, Firefox 128+). Nel target react non servono.
- `opacity` su un frame **sfuma anche i figli** (semantica CSS); l'opacità
  statica del canvas non si eredita.
- Uscire dall'hover/tap **riporta di colpo** allo stato di base nel target html
  (nel react Motion anima il ritorno).
- `draw` solo su vettoriali (su rect/ellisse/frame, disegnati come box, è
  ignorata con un avviso). Con tratto a capi tondi, a `draw = 0` resta un
  puntino (lo stesso in Motion).
- Nessun morph, nessuno stagger, nessun trigger di scroll (vedi animation.md).

## Uso

### CLI

```sh
opendesigner export [-workspace DIR] [-doc ID|NOME | -json FILE] [-assets DIR]
                    [-target react|html] [-out DIR] [-flow ID] [-force]
```

- carica il documento **offline** dal workspace (come `opendesigner flow`),
  oppure un `Document` in protojson con `-json` (e `-assets DIR` con i file
  chiamati come l'hash);
- stampa l'elenco dei file scritti; gli avvisi (asset mancanti...) vanno su stderr;
- rifiuta una cartella di destinazione non vuota, a meno di `-force`.

### RPC

```proto
rpc ExportCode(ExportCodeRequest{doc_id, target, flow_id}) returns (ExportCodeResponse{files{path, content}, warnings})
```

Calcolata dal server sullo snapshot corrente e con gli asset del workspace.
`target` o `flow_id` sconosciuti: `InvalidArgument`. È ciò che l'editor chiamerà
per offrire "Esporta codice".

### MCP

`export_code { outDir, target?, flowId?, force? }`: chiama l'RPC e scrive i file
in `outDir`; la descrizione del tool spiega all'agente come il design si mappa
sul codice e quali meta scrivere (`code.route`, `code.component`, `test.id`,
`test.text`) per ottenere test che trovano gli elementi.

## Dal design all'app testata

```sh
# 1. disegna le schermate (frame) e il flusso nell'editor; scrivi test.id / test.text
#    sugli elementi innesco e code.route sulle schermate (set_node_meta, o a mano)
opendesigner flow check -doc Negozio                 # il grafo non ha problemi?

# 2. esporta
opendesigner export -doc Negozio -target react -out ./app

# 3. avvia
cd app && npm install && npm run dev                 # http://localhost:5173

# 4. i test e2e generati dai flussi
npx playwright install chromium                      # solo la prima volta
npx playwright test

# 5. quanto del design è realizzato e testato?
cd .. && opendesigner flow coverage -doc Negozio -repo ./app
```

`flow coverage` trova le schermate esportate (la rotta del nodo, `code.route`,
compare nel codice) e le transizioni testate (i test generati le annotano con
`// flow:<id>`): scrivi `code.route` nei meta delle schermate del documento, non
solo nel codice. Le intestazioni dei file esportati non portano il marcatore
dei file generati di `opendesigner flow tests`, proprio perché le schermate
esportate **sono** l'implementazione.

Il codice esportato è un **punto di partenza**: la rigenerazione non fa merge e
sovrascrive i file. Per far evolvere l'app a mano, esporta una volta e da lì in
poi lavora sul codice (i `data-node-id` e i `// flow:` restano la traccia verso
il design).

## Verifica

Tre livelli, tutti ripetibili.

**1. Test Go** (`go test ./internal/codegen/`): golden file (`testdata/`,
`-update` per riscriverli) per auto layout, posizionamento assoluto, rotazione,
gradienti, tratti, ombre e sfocature, testo, ellisse, immagini presenti e
mancanti, vettori, istanze con override, nodi nascosti, ritaglio e cablaggio dei
flussi; tabella `tailwind_test.go` per la mappatura proprietà -> classi; test su
determinismo, nomi, asset, errori.

**2. Parità dei pixel** (`pnpm export-parity`, in `web/`): esporta la galleria
(`scripts/gen-export-samples`, dieci schermate che coprono tutto quanto sopra),
la renderizza in Chromium a DPR 1 e la confronta con ciò che disegna il **canvas
dell'editor** (`drawScene`) sulla stessa schermata. Poi ripete il confronto fra
il target `html` e il progetto React compilato (Tailwind), che deve dare gli
stessi pixel. Salva editor / export / differenza in `web/export-parity-out/`.

Risultati (differenza media 0..255 e massima sui pixel **fuori dal testo**,
percentuale di pixel con differenza > 32):

| Schermata | media | max | % > 32 |
|---|---|---|---|
| Forme | 0.12 | 20 | 0 |
| Tratti | 0.27 | 124 | 0.12 |
| Gradienti | 0.17 | 3 | 0 |
| Effetti | 0.12 | 12 | 0 |
| Contenitori | 0.14 | 5 | 0 |
| AutoLayout | 0.09 | 20 | 0 |
| Vettori | 0.17 | 92 | 0.002 |
| Immagini | 0.01 | 22 | 0 |
| Istanze | 0.17 | 44 | 0.02 |

Soglie: fuori dal testo al più lo 0.5% di pixel con differenza > 32 e media <
0.5. Le differenze residue sono l'anti-aliasing dei bordi curvi o ruotati
(Skia non fa lo stesso in canvas e in CSS), non geometria. Html contro React:
differenza **0** su tutte le schermate.

**Il testo si misura a parte e con una soglia più larga** (media < 16/255
dentro i rettangoli dei testi, che sono esclusi dal confronto stretto; misurata:
11.0 sulla schermata Testo, 5.5 su Istanze). Canvas e DOM non fanno lo stesso
anti-aliasing né la stessa baseline: il canvas la mette a 0.8em dal bordo
superiore della riga, CSS usa l'ascent vero del font (circa 1px più in basso a
16px con Inter). È una differenza per costruzione, non un difetto da correggere.

**4. Animazioni** (`pnpm export-anim-app`, in `web/`): esporta `samples.AnimDemo`
(una clip per ogni trigger) nei due target, compila l'app react (`npm install`,
`tsc` + `vite build`) e fa girare in Chromium un test Playwright che campiona
opacità, transform e tratto **nel tempo** e sotto hover/tap, per react+Motion e
per html+CSS.

**3. App vera** (`pnpm export-app`, in `web/`): esporta il flusso di esempio
Login -> Home -> Dettaglio, `npm install`, `tsc` + `vite build`, e fa girare i
test Playwright generati contro l'app in Chromium: passano. Serve la rete.

## Limiti noti

- **Testo**: metriche e a capo sono quelli del browser, non quelli del canvas
  (vedi sopra). Il font Inter è importato da Google Fonts; altre famiglie vanno
  rese disponibili dall'app. Il tratto del testo è uno solo (il primo) e sempre
  centrato; un tratto con gradiente ripiega sul primo colore (vale per tutti i
  tratti: un anello di `box-shadow` non si sfuma).
- **Ombre**: l'ombra segue il riempimento (un frame senza riempimento non ne ha:
  il canvas la farebbe dal solo tratto, `box-shadow` non sa farlo). Su un
  contenitore traslucido è un `box-shadow`, che CSS non dipinge dentro il box.
  Sui vettoriali il canvas ombreggia riempimento e tratto separatamente (ombra un
  po' più scura sul bordo); qui è un solo `drop-shadow`.
- **Sfocatura di livello** su un contenitore: in CSS sfoca anche i figli, nel
  canvas no.
- **Vettoriali**: come il canvas, i `strokes` del modello non si disegnano; il
  contorno è sempre il tratto da 1.5px nel colore del riempimento.
- **Istanze**: espanse inline, nessuna estrazione in componenti React. I `test.id`
  del master non si riportano nelle istanze (si duplicherebbero).
- **Nessun vincolo/responsive**: le schermate hanno dimensione fissa.
- Solo i nodi **di primo livello** possono essere schermate; un nodo di flusso
  annidato è omesso (con un avviso).
- Le **immagini** si copiano solo se l'asset è raggiungibile (workspace del
  server, o `-assets` con `-json`); altrimenti segnaposto e avviso.
- I flussi con trigger a testo libero (hover, long press) non sono simulabili
  dai test generati: restano `fixme`, come per `opendesigner flow tests`.
