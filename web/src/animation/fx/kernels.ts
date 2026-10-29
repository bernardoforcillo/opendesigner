// The effects that need the node's pixels offscreen (kernels), generators, masks and
// Expression Controls. See fx/kit.ts for how they are written.

import type { FxDef } from "@/animation/fx/library";
import { BLUR_FX } from "@/animation/fx/kernelsBlur";
import { COLOR_FX } from "@/animation/fx/kernelsColor";
import { DISTORT_FX } from "@/animation/fx/kernelsDistort";
import { TIME_FX } from "@/animation/fx/timeFx";
import { MORE_FX } from "@/animation/fx/kernelsMore";
import { MORE3_FX } from "@/animation/fx/kernelsMore3";
import { MORE2_FX } from "@/animation/fx/kernelsMore2";
import { LAST_FX } from "@/animation/fx/kernelsLast";
import { SIM_FX } from "@/animation/fx/kernelsSim";
import { GEN_FX } from "@/animation/fx/kernelsGen";

export const KERNEL_FX: readonly FxDef[] = [...DISTORT_FX, ...BLUR_FX, ...COLOR_FX, ...GEN_FX, ...TIME_FX, ...MORE_FX, ...MORE2_FX, ...MORE3_FX, ...LAST_FX, ...SIM_FX];
