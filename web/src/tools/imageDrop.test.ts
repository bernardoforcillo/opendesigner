import { describe, it, expect, beforeEach, vi } from "vitest";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import {
  MAX_DROP_SIZE,
  STACK_OFFSET,
  attachImageDrop,
  dropImages,
  imageFilesOf,
  type ImageDropDeps,
} from "./imageDrop";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HASH2 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function installScene(): void {
  // `setScene` clears queue, history and notices but NOT the open gesture (it is
  // interaction state, not document state): without this line the test that checks the
  // "with a gesture open" guard would leave the gesture open for all the following ones.
  useScene.setState({ gesture: null, lastError: null });
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
}

function fakeFile(name: string, type: string): File {
  return { name, type, size: 1234 } as unknown as File;
}

// The two surrounding dependencies: measuring (which needs an image decoder) and
// the network. Neither exists in jsdom, and that is what makes the path
// verifiable without a browser.
function deps(over: Partial<ImageDropDeps> = {}): ImageDropDeps {
  return {
    measure: async () => ({ width: 200, height: 100 }),
    upload: async () => ({ hash: HASH, size: 1234, contentType: "image/png" }),
    ...over,
  };
}

function nodes(): NodeLite[] {
  const s = useScene.getState().scene;
  return s ? [...s.nodes.values()] : [];
}

