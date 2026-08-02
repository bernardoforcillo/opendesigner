// Unica fonte di verità per i path di SetProperties.mask supportati. Rispecchia
// ESATTAMENTE lo switch di core.applySetProps (Go, internal/core/apply.go:79-86)
// -- quello switch è l'AUTORITÀ su cosa è supportato, questo elenco lo segue,
// mai il contrario. Non aggiungere un path qui senza prima verificare che Go
// lo accetti: applyOp (TS) deve restare semanticamente identico a core.Apply.
//
// PERCHÉ QUESTO FILE ESISTE (e non solo un Set dentro applyOp.ts): il
// trasporto è JSON -- createConnectTransport di connect-web usa JSON di
// default (nessun useBinaryFormat) -- e google.protobuf.FieldMask ha una
// codifica JSON che RISCRIVE il path invece di trasportarlo verbatim:
//   - fieldMaskToJson (in uscita) converte ogni path in lowerCamelCase e
//     LANCIA se la conversione non è reversibile, cioè se
//     protoSnakeCase(protoCamelCase(p)) !== p (verificato in
//     node_modules/@bufbuild/protobuf/dist/esm/to-json.js: fieldMaskToJson).
//   - fieldMaskFromJson (in entrata) fa l'inverso e RIFIUTA categoricamente
//     qualunque underscore sul filo (from-json.js: fieldMaskFromJson).
// Quindi ogni path in questo elenco DEVE essere scritto nella forma
// snake_case "di libreria" (identica a quella usata da Go), MAI nella forma
// camelCase istintiva per chi scrive TypeScript. Per i 9 path di M0 le due
// forme coincidono perché sono tutti monoparola -- il che ha nascosto il
// problema fino a M1b, quando "order_key" (il riordino del pannello livelli,
// Task 8) è diventato il primo path multiparola. Un path del genere scritto qui
// come "orderKey" farebbe THROW in fase di serializzazione, non silenzioso
// ma comunque invisibile all'utente (submit() lo applica in ottimistico PRIMA
// di serializzare, quindi l'errore finisce in un console.error e la scena
// mostra un cambiamento che il server non riceverà mai).
//
// QUESTO COMMENTO NON È LA GUARDIA -- lo sono i test in maskPaths.test.ts, e
// vale la pena sapere quali prima di toccare l'elenco:
//   - it.each(MASK_PATHS) fa passare OGNI path da toJson -> fromJson e pretende
//     che torni identico: un "orderKey" scritto qui non compila un elenco
//     verde, fa fallire quel caso con l'errore "irreversible" esatto che si
//     vedrebbe in produzione. Lo stesso caso verifica anche che il path sia un
//     nome di campo reale di brawt.v1.Node e che applyOp lo applichi davvero.
//   - una guardia cross-language LEGGE internal/core/apply.go e ne estrae i
//     letterali dei `case`: aggiungere un path qui (o solo là) senza l'altro
//     lato fa fallire la suite TypeScript. Go resta l'autorità; questo elenco
//     esiste per non dover ripetere la stessa lista a ogni call site.
//   - il tipo mappato PROBE in quel test costringe chi aggiunge un path ad
//     aggiungergli anche un valore sonda, altrimenti `tsc -b` non passa.
export const MASK_PATHS = [
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
  "name",
  "visible",
  "fills",
  // Primo path MULTIPAROLA della mask (M1b, Task 8: il riordino del pannello
  // livelli). Scritto snake_case come lo scrive Go; sul filo JSON diventa
  // "orderKey" e torna indietro così com'è -- è tutto il motivo per cui questo
  // file esiste, vedi il commento in cima.
  "order_key",
  // M1b, Task 10 (pannello proprietà, aspetto). L'UNICO path della mask che
  // indirizza un campo DENTRO il oneof `shape` -- RectNode.corner_radius --
  // invece che un campo di primo livello del Node: il patch lo porta annidato
  // nella forma (`{ shape: { case: "rect", value: { cornerRadius } } }`) e
  // l'op vale solo su un rettangolo (su un'ellisse o un testo Go risponde
  // ErrNotRectNode e rifiuta l'op intero, vedi applyOp). Multiparola come
  // order_key: sul filo JSON viaggia come "cornerRadius" e torna indietro
  // così com'è -- scriverlo camelCase qui farebbe THROW in serializzazione.
  "corner_radius",
] as const;

// L'UNICO tipo che un path di mask può avere ai punti di costruzione di un op
// (tools/ops.ts::makeSetPropsOp e chiunque lo chiami). Un path che Go non
// supporta diventa un errore di compilazione lì, non un rifiuto silenzioso a
// runtime scoperto solo submittando davvero l'op.
export type MaskPath = (typeof MASK_PATHS)[number];

const MASK_PATH_SET: ReadonlySet<string> = new Set(MASK_PATHS);

// Type guard usata da applyOp per validare i path che arrivano da un Op già
// decodificato (locale o dal filo, via Subscribe) -- lì il tipo è
// `readonly string[]` qualunque cosa dica il codice che li ha originati, quindi
// serve un controllo a runtime oltre alla protezione a compile-time sopra.
export function isMaskPath(path: string): path is MaskPath {
  return MASK_PATH_SET.has(path);
}
