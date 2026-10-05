import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { nextOrderKey, orderKeyBetween } from "../store/orderKey";
import { uploadAsset, type AssetRef } from "../rpc/assets";
import { makeCreateNodeOp, uuid } from "./ops";
import { importSvgFile, isSvgFile } from "./svgImport";

// DROP AN IMAGE ONTO THE CANVAS (track 3, task 3).
//
// The full path of a drop, in this order:
//   1. MEASURE the file locally (the natural aspect, and the proof that it is
//      a decodable image);
//   2. UPLOAD it to POST /assets-api/{docId}, which answers with the sha256;
//   3. create the node with the HASH -- never the bytes -- in ONE gesture only.
//
// The measuring comes before the upload on purpose: a file the browser cannot
// decode does not even reach the server, and the aspect is needed anyway to
// size the node. The upload comes before creation because the node needs
// the hash: creating first and fixing afterwards would mean two ops for
// a single action, and a node that for an instant points at nothing.

/**
 * The maximum long side (in world units) of a freshly dropped image.
 *
 * A 4000 px photo would otherwise land twenty screens wide: you see
 * a gray corner and it seems that something else happened. The shrinking is
 * PROPORTIONAL, so it never distorts; the user can enlarge it afterwards.
 */
export const MAX_DROP_SIZE = 512;

/** The offset between several images dropped together. */
export const STACK_OFFSET = 16;

const NOT_AN_IMAGE =
  "this file is not an image the browser can read: use PNG, JPEG, GIF or WebP";

/** The natural dimensions of an image file, in pixels. */
export interface NaturalSize {
  width: number;
  height: number;
}

// The two surrounding dependencies (an image decoder and the network): neither
// exists outside a browser, and that is what makes this path
// verifiable without one.
export interface ImageDropDeps {
  measure: (file: Blob) => Promise<NaturalSize>;
  upload: (docId: string, file: Blob) => Promise<AssetRef>;
}

/**
 * The natural dimensions of a file, measured by the browser.
 *
 * It goes through an `<img>` and an object URL rather than `createImageBitmap`
 * because the question is "how big is it", not "give me the decoded pixels": an
 * ImageBitmap would be a decoded copy to close right afterwards. The URL is
 * revoked in every case, success or not -- otherwise every dropped file
 * would leave a live blob for the whole session.
 */
export function measureImage(file: Blob): Promise<NaturalSize> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (fn: () => void) => {
      URL.revokeObjectURL(url);
      fn();
    };
    img.onload = () =>
      done(() =>
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? resolve({ width: img.naturalWidth, height: img.naturalHeight })
          : reject(new Error("image has zero size")),
      );
    img.onerror = () => done(() => reject(new Error("image cannot be decoded")));
    img.src = url;
  });
}

const defaultDeps: ImageDropDeps = {
  measure: measureImage,
  upload: (docId, file) => uploadAsset(docId, file),
};

/**
 * The node box for an image of natural size `size` dropped at
 * `point`: natural aspect, long side at most MAX_DROP_SIZE, CENTERED on the
 * point.
 *
 * Centered and not with the corner on the cursor: a drop has no dragged
 * rectangle to anchor a corner to, and the user is indicating WHERE the image
 * should be. With the top-left corner on the pointer, a large photo
 * would end up almost entirely to the bottom right of where it was
 * dropped.
 */
export function dropBox(size: NaturalSize, point: { x: number; y: number }) {
  const longest = Math.max(size.width, size.height);
  const scale = longest > MAX_DROP_SIZE ? MAX_DROP_SIZE / longest : 1;
  const width = size.width * scale;
  const height = size.height * scale;
  return { x: point.x - width / 2, y: point.y - height / 2, width, height };
}

/** The files of a drag. Empty when there are none (text, link, …). */
export function imageFilesOf(dt: DataTransfer | null): File[] {
  return dt?.files ? Array.from(dt.files) : [];
}

/** Does a drag carry files? It is the dragover question, where `files`
 *  are not yet readable and there is only the list of types. */
export function carriesFiles(dt: DataTransfer | null): boolean {
  const types = dt?.types;
  return types ? Array.from(types).includes("Files") : false;
}

/**
 * Drops files onto the canvas: uploads the images and creates the nodes.
 *
 * Returns the created ids (empty if nothing landed). Every failure --
 * a file that is not an image, a rejected upload -- ends up in `notice` and
 * not in `lastError`: no change was undone, it was not even
 * attempted. It is the same channel as export and unsupported paste.
 */
