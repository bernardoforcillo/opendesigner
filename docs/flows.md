# Flussi: dal disegno alla specifica, ai test, alla coverage

Il grafo dei flussi che si disegna nell'editor non è un'illustrazione: è la
**specifica** di cosa l'app deve fare. Da lì opendesigner ricava, senza altro
input:

- una **specifica Markdown** da leggere o da consegnare a un agente AI;
- una **suite e2e Playwright** generata, un test per ogni percorso;
- un **report di coverage**: quali schermate esistono nel codice e quali
  transizioni sono coperte da un test;
- una **checklist di attività** con le lacune, pronta per l'issue tracker.

Tutto è calcolato da funzioni pure sul documento (`internal/flow`), quindi lo
stesso grafo dà sempre gli stessi byte: si può versionare, confrontare in una PR
e usare come gate in CI.

> L'editor ha una vista dedicata per disegnare e collegare le schermate; è
> sviluppata a parte e non è descritta qui. Tutto ciò che segue funziona anche
> senza, da CLI e da tool MCP.

## Il modello

- **Flusso** (`Flow`): un percorso dell'utente. Ha `id`, `name`, `description` e
  una schermata di ingresso (`start_id`).
- **Schermata**: un normale nodo del documento (di solito un frame), referenziato
  per id. Non è una copia: spostarla o rinominarla non rompe il flusso.
- **Transizione** (`Transition`): un arco `from -> to` dentro un flusso, con
  `label`, `trigger`, `element_id`, `guard` ed `effect`.

Invarianti garantite dal server: una transizione appartiene a un flusso
esistente e collega nodi esistenti; cancellare un flusso ne cancella le
transizioni; cancellare un nodo cancella le transizioni che lo attraversano,
svuota lo `start_id` dei flussi che partivano da lui e azzera l'`element_id` di
chi lo usava come hotspot.

### Campi di una transizione