describe("dropImages", () => {
  beforeEach(() => {
    installScene();
  });

  it("uploads the file and creates ONE image node with only the hash", async () => {
    const upload = vi.fn(async (_docId: string, _file: Blob) => ({
      hash: HASH, size: 1234, contentType: "image/png",
    }));
    const ids = await dropImages([fakeFile("logo.png", "image/png")], { x: 0, y: 0 }, deps({ upload }));

    expect(ids.length).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);
    // The upload knows which DOCUMENT the asset belongs to: the folder is per
    // document, and so is the read URL.
    expect(upload.mock.calls[0][0]).toBe("doc-1");

    const n = nodes()[0];
    expect(n.kind).toBe("image");
    expect(n.image?.assetHash).toBe(HASH);
    // The bytes are NOT in the model: that is the whole point of content
    // addressing.
    expect(JSON.stringify(n).length).toBeLessThan(500);
  });

  it("the node has the file's natural ASPECT", async () => {
    await dropImages([fakeFile("a.png", "image/png")], { x: 0, y: 0 },
      deps({ measure: async () => ({ width: 200, height: 100 }) }));
    const n = nodes()[0];
    expect(n.width / n.height).toBeCloseTo(2);
    // Under the cap the size is the real one: a 200x100 icon must not
    // land inflated.
    expect(n.width).toBe(200);
    expect(n.height).toBe(100);
  });

  it("a huge image is shrunk WITHOUT distortion", async () => {
    await dropImages([fakeFile("photo.jpg", "image/jpeg")], { x: 0, y: 0 },
      deps({ measure: async () => ({ width: 4000, height: 2000 }) }));
    const n = nodes()[0];
    // The long side reaches the cap, the aspect stays 2:1.
    expect(n.width).toBe(MAX_DROP_SIZE);
    expect(n.height).toBe(MAX_DROP_SIZE / 2);
  });

  it("the node is CENTERED on the drop point", async () => {
    await dropImages([fakeFile("a.png", "image/png")], { x: 500, y: 300 },
      deps({ measure: async () => ({ width: 200, height: 100 }) }));
    const n = nodes()[0];
    expect(n.x).toBe(500 - 100);
    expect(n.y).toBe(300 - 50);
  });

  it("it is ONE gesture only, hence ONE undo entry", async () => {
    await dropImages(
      [fakeFile("a.png", "image/png"), fakeFile("b.png", "image/png")],
      { x: 0, y: 0 },
      deps(),
    );
    expect(nodes().length).toBe(2);
    // Two images, one Ctrl+Z: the gesture is the drop, not the file.
    expect(useScene.getState().undoStack.length).toBe(1);
    expect(useScene.getState().canUndo).toBe(true);
  });

  it("several images are staggered instead of overlapping exactly", async () => {
    const hashes = [HASH, HASH2];
    let i = 0;
    await dropImages(
      [fakeFile("a.png", "image/png"), fakeFile("b.png", "image/png")],
      { x: 0, y: 0 },
      deps({ upload: async () => ({ hash: hashes[i++], size: 1, contentType: "image/png" }) }),
    );
    const sorted = nodes().sort((a, b) => a.x - b.x);
    expect(sorted[1].x - sorted[0].x).toBe(STACK_OFFSET);
    expect(sorted[1].y - sorted[0].y).toBe(STACK_OFFSET);
  });

  it("the created nodes stay SELECTED", async () => {
    const ids = await dropImages([fakeFile("a.png", "image/png")], { x: 0, y: 0 }, deps());
    expect(useScene.getState().selection).toEqual(ids);
  });

  it("a file that is not an image creates nothing and SAYS so", async () => {
    const upload = vi.fn();
    const ids = await dropImages([fakeFile("appunti.txt", "text/plain")], { x: 0, y: 0 }, deps({ upload }));
    expect(ids).toEqual([]);
    expect(nodes()).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    expect(useScene.getState().notice).toContain("image");
  });

  // The type declared by the operating system can be "" (unknown extension):
  // it is the MEASURING that decides whether a file is an image, not its label.
  it("a file with no declared type but decodable is accepted", async () => {
    const ids = await dropImages([fakeFile("no-extension", "")], { x: 0, y: 0 }, deps());
    expect(ids.length).toBe(1);
  });

  it("a file that declares itself an image but does not decode is rejected", async () => {
    const ids = await dropImages([fakeFile("rotta.png", "image/png")], { x: 0, y: 0 },
      deps({ measure: async () => { throw new Error("decode failed"); } }));
    expect(ids).toEqual([]);
    expect(nodes()).toEqual([]);
    expect(useScene.getState().notice).toBeTruthy();
  });

  it("a failed upload becomes a NOTICE, not a node pointing at nothing", async () => {
    const ids = await dropImages([fakeFile("a.png", "image/png")], { x: 0, y: 0 },
      deps({ upload: async () => { throw new Error("the server answered 413"); } }));
    expect(ids).toEqual([]);
    expect(nodes()).toEqual([]);
    expect(useScene.getState().notice).toContain("413");
    // It goes through `notice` and not `lastError`: no change was
    // undone -- it was never even attempted.
    expect(useScene.getState().lastError).toBeNull();
  });

  it("if a single image fails, the others land anyway", async () => {
    let n = 0;
    const ids = await dropImages(
      [fakeFile("a.png", "image/png"), fakeFile("b.png", "image/png")],
      { x: 0, y: 0 },
      deps({
        upload: async () => {
          if (n++ === 0) throw new Error("boom");
          return { hash: HASH2, size: 1, contentType: "image/png" };
        },
      }),
    );
    expect(ids.length).toBe(1);
    expect(nodes().length).toBe(1);
    // The survivor carries the name of its OWN file, not that of the failed one:
    // discarding the failed ones shortens the list, and reusing the position to read
    // `files` means reading the wrong name.
    expect(nodes()[0].name).toBe("b.png");
    expect(useScene.getState().notice).toBeTruthy();
  });

  // The name ends up in a CreateNode op, i.e. on DISK (op-log) and in the layers
  // panel: getting it wrong is not passing cosmetics, it is persisted bad data.
  it("node names follow the ORIGIN files even when the first ones fail", async () => {
    // The outcome is tied to the FILE and not to the order of the calls: uploads
    // start in parallel, and a test that counted the calls would be
    // asserting the resolution order instead of the behavior.
    const ids = await dropImages(
      [
        fakeFile("first-failed.png", "image/png"),
        fakeFile("second.png", "image/png"),
        fakeFile("third.png", "image/png"),
      ],
      { x: 0, y: 0 },
      deps({
        upload: async (_docId, file) => {
          if ((file as File).name === "first-failed.png") throw new Error("boom");
          return { hash: HASH2, size: 1, contentType: "image/png" };
        },
      }),
    );

    expect(ids.length).toBe(2);
    // Sorted by x: the stack offset grows with the position among the
    // SUCCEEDED, so the order on the axis is the creation order.
    const sorted = nodes().sort((a, b) => a.x - b.x);
    expect(sorted.map((nd) => nd.name)).toEqual(["second.png", "third.png"]);
    // And the two succeeded stay ADJACENT: the offset does not leave the hole of the
    // failed file.
    expect(sorted[1].x - sorted[0].x).toBe(STACK_OFFSET);
  });

  // The mirror of the case above: when one in the MIDDLE fails, the last
  // file's name must not vanish behind that of the previous one.
  it("node names follow the ORIGIN files even with a hole in the middle", async () => {
    const ids = await dropImages(
      [
        fakeFile("first.png", "image/png"),
        fakeFile("in-the-middle.txt", "text/plain"),
        fakeFile("last.png", "image/png"),
      ],
      { x: 0, y: 0 },
      deps(),
    );

    expect(ids.length).toBe(2);
    const sorted = nodes().sort((a, b) => a.x - b.x);
    expect(sorted.map((nd) => nd.name)).toEqual(["first.png", "last.png"]);
  });

  it("with an OPEN gesture the drop does nothing", async () => {
    // Same guard as paste and undo/redo: the ops would end up in the base of the
    // gesture in progress, and the next pointerup would rebuild from a state that
    // is not the starting one.
    useScene.getState().beginGesture();
    const ids = await dropImages([fakeFile("a.png", "image/png")], { x: 0, y: 0 }, deps());
    expect(ids).toEqual([]);
    expect(nodes()).toEqual([]);
  });

  it("without an open document it does nothing", async () => {
    useScene.getState().setScene(null);
    expect(await dropImages([fakeFile("a.png", "image/png")], { x: 0, y: 0 }, deps())).toEqual([]);
  });
});