export async function dropImages(
  files: readonly File[],
  point: { x: number; y: number },
  deps: ImageDropDeps = defaultDeps,
): Promise<string[]> {
  const docId = useScene.getState().scene?.id;
  if (!docId || files.length === 0) return [];

  // SVGs are NOT raster images: they are imported as editable NODES
  // (tools/svgImport.ts), one per file, centered on the drop point and
  // each in its own gesture. The rest of the drop proceeds as usual.
  const svgs = files.filter(isSvgFile);
  if (svgs.length > 0) {
    const rest = files.filter((f) => !isSvgFile(f));
    const restIds = rest.length > 0 ? await dropImages(rest, point, deps) : [];
    const svgIds: string[] = [];
    for (const [i, f] of svgs.entries()) {
      const id = await importSvgFile(f, { x: point.x + i * STACK_OFFSET, y: point.y + i * STACK_OFFSET });
      if (id) svgIds.push(id);
    }
    return [...restIds, ...svgIds];
  }
  // Same guard as paste and undo/redo (store.ts): with a gesture open the ops
  // would enter the BASE of the gesture in progress, and the next pointerup
  // would rebuild the scene on a state that is not the starting one.
  if (useScene.getState().gesture) return [];

  // Measure and upload in PARALLEL across files (they are independent and each is
  // a network round trip), but the result stays indexed: the order of the created nodes
  // is that of the dropped files, not the one in which the server answered.
  //
  // Every successful outcome carries the INDEX of the file it comes from. It is
  // the only way to get back to the file after the failed ones have been discarded:
  // reindexing `files` with the position in the filtered list means
  // reading the WRONG file name as soon as one of the previous ones fails -- and
  // that name ends up in a CreateNode op, i.e. on disk and in the panel.
  const results = await Promise.all(
    files.map(async (
      file,
      index,
    ): Promise<{ ref: AssetRef; size: NaturalSize; index: number } | string> => {
      // The type declared by the operating system is a CHEAP filter,
      // not the authority: it serves to avoid decoding (and uploading) the two-gigabyte
      // video someone dragged by mistake. An EMPTY type --
      // unknown extension -- says nothing and goes on to the measuring, which is what
      // really decides.
      if (file.type !== "" && !file.type.startsWith("image/")) {
        return `${file.name || "the file"}: ${NOT_AN_IMAGE}`;
      }
      let size: NaturalSize;
      try {
        size = await deps.measure(file);
      } catch {
        // The type declared by the operating system decides nothing (it may be
        // ""): it is the measuring that says whether the browser can read this file -- and if
        // it cannot read it, it will not be able to draw it either.
        return `${file.name || "the file"}: ${NOT_AN_IMAGE}`;
      }
      try {
        return { ref: await deps.upload(docId, file), size, index };
      } catch (err) {
        return `${file.name || "the file"}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }),
  );

  const failures = results.filter((r): r is string => typeof r === "string");
  const ok = results.filter(
    (r): r is { ref: AssetRef; size: NaturalSize; index: number } => typeof r !== "string",
  );

  // The store is re-read NOW: between the start and the end of the uploads the user
  // kept working, and the scene (the order keys, a gesture just opened,
  // even the document) may have changed.
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene || scene.id !== docId || store.gesture || ok.length === 0) {
    if (failures.length > 0) useScene.setState({ notice: failures.join(" · ") });
    return [];
  }

  let key = nextOrderKey(scene);
  const ops: Op[] = [];
  const ids: string[] = [];
  // `i` is the position among the SUCCEEDED and `index` the one among the dropped files:
  // they are two different things and serve two different purposes. The offset goes with
  // `i`, so three images of which the first failed land adjacent instead of
  // with a hole; the name goes with `index`, because it is the file that carries it.
  ok.forEach(({ ref, size, index }, i) => {
    const id = uuid();
    const box = dropBox(size, { x: point.x + i * STACK_OFFSET, y: point.y + i * STACK_OFFSET });
    ops.push(
      makeCreateNodeOp(
        create(NodeSchema, {
          id,
          parentId: scene.pages[0]?.id ?? "",
          orderKey: key,
          // The file name as the layer name: it is how the user
          // recognizes the image in the panel, and it costs nothing.
          name: files[index]?.name ?? "Image",
          visible: true,
          opacity: 1,
          ...box,
          // The HASH, not the bytes: it is the invariant of the whole path.
          shape: { case: "image", value: { assetHash: ref.hash } },
        }),
      ),
    );
    ids.push(id);
    key = orderKeyBetween(key, null);
  });

  // ONE gesture per drop, not one per file: a Ctrl+Z removes what the
  // user dropped, all together.
  store.beginGesture();
  useScene.getState().setSelection(ids);
  useScene.getState().endGesture(ops);
  if (failures.length > 0) useScene.setState({ notice: failures.join(" · ") });
  return ids;
}

// The minimum needed to hook in: the tests pass a double instead of a
// real element (same reason as ShortcutTarget in tools/clipboard.ts).
interface DropTarget {
  addEventListener(type: "dragover" | "drop", handler: (e: Event) => void): void;
  removeEventListener(type: "dragover" | "drop", handler: (e: Event) => void): void;
}

/**
 * Hooks the image drop up to an element (the scene canvas).
 * Returns the detach function.
 *
 * The two `preventDefault` calls are not formalities:
 *  - on `dragover` it is what declares the element a valid target; without it,
 *    the `drop` event NEVER arrives;
 *  - on `drop` it is what stops the browser from NAVIGATING to the dropped
 *    file, i.e. from throwing away the open document.
 * Both only when the drag really carries files: a drag
 * of another kind (layer reordering, selected text) must
 * keep behaving as it would without us.
 */
export function attachImageDrop(
  target: DropTarget,
  toWorld: (e: Event) => { x: number; y: number },
  deps: ImageDropDeps = defaultDeps,
): () => void {
  const onDragOver = (e: Event) => {
    if (!carriesFiles((e as DragEvent).dataTransfer)) return;
    e.preventDefault();
  };
  const onDrop = (e: Event) => {
    const files = imageFilesOf((e as DragEvent).dataTransfer);
    if (files.length === 0) return;
    e.preventDefault();
    // The point is read IMMEDIATELY, synchronously: after the first await the event
    // is no longer reliable (the browser recycles it) and the pointer is elsewhere.
    const point = toWorld(e);
    void dropImages(files, point, deps);
  };
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
}
