# Animazioni

<!-- Esportato da opendesigner (opendesigner export): README del documento "Animazioni" (anim). NON modificare a mano:
rigenerare con `opendesigner export`. L'attributo data-node-id lega ogni elemento al nodo del design. -->

Progetto React + TypeScript + Tailwind v4 generato dal design con `opendesigner export`.

## Come si avvia

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # controllo dei tipi + build di produzione
```

## Come il design diventa codice

- Ogni **schermata** (frame di primo livello) è un componente in `src/screens/<Nome>.tsx`; `src/App.tsx` ne monta le rotte (`meta["code.route"]` del frame, altrimenti lo slug del nome). La schermata iniziale del flusso è montata anche su `/`.
- **Auto layout** -> flexbox (`flex`, `gap`, `padding`, `justify-*`, `items-*`); tutto il resto è posizionato in modo assoluto (`absolute left-[..] top-[..]`) dentro il contenitore, con le coordinate del design. `hug` -> `fit-content`.
- Riempimenti, tratti (interno/centro/esterno -> anelli di `box-shadow`), ombre, sfocature, rotazione, ritaglio, testo e vettori seguono **ciò che disegna il canvas dell'editor** (primo riempimento, prima ombra, prima sfocatura).
- Le **immagini** sono copiate in `public/assets/<hash>.<ext>`; se mancano compare il segnaposto del canvas.
- Ogni elemento porta `data-node-id="<id del nodo>"`: è il legame fra il design e il codice.
- Le **istanze** dei componenti sono espanse inline (non c'è ancora l'estrazione in componenti React).
- Le schermate hanno dimensione fissa (niente responsive).

## Animazioni

Le **clip** del design diventano animazioni con [Motion](https://motion.dev) (`import { motion } from "motion/react"`): ogni elemento con tracce è un `motion.div` (o `motion.svg`/`motion.path`) con una costante `<nome>Variants` e il suo **target** porta le etichette che le innescano sui discendenti.

- `enter` -> `initial="initial" animate="animate"` (parte al mount); `loop` -> come enter ma con `repeat: Infinity` (`repeatType: "reverse"` se yoyo); `hover` -> `whileHover="hover"`; `tap` -> `whileTap="tap"`.
- `x`/`y` sono **delta** dalla posizione del design, `rotate` un delta in gradi (compone con la rotazione di base), `scale` un moltiplicatore, `opacity` assoluta, `draw` -> `pathLength` (0..1) del tratto di un vettoriale.
- Ogni proprietà ha i suoi keyframe (`[..]`), i `times` (0..1 della clip) e un `ease` per segmento; `spring` è approssimata da una curva di Bézier.
- Una clip **manuale** non parte da sola: ha una variante col nome indicato in tabella; per avviarla imposta `animate="<variante>"` sull'elemento target (di norma da uno stato React) oppure pilotala con `useAnimate`.

| Clip | Trigger | Target | Durata | Variante |
|---|---|---|---|---|
| caricamento | loop | `spin` | 1000 ms | `animate` |
| disegna la firma | enter | `logo` | 1200 ms | `animate` |
| entrata | enter | `scr` | 800 ms | `animate` |
| evidenzia | manual | `card` | 300 ms | `evidenzia` |
| hover | hover | `btn` | 200 ms | `hover` |
| inclina | hover | `tilt` | 300 ms | `hover` |
| pressione | tap | `btn` | 100 ms | `tap` |

## Schermate

| Componente | Rotta | Nodo del design |
|---|---|---|
| `Animazioni` | `/` | `scr` (Animazioni) |

## Rigenerare

```sh
opendesigner export -doc anim -target react -out . -force
```

I file generati non vanno modificati a mano: la prossima esportazione li sovrascrive. Per far evolvere il progetto a mano, esporta una volta e da lì in poi lavora sul codice (la rigenerazione non fa merge).
