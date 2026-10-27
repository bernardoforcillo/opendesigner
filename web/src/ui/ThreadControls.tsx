import { useScene } from "@/store/store";
import { nextOrderKey } from "@/store/orderKey";
import { META_NEXT, chainsOf, headOf, isThreaded, nextOf, threadOps, unlinkOps } from "@/store/threads";
import { toPbNode, type NodeLite } from "@/store/types";
import { withMeta } from "@/flow/meta";
import { makeCreateNodeOp, makeSetPropsOp, uuid } from "@/tools/ops";
import { resolveScene } from "@/store/variables";
import { Button } from "@/ui/ds";

// THREADED TEXT FRAMES in the properties panel's Text section (see store/threads.ts).
//
//   · two or more text frames selected  ->  "Thread frames": the text flows from the first into the
//     next, in the order they were selected;
//   · one frame  ->  "Add next frame" (a new empty frame beside it, linked), and "Unlink after this frame"
//     when it flows into another.
//
// Each button is ONE gesture = one undo step.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops | null) {
  if (!ops || ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

const GAP = 24;

export function ThreadControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length === 0) return null;
  const nodes = selection.map((id) => scene.nodes.at(id)).filter((n): n is NodeLite => n !== undefined);
  if (nodes.length !== selection.length || nodes.some((n) => n.kind !== "text" || !n.text)) return null;

  const status = (n: NodeLite): string => {
    if (!isThreaded(scene, n.id)) return "";
    // The overset flag only exists on the derived scene.
    const chain = chainsOf(resolveScene(scene!)).find((c) => c.some((f) => f.id === n.id));
    const at = chain ? chain.findIndex((f) => f.id === n.id) + 1 : 0;
    const overset = chain?.[chain.length - 1]?.overset ? " · text left over" : "";
    return chain ? `Frame ${at} of ${chain.length}${overset}` : "";
  };

  function addNext(n: NodeLite) {
    const copy: NodeLite = {
      ...n,
      id: uuid(),
      name: "Text frame",
      x: n.x + n.width + GAP,
      orderKey: nextOrderKey(scene!),
      text: { content: "", style: n.text!.style },
      meta: undefined,
    };
    run([
      makeCreateNodeOp(toPbNode(copy)),
      makeSetPropsOp(n.id, { meta: withMeta(n, META_NEXT, copy.id) }, ["meta"]),
    ]);
    useScene.getState().setSelection([copy.id]);
  }

  if (nodes.length >= 2) {
    const ops = threadOps(scene, selection);
    return (
      <div className="flex flex-col gap-1.5" role="group" aria-label="Text thread">
        <Button isDisabled={ops === null} onPress={() => run(ops)} className="h-7 w-full">Thread frames</Button>
        <p className="text-[11px] text-fg-subtle">The text flows from the first selected frame into the next, in selection order.</p>
      </div>
    );
  }

  const n = nodes[0];
  const hasNext = nextOf(scene, n) !== null;
  const info = status(n);
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label="Text thread">
      {info && <p className="text-[11px] text-fg-subtle">{info}{headOf(scene, n.id) !== n.id ? " · edit the text in the first frame" : ""}</p>}
      {!hasNext && <Button onPress={() => addNext(n)} className="h-7 w-full">Add next frame</Button>}
      {hasNext && <Button onPress={() => run(unlinkOps(scene, n.id))} className="h-7 w-full">Unlink after this frame</Button>}
    </div>
  );
}
