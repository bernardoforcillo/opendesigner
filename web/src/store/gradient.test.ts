import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { PaintSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { toPbFills, toNodeLite, type FillLite } from "./types";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";

const linear: FillLite = {
  r: 1, g: 0, b: 0, a: 1,
  gradient: {
    kind: "linear",
    stops: [
      { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
      { color: { r: 0, g: 0, b: 1, a: 0.5 }, position: 1 },
    ],
    x1: 0, y1: 0, x2: 1, y2: 1,
  },
};

describe("gradients in the model", () => {
  it("a linear fill makes the Lite -> proto -> Lite round trip without loss", () => {
    const pb = create(NodeSchema, { id: "n", kind: undefined, fills: toPbFills([linear]) } as never);
    const back = toNodeLite(pb);
    expect(back.fills[0]).toEqual(linear);
  });

  it("a radial stays radial and the fallback color is the first stop", () => {
    const radial: FillLite = { ...linear, gradient: { ...linear.gradient!, kind: "radial" } };
    const paint = create(PaintSchema, toPbFills([radial])[0] as never);
    expect(paint.kind.case).toBe("radial");
    const back = toNodeLite(create(NodeSchema, { id: "n", fills: [paint] } as never));
    expect(back.fills[0].gradient?.kind).toBe("radial");
    expect(back.fills[0]).toMatchObject({ r: 1, g: 0, b: 0, a: 1 });
  });

  it("a solid fill does not gain a gradient", () => {
    const solid: FillLite = { r: 0.1, g: 0.2, b: 0.3, a: 1 };
    const back = toNodeLite(create(NodeSchema, { id: "n", fills: toPbFills([solid]) } as never));
    expect(back.fills[0]).toEqual(solid);
    expect("gradient" in back.fills[0]).toBe(false);
  });
});
