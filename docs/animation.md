# Animazione

Il documento ha **clip di animazione**: insiemi di tracce (nodo, proprietà) con
keyframe, appese a un nodo "target" (una schermata, un gruppo, un SVG importato)
il cui `enter` / `hover` / `tap` le fa partire. Come i flussi, le clip sono nel
documento e passano per l'op-log: si leggono e si scrivono da editor, MCP e
codice, e sopravvivono al ricaricamento. Questo documento descrive il **modello
dati**, il **motore** che lo campiona, i **tool MCP** e la **generazione di
codice**; l'editor (timeline, riproduzione sul canvas) e l'importatore SVG lo
usano ma stanno altrove.

## Modello

```
Document.clips : map<id, Clip>

Clip     { id, name, duration (ms), trigger, delay (ms), repeat, yoyo,
           tracks[], target_id }
Track    { node_id, prop, keyframes[] }          // una per (nodo, proprietà)
Keyframe { time (ms, 0..duration), value, easing }
```

Due op, **upsert assoluti** come per i flussi (il valore che arriva è il valore
finale, quindi l'inverso di un op è lo stato precedente):

| Op | Numero | Effetto |
|---|---|---|
| `SetClip { clip }` | 25 | crea la clip o la **sostituisce per intero** |
| `DeleteClip { id }` | 26 | la cancella (id inesistente = rifiuto) |

Il modello vive in `proto/opendesigner/v1/opendesigner.proto` (`Keyframe`,
`Track`, `Clip`, `Document.clips = 9`), l'autorità in `internal/core/animation.go`
e lo specchio TypeScript in `web/src/store/applyOp.ts` + `web/src/animation/`.

### Proprietà

| `prop` | Semantica | Valori |
|---|---|---|
| `opacity` | opacità assoluta | 0..1 |
| `x`, `y` | coordinate **locali assolute** del nodo (come `Node.x/y`) | finito |
| `scale` | moltiplicatore, base 1, attorno al centro | finito |
| `rotation` | gradi **assoluti** (come `Node.rotation`) | finito |
| `draw` | quanto del tracciato è disegnato | 0..1; solo su `vector`, `rect`, `ellipse`, `frame` |

Prima del primo keyframe vale il primo valore, dopo l'ultimo vale l'ultimo
(hold). Una traccia con un solo keyframe è una costante.

### Trigger

`enter` (all'apparire della schermata), `hover`, `tap`, `loop` (come `enter` ma
senza fine), `manual` (la fa partire il codice). Il trigger vuoto vale `manual`.
`delay` (ms) ritarda l'inizio; `repeat` è il numero di ripetizioni **extra**
(`-1` = infinito); `yoyo` fa andare al contrario le ripetizioni dispari.

### Easing

L'easing di un keyframe è la curva del **segmento che parte da lui**:

```
easing := "" | "linear" | "easeIn" | "easeOut" | "easeInOut" | "spring"
        | "cubic-bezier(a,b,c,d)"
```

`""` = `linear`. `easeIn`/`easeOut`/`easeInOut` sono le curve CSS
(`cubic-bezier(0.42,0,1,1)`, `(0,0,0.58,1)`, `(0.42,0,0.58,1)`). `spring` è una
molla smorzata criticamente (`1 - (1 + wt)e^(-wt)`, ω = 9.2, riscalata perché
parta da 0, arrivi a 1 e resti monotona: nessun rimbalzo). In `cubic-bezier` i
quattro numeri sono decimali (niente `inf`, `nan`, esadecimali), spazi ammessi
attorno ai numeri; le **ascisse** `a` e `c` stanno in [0,1] come in CSS (le
ordinate possono uscire: overshoot).

### Validazione (`SetClip`)

Rifiutato (sentinelle `Err*` in Go, scena invariata in TS) se: id vuoto; durata
non finita o ≤ 0; `delay` negativo o non finito; `repeat < -1`; trigger ignoto;
target inesistente; per ogni traccia nodo inesistente, proprietà fuori dalla
tabella, nessun keyframe, tempi non finiti / decrescenti / fuori da
`[0, duration]`, valori non finiti (`opacity` e `draw` fuori da [0,1]), easing
fuori dalla grammatica; due tracce con la stessa coppia (nodo, proprietà) nella
stessa clip; `draw` su un nodo senza tracciato (testo, immagine, gruppo,
istanza). Keyframe con lo **stesso tempo** sono permessi: sono uno scatto.

### Cascata

Cancellare un nodo (e il suo sottoalbero) o una pagina:

- toglie le **tracce** sui nodi spariti dalle clip;
- cancella le clip il cui **target** è sparito;
- una clip rimasta **senza tracce ma col target vivo si tiene** (è vuota, non
  orfana).

L'op resta uno (`deleteNode`/`deletePage`); l'**inverso** (undo, lato client in
`web/src/store/history.ts`) ricrea i nodi e **poi** rimette con `setClip` le clip
com'erano. Go sostituisce le clip toccate con copie (mai in place: il clone
copy-on-write del server, `cowClone`, le condivide con la generazione
precedente) e TS fa lo stesso con oggetti nuovi.

