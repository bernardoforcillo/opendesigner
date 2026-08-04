// IL CLIENT DEGLI ASSET — due funzioni, una per verso.
//
// Non passa da Connect, ed è una scelta, non una scorciatoia. Il design
// prevedeva `UploadAsset` come client-stream: il `fetch` dei browser non sa
// mandare un request body in streaming, quindi un client-stream Connect non è
// raggiungibile da qui (è la stessa ragione per cui il `Sync` bidi del design è
// diventato unary + server-stream, vedi il .proto). E la discesa deve comunque
// essere un URL che un `<img src>` sa caricare da solo: un unary che risponde
// JSON con del base64 dentro costerebbe un terzo di byte in più e un blob da
// montare a mano. Il percorso asset sta quindi tutto dietro
// internal/server/assets.go.

// Il prefisso è /assets-api/ e NON /assets/: `opendesigner serve` serve il frontend
// compilato dalla radice, e Vite scrive i propri bundle in dist/assets/. Il
// proxy di sviluppo (web/vite.config.ts) inoltra già questo prefisso a :8080.
export const ASSET_PREFIX = "/assets-api";

/**
 * L'URL da cui il browser carica un asset. È quello che finisce in un
 * `<img src>` (renderer/imageCache.ts) e nell'href di un export SVG.
 *
 * `encodeURIComponent` su entrambi i segmenti: sono dati, non pezzi di
 * percorso. Il server rifiuta comunque tutto ciò che non è un UUID e un hash,
 * ma costruire l'URL codificando è ciò che impedisce a questo lato di
 * FORMULARE una richiesta con dentro una barra.
 */
export function assetUrl(docId: string, hash: string): string {
  return `${ASSET_PREFIX}/${encodeURIComponent(docId)}/${encodeURIComponent(hash)}`;
}

/** La risposta a un upload: l'hash è l'unica parte che finisce nel modello. */
export interface AssetRef {
  hash: string;
  size: number;
  contentType: string;
}

// Un hash è 64 esadecimali minuscoli (lo sha256 che stampa il server). La
// risposta si valida invece di fidarsi: quello che arriva di qui finisce dentro
// un op, cioè nell'op-log, e un hash malformato ci resterebbe per sempre --
// puntando a un asset che nessuna GET potrà mai servire.
const HASH_RE = /^[0-9a-f]{64}$/;

export function isAssetHash(hash: string): boolean {
  return HASH_RE.test(hash);
}

/**
 * Carica un file e ritorna il suo riferimento.
 *
 * Il body è il file NUDO, senza multipart: c'è un solo file per richiesta e non
 * ci sono campi che lo accompagnano, quindi un involucro multipart aggiungerebbe
 * solo un parser da entrambi i lati. Il browser mette il body in streaming da
 * sé, al livello del trasporto: nessun framing di chunk da inventare.
 *
 * `fetchFn` è iniettabile perché `fetch` non esiste in ogni ambiente di test, ed
 * è l'unico contatto con la rete di tutto il percorso immagini.
 */
export async function uploadAsset(
  docId: string,
  file: Blob,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<AssetRef> {
  const res = await fetchFn(`${ASSET_PREFIX}/${encodeURIComponent(docId)}`, {
    method: "POST",
    // Il Content-Type dichiarato dal client non decide niente sul server (il
    // tipo lo riconosce dai byte, vedi store.DetectImageType): viaggia perché è
    // vero, non perché qualcuno se ne fidi.
    headers: file.type ? { "Content-Type": file.type } : undefined,
    body: file,
  });
  if (!res.ok) {
    throw new Error(uploadErrorMessage(res.status));
  }
  const body = (await res.json()) as Partial<AssetRef>;
  if (typeof body?.hash !== "string" || !isAssetHash(body.hash)) {
    throw new Error("il server ha risposto senza un hash valido");
  }
  return {
    hash: body.hash,
    size: typeof body.size === "number" ? body.size : file.size,
    contentType: typeof body.contentType === "string" ? body.contentType : file.type,
  };
}

// Il messaggio che l'utente legge. Gli stati che il server produce davvero
// hanno una frase propria, perché dicono CHE COSA FARE; per tutto il resto
// resta il codice, che è più utile di un "errore sconosciuto".
export function uploadErrorMessage(status: number): string {
  switch (status) {
    case 415:
      return "questo formato non è supportato: usa PNG, JPEG, GIF o WebP";
    case 413:
      return "l'immagine è troppo grande (il limite è 32 MB)";
    case 404:
      return "il documento non esiste più sul server";
    default:
      return `il server ha risposto ${status}`;
  }
}
