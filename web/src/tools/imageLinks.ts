import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { defaultDeps, type ImageDropDeps } from "./imageDrop";
import { makeSetImageOp, makeSetPropsOp } from "./ops";
import { useScene } from "../store/store";
import type { NodeLite, SceneState } from "../store/types";

// LINKED IMAGES. An image node is a reference to a file in the document's asset store plus what is known about the
// file it was placed from: its name and its size in pixels (recorded when it is dropped). That is what the
// "link" shows -- the name, the size, the EFFECTIVE RESOLUTION (pixels per inch at the size it is placed: 72 world
// units are one inch) and a way to RELINK to another file, replacing the source and keeping the frame. The editor
// cannot watch the file on disk (a browser has no path to it), so "update" is relinking to the new version.

/** Pixels per inch of an image at its placed size, or null when its pixel size is unknown. */
export function effectivePpi(n: NodeLite): number | null {
  const px = n.image?.pixelWidth ?? 0;
  if (n.kind !== "image" || px <= 0 || !(n.width > 0)) return null;
  return (px / n.width) * 72;
}

export type PpiStatus = "unknown" | "low" | "ok";
/** `low` below 150 ppi (a screen image placed in print), `ok` otherwise. */
export function ppiStatus(ppi: number | null): PpiStatus {
  return ppi === null ? "unknown" : ppi < 150 ? "low" : "ok";
}

export interface ImageLink { id: string; name: string; originalName: string; pixelWidth: number; pixelHeight: number; ppi: number | null; pageId: string }

/** Every image of the document with what its link says, in document order. */
export function imageLinks(scene: SceneState): ImageLink[] {
  const pageIds = new Set(scene.pages.map((p) => p.id));
  const pageOf = (n: NodeLite): string => {
    let cur: NodeLite | undefined = n;
    for (let i = 0; cur && i < 1000; i++) { if (pageIds.has(cur.parentId)) return cur.parentId; cur = scene.nodes.get(cur.parentId); }
    return "";
  };
  const index = new Map(scene.pages.map((p, i) => [p.id, i] as const));
  return [...scene.nodes.values()]
    .filter((n) => n.kind === "image" && !n.fromMaster)
    .map((n) => ({
      id: n.id, name: n.name, originalName: n.image?.originalName ?? "", pixelWidth: n.image?.pixelWidth ?? 0, pixelHeight: n.image?.pixelHeight ?? 0,
      ppi: effectivePpi(n), pageId: pageOf(n), y: n.y, x: n.x,
    }))
    .sort((a, b) => ((index.get(a.pageId) ?? 0) - (index.get(b.pageId) ?? 0)) || a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1))
    .map(({ y: _y, x: _x, ...rest }) => (void _y, void _x, rest));
}

export type FitMode = "proportions" | "actual" | "print";

/**
 * Resizes an image node from its pixel size: `proportions` keeps the width and restores the image's shape, `actual`
 * places it at 72 ppi (one pixel = one world unit), `print` at 300 ppi.
 */
export function fitImageOps(scene: SceneState, ids: readonly string[], mode: FitMode): Op[] {
  const ops: Op[] = [];
  for (const id of ids) {
    const n = scene.nodes.get(id);
    const pw = n?.image?.pixelWidth ?? 0, ph = n?.image?.pixelHeight ?? 0;
    if (!n || n.kind !== "image" || pw <= 0 || ph <= 0) continue;
    const width = mode === "proportions" ? n.width : mode === "actual" ? pw : (pw * 72) / 300;
    const height = (width * ph) / pw;
    if (Math.abs(width - n.width) < 1e-9 && Math.abs(height - n.height) < 1e-9) continue;
    ops.push(makeSetPropsOp(id, { width, height }, ["width", "height"]));
  }
  return ops;
}

/**
 * Relinks image node `nodeId` to `file`: measures and uploads it, then replaces the source in one gesture, keeping the
 * node's width and restoring the new image's shape. Failures end up in `notice`. Returns whether it worked.
 */
export async function relinkImage(nodeId: string, file: File, deps: ImageDropDeps = defaultDeps): Promise<boolean> {
  const store = useScene.getState();
  const docId = store.scene?.id;
  if (!docId || store.gesture) return false;
  if (file.type !== "" && !file.type.startsWith("image/")) {
    useScene.setState({ notice: `${file.name || "the file"} is not an image.` });
    return false;
  }
  try {
    const size = await deps.measure(file);
    const ref = await deps.upload(docId, file);
    const st = useScene.getState();
    const n = st.scene?.nodes.get(nodeId);
    if (!st.scene || st.scene.id !== docId || !n || n.kind !== "image" || st.gesture) return false;
    st.beginGesture();
    st.endGesture([
      makeSetImageOp(nodeId, { assetHash: ref.hash, originalName: file.name, pixelWidth: size.width, pixelHeight: size.height }),
      makeSetPropsOp(nodeId, { height: (n.width * size.height) / size.width }, ["height"]),
    ]);
    return true;
  } catch (err) {
    useScene.setState({ notice: `Relink failed: ${err instanceof Error ? err.message : String(err)}` });
    return false;
  }
}

/** Opens the system file picker for an image; resolves null when it is cancelled. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    const done = (f: File | null) => { input.remove(); resolve(f); };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}
