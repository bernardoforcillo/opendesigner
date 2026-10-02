# Roadmap

Obiettivo: un editor di design local-first, con co-design AI nativo (MCP), che
possa sostituire Figma per team piccoli e per chi vuole design e codice insieme.

Legenda: [x] fatto · [ ] da fare

## 1. Parità di base
- [x] Forme, testo, immagini, vettoriale, gruppi, frame, pagine
- [x] Componenti con istanze e override
- [x] Gradienti lineari e radiali (canvas, SVG, pannello, MCP)
- [ ] Più stop per gradiente, gradiente su tratti dal pannello, immagine come fill
- [x] Effetti: ombra esterna e sfocatura del livello (canvas, SVG, pannello, MCP, copia/incolla; ne disegna una per tipo per nodo)
- [ ] Effetti: più ombre per nodo, ombra interna, sfocatura di sfondo, blend mode
- [x] Auto layout: direzione, spazio, padding, allineamenti, hug; calcolato dal server (Shift+A avvolge la selezione, strumento Frame, pannello, MCP `create_frame`/`set_auto_layout`)
- [x] Auto layout: riordino trascinando i figli (anche verso un altro auto layout), con linea d'inserimento e contorno; un solo passo di undo
- [ ] Auto layout: figli che riempiono lo spazio (fill), wrap su più righe, trascinare un figlio FUORI dal frame, gruppi e istanze come figli
- [ ] Constraints e resize responsivo
- [ ] Varianti e proprietà dei componenti, librerie condivise
- [ ] Variabili / design token con modalità
- [ ] Tipografia: font caricabili, stili di testo, testo multiriga
- [ ] Boolean operations, outline stroke, maschere
- [ ] Prototipazione e modalità presentazione
- [ ] Import SVG (poi .fig)

## 2. Collaborazione
- [x] Multiplayer sulla stessa rete: nickname, avatar, cursori e selezioni degli altri, link `#doc=` per entrare nello stesso documento (niente account, di proposito)
- [x] Gli agenti MCP compaiono come persone nella presenza (nome con `-nickname`, default "Claude"; evidenziano il nodo che stanno modificando)
- [ ] Conflitti sulla stessa proprietà: oggi vince l'ultimo op arrivato al server
- [ ] Commenti sul canvas
- [ ] Versioni nominate e branching (sull'oplog)

## 3. Handoff ed ecosistema
- [ ] Dev mode: misure, CSS/Tailwind/React
- [ ] Plugin API
- [ ] Sync token e componenti col codice

## 4. Prestazioni
- [x] Rendering a invalidazione, indice di scena incrementale, scarto di ciò che non si vede, livelli di dettaglio, riuso dell'immagine durante pan/zoom; banco di prova su 20.000 nodi (vedi docs/performance.md)
- [ ] Rendering su GPU (WebGL/WebGPU o Skia/CanvasKit), con font caricabili
- [ ] Strutture dati persistenti per la scena (applyOp senza copiare tutta la mappa)

## 5. Differenziatori
- [ ] Agente AI MCP: revisioni di coerenza, varianti, uso dei token
- [ ] Formato bundle versionabile con git (diff leggibili)
