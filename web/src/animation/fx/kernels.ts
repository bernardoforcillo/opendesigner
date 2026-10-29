// The effects that need the node's pixels offscreen (kernels), generators, masks and
// Expression Controls. See fx/kit.ts for how they are written.

import type { FxDef } from "@/animation/fx/library";
import { BLUR_FX } from "@/animation/fx/kernelsBlur";
import { COLOR_FX } from "@/animation/fx/kernelsColor";
import { DISTORT_FX } from "@/animation/fx/kernelsDistort";
import { GEN_FX } from "@/animation/fx/kernelsGen";

export const KERNEL_FX: readonly FxDef[] = [...DISTORT_FX, ...BLUR_FX, ...COLOR_FX, ...GEN_FX];
