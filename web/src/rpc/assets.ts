// THE ASSET CLIENT — two functions, one per direction.
//
// It does not go through Connect, and that is a choice, not a shortcut. The design
// called for `UploadAsset` as a client-stream: browsers' `fetch` cannot
// send a streaming request body, so a Connect client-stream is not
// reachable from here (it is the same reason the design's bidi `Sync` became
// unary + server-stream, see the .proto). And the download must anyway be
// a URL that an `<img src>` can load on its own: a unary that answers
// JSON with base64 inside would cost a third more bytes and a blob to
// mount by hand. The asset path therefore sits entirely behind
// internal/server/assets.go.

import { tokenFor } from "./access";

// The prefix is /assets-api/ and NOT /assets/: `opendesigner serve` serves the compiled
// frontend from the root, and Vite writes its own bundles in dist/assets/. The
// development proxy (web/vite.config.ts) already forwards this prefix to :8080.
export const ASSET_PREFIX = "/assets-api";

/**
 * The URL from which the browser loads an asset. It is what ends up in an
 * `<img src>` (renderer/imageCache.ts) and in the href of an SVG export.
 *
 * `encodeURIComponent` on both segments: they are data, not pieces of
 * path. The server rejects anything that is not a UUID and a hash anyway,
 * but building the URL with encoding is what prevents this side from
 * FORMULATING a request with a slash inside.
 */
export function assetUrl(docId: string, hash: string): string {
  // A protected document's images carry the link token: an <img> cannot set a header.
  const token = tokenFor(docId);
  return `${ASSET_PREFIX}/${encodeURIComponent(docId)}/${encodeURIComponent(hash)}${token === "" ? "" : `?k=${encodeURIComponent(token)}`}`;
}

/** The response to an upload: the hash is the only part that ends up in the model. */
export interface AssetRef {
  hash: string;
  size: number;
  contentType: string;
}

// A hash is 64 lowercase hex digits (the sha256 the server prints). The
// response is validated rather than trusted: what comes from here ends up inside
// an op, that is in the op-log, and a malformed hash would stay there forever --
// pointing to an asset that no GET could ever serve.
const HASH_RE = /^[0-9a-f]{64}$/;

export function isAssetHash(hash: string): boolean {
  return HASH_RE.test(hash);
}

/**
 * Uploads a file and returns its reference.
 *
 * The body is the BARE file, without multipart: there is a single file per request and
 * no fields accompanying it, so a multipart envelope would only add
 * a parser on both sides. The browser streams the body on its
 * own, at the transport level: no chunk framing to invent.
 *
 * `fetchFn` is injectable because `fetch` does not exist in every test environment, and it
 * is the only contact with the network in the whole image path.
 */
export async function uploadAsset(
  docId: string,
  file: Blob,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<AssetRef> {
  const res = await fetchFn(`${ASSET_PREFIX}/${encodeURIComponent(docId)}`, {
    method: "POST",
    // The Content-Type declared by the client decides nothing on the server (it
    // recognizes the type from the bytes, see store.DetectImageType): it travels because it is
    // true, not because anyone trusts it.
    headers: {
      ...(file.type ? { "Content-Type": file.type } : {}),
      ...(tokenFor(docId) !== "" ? { Authorization: `Bearer ${tokenFor(docId)}` } : {}),
    },
    body: file,
  });
  if (!res.ok) {
    throw new Error(uploadErrorMessage(res.status));
  }
  const body = (await res.json()) as Partial<AssetRef>;
  if (typeof body?.hash !== "string" || !isAssetHash(body.hash)) {
    throw new Error("the server responded without a valid hash");
  }
  return {
    hash: body.hash,
    size: typeof body.size === "number" ? body.size : file.size,
    contentType: typeof body.contentType === "string" ? body.contentType : file.type,
  };
}

// The message the user reads. The statuses the server really produces
// have a sentence of their own, because they say WHAT TO DO; for everything else
// the code remains, which is more useful than an "unknown error".
export function uploadErrorMessage(status: number): string {
  switch (status) {
    case 415:
      return "this format is not supported: use PNG, JPEG, GIF or WebP (fonts: TTF, OTF, WOFF or WOFF2)";
    case 413:
      return "the image is too large (the limit is 32 MB)";
    case 403:
      return "your link does not allow uploading to this document";
    case 404:
      return "the document no longer exists on the server";
    default:
      return `the server responded ${status}`;
  }
}
