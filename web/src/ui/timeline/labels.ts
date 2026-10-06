// The English labels of the animation model's closed sets.

export const TRIGGER_LABELS: Record<string, string> = {
  enter: "Enter",
  hover: "Hover",
  tap: "Tap",
  loop: "Loop",
  manual: "Manual",
};

export const TRIGGER_HINTS: Record<string, string> = {
  enter: "Starts when the screen appears",
  hover: "Starts when the pointer enters the target",
  tap: "Starts on press of the target",
  loop: "Like enter, but never ends",
  manual: "Started by code",
};

export const EASING_LABELS: Record<string, string> = {
  linear: "Linear",
  easeIn: "Ease in",
  easeOut: "Ease out",
  easeInOut: "Ease in-out",
  spring: "Spring",
  custom: "Curve…",
};
