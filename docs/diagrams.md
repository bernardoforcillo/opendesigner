# Diagrammi

**Menu del documento → Crea diagramma…** disegna un flowchart sul canvas a
partire da testo [Mermaid](https://mermaid.js.org/syntax/flowchart.html). Il
risultato è un gruppo di livelli normali (forme, frecce, testo): si modifica,
si esporta e si annulla con un solo passo di undo.

```
flowchart TD
  A[Inizio] --> B{Utente registrato?}
  B -->|sì| C[Accedi]
  B -->|no| D[Registrati]
  D --> C
  C --> E([Fine])
```

## Sintassi letta

- Intestazione `flowchart` / `graph` con `TD`, `TB`, `BT`, `LR`, `RL`.
- Nodi: `A[rettangolo]`, `A(arrotondato)`, `A([pillola])`, `A((cerchio))`,
  `A{decisione}`; etichette tra virgolette e `<br/>` per andare a capo.
- Archi: `-->`, `---`, `-.->`, `==>`, `<-->`, con testo `-->|sì|` o `-- sì -->`;
  concatenati (`A --> B --> C`) o a gruppi (`A & B --> C`).
- Le righe `subgraph`, `style`, `classDef`, `click`… si ignorano; gli altri tipi
  di diagramma (sequence, class, …) vengono rifiutati con un messaggio.

Tetto: 200 nodi e 400 archi.

## Come funziona

`web/src/diagram/`: `mermaid.ts` (parser) → `layout.ts` (disposizione a livelli
con archi di ritorno invertiti e nodi finti per gli archi lunghi) → `toSvg.ts`
(SVG) → l'import SVG esistente (`tools/svgImport.ts`). È tutto deterministico:
lo stesso testo dà sempre lo stesso diagramma.

I diagrammi di questa pagina sono **disegni**; i flussi tra schermate che
alimentano specifica e test sono descritti in `docs/flows.md`.

## Limiti noti

Gli archi non sono collegati ai nodi: spostando una forma la freccia resta dov'è
(servirebbe un tipo di nodo "connettore" nel modello). Niente `subgraph`.