| Campo | Significato |
|---|---|
| `label` | testo dell'elemento che innesca (es. il bottone "Accedi") |
| `trigger` | `click` (default), `submit`, `auto`, `key`, `back` o testo libero. Con `key` la `label` è il tasto da premere |
| `element_id` | opzionale: il nodo DENTRO `from` che innesca (l'hotspot) |
| `guard` | condizione per cui l'arco è percorribile, testo libero ("carrello non vuoto") |
| `effect` | ciò che l'arco cambia, testo libero ("ordine creato") |

## Convenzioni sui metadati dei nodi

Ogni nodo ha una mappa libera `meta` (chiave -> valore). Gli strumenti dei flussi
leggono queste chiavi; il modello non le impone.

| Chiave | Valori | Uso |
|---|---|---|
| `flow.kind` | `screen` (default), `decision`, `action`, `start`, `end`, `note` | `end` termina i percorsi ed è l'unico tipo lecito senza uscite |
| `code.route` | es. `/login`, `/cart/:id`, `/p/[slug]` | rotta che realizza la schermata: `goto` e asserzione dell'URL nei test, ricerca nel codice per la coverage |
| `code.component` | es. `LoginPage` | componente che la realizza: ricerca nel codice per la coverage |
| `test.id` | es. `go-login` | `data-testid` di un elemento: locator `getByTestId` |
| `test.text` | es. `Vai al carrello` | testo accessibile di un elemento: locator `getByText` |
| `status` | `planned` (default), `implemented`, `tested` | override manuale dello stato di una schermata |

`test.id` e `test.text` si mettono sul nodo che fa da `element_id` di una
transizione. I segmenti parametrici delle rotte (`:id`, `[id]`) diventano
`[^/]+` nell'asserzione dell'URL.

## Analisi

`opendesigner flow check` (e l'RPC `AnalyzeFlows`, e il tool `analyze_flows`)
segnalano, con messaggi in italiano che citano la schermata:

| Tipo | Quando |
|---|---|
| `empty` | il flusso non ha transizioni |
| `no_start` | ha transizioni ma nessuna schermata iniziale |
| `unreachable` | una schermata non è raggiungibile dall'ingresso |
| `dead_end` | una schermata raggiungibile non ha uscite e non è `end` |
| `ambiguous` | due uscite della stessa schermata hanno stesso trigger ed elemento e nessuna `guard` che le distingua (o `guard` identica) |

Elenca anche i **percorsi** dall'ingresso a una schermata finale o a un ciclo
(un arco che torna su una schermata già nel percorso: il percorso si ferma lì,
`loops=true`). Le uscite si visitano per `(label, id)`. Tetto: 200 percorsi e
profondità 50, oltre i quali il report è `paths_truncated`.

## CLI

```
opendesigner flow <spec|tests|coverage|check|tasks> [-workspace DIR] [-doc ID-o-NOME]
                  [-flow ID] [-repo DIR] [-out FILE] [-format md|json] [-min PCT]
```

Il documento si apre **offline** dal workspace (lo stesso di `serve`, di default
`~/.opendesigner`): nessun server necessario e il workspace non viene
modificato, quindi si può lanciare anche mentre `serve` è in esecuzione. `-doc`
accetta l'id o il nome esatto e si può omettere se esiste un solo documento.

| Comando | Cosa fa |
|---|---|
| `spec` | specifica Markdown: schermate, transizioni numerate, scenari Given/When/Then, problemi |
| `tests` | file TypeScript `@playwright/test` con un `test()` per percorso |
| `coverage` | schermate implementate e transizioni testate in `-repo`; `-format json` per le macchine; `-min 80` esce con 1 sotto soglia |
| `check` | stampa i problemi; **esce con 1 se ce n'è almeno uno** |
| `tasks` | checklist Markdown delle lacune (schermate da implementare, transizioni da testare, problemi del grafo) |

`-flow` restringe a un flusso, `-out` scrive su file. Codici d'uscita: 0 ok, 1
gate non superato (`check`, `coverage -min`), 2 errore d'uso o di lettura.

### Come funziona la coverage

- Una **transizione è testata** se un file sorgente del repository contiene
  `flow:<id-transizione>`. I test generati lo emettono già come commento
  (`// flow:t1`) prima di ogni passo.
- Una **schermata è implementata** se la sua `code.route` o il suo
  `code.component` compaiono in un file sorgente non generato e non di test
  (`*.spec.*`, `*.test.*`, `*_test.go`), oppure se `status` è `implemented` /
  `tested`. La rotta `/` da sola compare ovunque, quindi conta solo come stringa
  quotata (`"/"`).
- Si saltano `node_modules`, `.git`, `dist`, `vendor`, `gen`, i file binari, i
  file oltre 1 MiB e quelli generati (`Code generated`, `DO NOT EDIT`, e i test
  prodotti da `flow tests`, che citano rotte e componenti senza implementarli).
- Il totale è `(schermate implementate + transizioni testate) / (schermate +
  transizioni)`; una schermata condivisa fra più flussi conta una volta.

## Tool MCP

Un agente collegato con `opendesigner mcp` può guidare l'intero flusso di lavoro.
Le descrizioni dei tool ripetono le convenzioni, così ne basta uno per capire il
modello.

| Tool | Cosa fa |
|---|---|
| `list_flows` | elenca i flussi con ingresso e dimensioni |
| `get_flow` | un flusso con schermate (nome, tipo, rotta, componente, stato) e transizioni |
| `create_flow` | crea un flusso, opzionalmente con la schermata iniziale |
| `delete_flow` | cancella il flusso e le sue transizioni (le schermate restano) |
| `set_transition` | crea (senza `id`) o aggiorna (con `id`) un arco; in aggiornamento i campi omessi restano |
| `delete_transition` | cancella un arco |
| `set_node_meta` | fonde chiavi nel `meta` di un nodo (`unset` per rimuoverne); valida `flow.kind` e `status` |
| `analyze_flows` | problemi e percorsi, uno o tutti i flussi |
| `get_flow_spec` | la specifica Markdown, da usare come requisito |

`set_node_meta` fa read-modify-write: il campo `meta` di `SetProperties` sostituisce
l'intera mappa, quindi il tool legge quella corrente, fonde e riscrive. `get_document`
e `list_nodes` espongono ora anche `meta`.

Ciclo tipico di un agente: `get_flow_spec` per leggere cosa costruire, realizzare le
schermate, `set_node_meta` per scrivere `code.route` e `code.component`, `analyze_flows`
per verificare il grafo, poi `opendesigner flow tests` e `coverage` per chiudere il cerchio.

## Ricetta CI

```yaml
- name: Il grafo dei flussi è coerente
  run: opendesigner flow check -workspace ./design -doc "Shop"

- name: Rigenera i test e2e dal disegno
  run: opendesigner flow tests -workspace ./design -doc "Shop" -out e2e/flows.generated.spec.ts

- name: Esegui i test e2e
  run: npx playwright test

- name: Coverage dei flussi
  run: opendesigner flow coverage -workspace ./design -doc "Shop" -repo . -min 80
```

Il file generato porta in testa l'avviso "File generato da opendesigner": non va
modificato a mano. I passi che non si riescono a risolvere (manca `code.route`
sulla schermata iniziale, nessun `test.id`/`test.text`/etichetta per trovare il
trigger) diventano `// TODO` e il test è marcato `test.fixme`, così la suite non
fallisce ma il debito è visibile. Per i test scritti a mano basta annotare ogni
passo con `// flow:<id>` perché la coverage li conti.

## Esempio

Un flusso "Acquisto": Home -> Login -> Carrello -> Pagamento -> Grazie.

1. Nell'editor (o con `create_flow` / `set_transition`) si collegano le
   schermate. Il bottone "Accedi" di Home ha `test.id = go-login` ed è
   l'`element_id` della transizione `t-login`.
2. Sulle schermate: Home `code.route=/`, Login `code.route=/login`, Carrello
   `code.route=/cart/:id`, Grazie `flow.kind=end` e `code.route=/thanks`.
3. `opendesigner flow check -doc Shop` stampa `OK: 1 flussi senza problemi`.
4. `opendesigner flow tests -doc Shop -out e2e/flows.spec.ts` produce, per ogni
   percorso:

   ```ts
   test("percorso 1: Home → Login → Carrello → Pagamento → Grazie", async ({ page }) => {
     await page.goto("/");

     // flow:t-login
     // Home -> Login
     await page.getByTestId("go-login").click();
     await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/login/?(?:[?#].*)?$"));
     ...
   });
   ```

5. `opendesigner flow coverage -doc Shop -repo . -min 80` dice quali schermate
   mancano nel codice e quali archi non hanno test; `opendesigner flow tasks -doc
   Shop` ne fa una checklist da incollare in un issue.