describe("imageFilesOf", () => {
  it("takes the files and ignores the rest of the drag", () => {
    const dt = {
      files: [fakeFile("a.png", "image/png")],
      types: ["Files"],
    } as unknown as DataTransfer;
    expect(imageFilesOf(dt).length).toBe(1);
    expect(imageFilesOf(null).length).toBe(0);
    expect(imageFilesOf({ files: [] } as unknown as DataTransfer).length).toBe(0);
  });
});

describe("attachImageDrop", () => {
  beforeEach(() => {
    installScene();
  });

  function target() {
    const handlers: Record<string, (e: Event) => void> = {};
    return {
      handlers,
      el: {
        addEventListener: (t: string, h: (e: Event) => void) => { handlers[t] = h; },
        removeEventListener: (t: string) => { delete handlers[t]; },
      },
    };
  }

  it("cancels the browser behavior on both the drag and the drop", () => {
    // WITHOUT preventDefault on dragover the drop event NEVER arrives; without
    // preventDefault on drop the browser NAVIGATES to the file, i.e. throws away the
    // open document. They are the two lines that make the function exist.
    const t = target();
    attachImageDrop(t.el, () => ({ x: 0, y: 0 }), deps());

    const over = { preventDefault: vi.fn(), dataTransfer: { files: [], types: ["Files"] } };
    t.handlers.dragover(over as unknown as Event);
    expect(over.preventDefault).toHaveBeenCalled();

    const drop = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [fakeFile("a.png", "image/png")], types: ["Files"] },
    };
    t.handlers.drop(drop as unknown as Event);
    expect(drop.preventDefault).toHaveBeenCalled();
  });

  it("a drag that carries no files is not intercepted", () => {
    // Selecting text in the layers panel and dragging it onto the canvas is not
    // an image drop: stealing that event would prevent any other
    // drag (layer reordering, say) from working.
    const t = target();
    attachImageDrop(t.el, () => ({ x: 0, y: 0 }), deps());
    const over = { preventDefault: vi.fn(), dataTransfer: { files: [], types: ["text/plain"] } };
    t.handlers.dragover(over as unknown as Event);
    expect(over.preventDefault).not.toHaveBeenCalled();
  });

  it("the drop goes through the point in WORLD coordinates", async () => {
    const t = target();
    const toWorld = vi.fn(() => ({ x: 700, y: 800 }));
    attachImageDrop(t.el, toWorld, deps({ measure: async () => ({ width: 100, height: 100 }) }));
    const drop = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [fakeFile("a.png", "image/png")], types: ["Files"] },
    };
    t.handlers.drop(drop as unknown as Event);
    await vi.waitFor(() => expect(nodes().length).toBe(1));
    expect(toWorld).toHaveBeenCalled();
    expect(nodes()[0].x).toBe(650);
  });

  it("the detach function really removes the listeners", () => {
    const t = target();
    const detach = attachImageDrop(t.el, () => ({ x: 0, y: 0 }), deps());
    expect(Object.keys(t.handlers).sort()).toEqual(["dragover", "drop"]);
    detach();
    expect(Object.keys(t.handlers)).toEqual([]);
  });
});
