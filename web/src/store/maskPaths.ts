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
// problema fino ad ora. Il primo path multiparola (es. "corner_radius", il
// prossimo candidato naturale per M1b: RectNode.corner_radius) scritto qui
// come "cornerRadius" farebbe THROW in fase di serializzazione, non silenzioso
// ma comunque invisibile all'utente (submit() lo applica in ottimistico PRIMA
// di serializzare, quindi l'errore finisce in un console.error e la scena
// mostra un cambiamento che il server non riceverà mai). Vedi
// applyOp.test.ts per il round-trip che pin-a questa convenzione.
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