## Motore (`web/src/animation/engine.ts`)

Funzioni **pure**, senza DOM né renderer (le userà il playback dell'editor):

| Funzione | Cosa fa |
|---|---|
| `easingFn(spec)` | la curva di un segmento; cubic-bezier con solver vero (Newton + bisezione); una spec non valida ripiega su `linear` |
| `sampleTrack(track, t)` | valore a `t` ms: hold prima/dopo, easing del keyframe che apre il segmento, scatti per tempi uguali |
| `sampleClip(clip, t)` | `Map<nodeId, {opacity?, x?, y?, scale?, rotation?, draw?}>` |
| `clipTimeline(clip, elapsed)` | tempo reale -> `{t, done}`: ritardo, ripetizioni, yoyo, ripetizione infinita |

`isValidClip` (`web/src/animation/validate.ts`) è la validazione di Go, per
`applyOp` e per l'undo.

## Tool MCP

Descrizioni pensate per un agente (ripetono il modello in breve):

| Tool | Uso |
|---|---|
| `list_clips` | le clip con target, trigger, durata, numero di tracce |
| `get_clip` | una clip con tutte le tracce e i keyframe (con i nomi dei nodi) |
| `create_clip` | una clip intera con le tracce, in una chiamata |
| `set_clip` | **sostituisce** una clip: si legge con `get_clip`, si modifica, si rimanda |
| `delete_clip` | cancella una clip |
| `animate_node` | comodo: una proprietà di un nodo da un valore a un altro (`from` default = valore attuale; `draw` default 0 -> 1; `easing` default `easeOut`; `duration` default 600; `trigger` default `enter`; `delay` sfalsa la traccia). Trova o crea la clip sul **frame/gruppo più vicino** che contiene il nodo (il nodo stesso se sta sulla pagina) con lo stesso trigger, aggiunge o sostituisce la traccia e allunga la durata |

`get_document` include `clips`. Gli errori sono validati col core prima di
spedire l'op e dicono cosa correggere (proprietà ammesse, easing validi, ...).

## Codice generato

`opendesigner export` (e `export_code`) traduce le clip: `react` in **Motion**
(`motion/react`, varianti `initial` / `animate` / `hover` / `tap` sul target),
`html` in **CSS `@keyframes`** senza dipendenze. La mappatura completa, il
trattamento dei delta (`x`, `y`, `rotation` sono relativi alla posizione e alla
rotazione già scritte) e i limiti stanno in [codegen.md](codegen.md#animazioni).
In breve:

| Trigger | react | html |
|---|---|---|
| `enter` | `animate` al mount | `animation:` sull'elemento |
| `loop` | `repeat: Infinity` (`repeatType` `reverse` se yoyo) | `animation-iteration-count: infinite` (`alternate` se yoyo) |
| `hover` | `whileHover="hover"` | `.target:hover .elemento` |
| `tap` | `whileTap="tap"` | `.target:active .elemento` |
| `manual` | variante col nome della clip | classe col nome della clip sul target |

Verifica reale: `pnpm export-anim-app` (in `web/`) esporta una schermata con una
clip per trigger nei due target, compila l'app react con `tsc` + `vite build` e
fa girare in Chromium un test che campiona opacità, transform e tratto nel tempo.

## Limiti (per ora)

- **Nessun morph** fra forme: si animano proprietà numeriche, non i punti di un
  tracciato.
- **Nessuno stagger** automatico: per sfalsare più elementi si usano tracce con
  tempi diversi (o `delay` in `animate_node`).
- **Nessun trigger di scroll**: solo enter / hover / tap / loop / manual.
- Le proprietà sono sei; nessun colore, ombra, dimensione o `d` del tracciato.
- Le tracce di una clip devono stare dentro il suo target (nel codice una
  traccia fuori è ignorata con un avviso); nessuna animazione dentro le istanze
  dei componenti.
- L'export non anima `draw` su rect/ellisse/frame (box CSS senza tracciato).
