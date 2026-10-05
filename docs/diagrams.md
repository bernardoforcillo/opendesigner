# Diagrammi e UML

Si descrive un diagramma in testo [Mermaid](https://mermaid.js.org/) e
opendesigner lo disegna sul canvas come un **gruppo di livelli normali** (forme,
frecce, testo): si modifica, si esporta e, nell'editor, si annulla con un solo
passo di undo. Il disegno lo calcola il **server** (`internal/diagram`), quindi
l'editor e gli agenti MCP producono esattamente lo stesso diagramma.

| Tipo | Intestazione | Cosa disegna |
|---|---|---|
| Flowchart | `flowchart TD` / `graph LR` | nodi in cinque forme, archi pieni, tratteggiati o spessi |
| Classi UML | `classDiagram` | classi a tre scomparti, ereditarietà, composizione, aggregazione, associazione, dipendenza, realizzazione |
| Sequenza UML | `sequenceDiagram` | partecipanti, messaggi, attivazioni, note, frammenti `loop`/`alt`/`opt`/`par` |
| Stati UML | `stateDiagram-v2` | stati, transizioni, pallino di inizio e fine, scelta |

Gli altri tipi di Mermaid (ER, Gantt, …) vengono rifiutati con un messaggio.

## Dall'editor

Menu del documento → **Diagramma (Mermaid, UML)…**. La finestra ha un esempio
per ogni tipo. Con un diagramma selezionato la finestra si apre sul suo testo e
**Aggiorna** lo ridisegna al suo posto (stesso nome e posizione).

## Da MCP

| Tool | Cosa fa |
|---|---|
| `create_diagram` | disegna un diagramma da `source`; `parentId`, `x`, `y`, `name` opzionali (di default a destra di ciò che c'è già) |
| `update_diagram` | ridisegna un diagramma esistente da nuovo testo, nello stesso punto; ritorna l'id nuovo |
| `list_diagrams` | elenca i diagrammi con tipo, posizione e testo sorgente |

Il testo sorgente resta nel `meta` della radice (`diagram.source`, `diagram.kind`),
quindi un agente può rileggere un diagramma e correggerlo con `update_diagram`
invece di spostare le forme a mano. Un testo illeggibile è un errore di tool che
dice la riga; nessuna modifica resta a metà.

Dal protocollo Connect: `DocumentService.RenderDiagram(source)` è pura (non
tocca il documento) e restituisce i nodi, pronti da inserire.

## Sintassi letta

**Flowchart.** `A[rettangolo]`, `A(arrotondato)`, `A([pillola])`, `A((cerchio))`,
`A{decisione}`; archi `-->`, `---`, `-.->`, `==>`, `<-->`, con testo `-->|sì|` o
`-- sì -->`; catene `A --> B --> C` e gruppi `A & B --> C`; `<br/>` va a capo.

**Classi.**

```
classDiagram
  class Animale {
    <<abstract>>
    +String nome
    +mangia() void
  }
  Animale <|-- Anatra
  Proprietario "1" --> "*" Animale : possiede
  Anatra ..> Stagno : usa
```

Relazioni: `<|--` / `--|>` ereditarietà, `*--` composizione, `o--`
aggregazione, `-->` associazione, `..>` dipendenza, `..|>` realizzazione, `--` e
`..` collegamenti; molteplicità tra virgolette ed etichetta dopo `:`. Chi porta
il triangolo o il rombo sta sopra. Un membro con `(` è un metodo, gli altri sono
attributi; `Nome~T~` diventa `Nome<T>`.

**Sequenza.** `participant A as Alice`, `actor B`; messaggi `->>` (pieno),
`-->>` (risposta tratteggiata), `->`/`-->` (senza punta), `-x` (perso), `-)`
(asincrono); `+`/`-` dopo la freccia attivano/disattivano; `activate`/
`deactivate`; `Note over A,B: …`, `Note left of A`, `Note right of A`;
`autonumber`; blocchi `loop`, `alt`/`else`, `opt`, `par`/`and`, `critical`/
`option`, `break` chiusi da `end`.

**Stati.** `[*] --> A`, `A --> B : evento`, `state "Nome lungo" as X`,
`state X <<choice>>`, `X : descrizione`, `direction LR`. Gli stati composti
(`state X { … }`) si appiattiscono: le transizioni interne restano, il riquadro
no.

Tetti: 200 nodi, 400 archi, 60 partecipanti, 2000 eventi, 64 KiB di testo. Le
righe `subgraph`, `style`, `classDef`, `click` si ignorano.

## Limiti noti

- Le frecce **non sono agganciate** alle forme: spostando un nodo la freccia
  resta dov'è. Per cambiare un diagramma si riscrive il testo (`update_diagram`
  o Aggiorna). Servirebbe un tipo di nodo "connettore" nel modello.
- La larghezza del testo è stimata (il server non ha font): i riquadri hanno un
  po' d'aria in più.
- Nessun tratteggio nel modello: le linee tratteggiate sono disegnate a trattini.
- Niente `subgraph`, note nei diagrammi di classi e di stati, ER.

I flussi tra schermate (specifica e test Playwright) sono un'altra cosa: vedi
`docs/flows.md`.
