import type { ReactNode, SVGProps } from "react";
import { Button as RacButton, TooltipTrigger, type ButtonProps } from "react-aria-components";
import { Icon, type IconName } from "./Icon";
import { Tip } from "./index";
import type { NodeLite } from "../../store/types";

// DESIGN SYSTEM PIECES FOR ANIMATION (timeline, recording).
//
// In a separate file like ds/flow-parts.tsx: the system (ds/index.tsx, ds/Icon.tsx)
// belongs to the lead. Same 16x16 grid, 1.5 stroke, `currentColor`; no hand-written
// colors -- everything from tokens.

const P = {
  // the dock's "Animation" entry: bars of different duration and the playhead crossing them
  timeline: "M2.6 4.6h5.4M5.4 8h6.6M2.6 11.4h4.2M10.6 2.4v11.2",
  sliders: "M2.6 5h10.8M2.6 11h10.8M10 3v4M5.6 9v4",
  pause: "M5.4 3.4v9.2M10.6 3.4v9.2",
  stop: "M4.4 4.4h7.2v7.2H4.4z",
  // the "Record" dot: filled, takes the text color
  record: "M8 12a4 4 0 100-8 4 4 0 000 8z",
  skipStart: "M4 3.4v9.2M12.4 3.6v8.8L6.2 8z",
  diamond: "M8 2.8l4.2 5.2L8 13.2 3.8 8z",
  diamondPlus: "M7 3.4l3.6 4.4L7 12.2 3.4 7.8zM13 3.4v4.4M10.8 5.6h4.4",
  loop: "M3.5 7.5v-1a2 2 0 012-2h6.2M9.7 2.6l2 1.9-2 1.9M12.5 8.5v1a2 2 0 01-2 2H4.3M6.3 9.6l-2 1.9 2 1.9",
  curve: "M2.6 13.4C5.6 13.4 5.2 2.6 13.4 2.6M2.6 13.4h10.8V2.6",
  zoomIn: "M7 11.6a4.6 4.6 0 100-9.2 4.6 4.6 0 000 9.2zM10.4 10.4l3.2 3.2M5.2 7h3.6M7 5.2v3.6",
  zoomOut: "M7 11.6a4.6 4.6 0 100-9.2 4.6 4.6 0 000 9.2zM10.4 10.4l3.2 3.2M5.2 7h3.6",
  fit: "M2.6 6V2.6H6M10 2.6h3.4V6M13.4 10v3.4H10M6 13.4H2.6V10",
  wand: "M3 13l7-7M9.6 3.4l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7zM13 9.4l.4.9.9.4-.9.4-.4.9-.4-.9-.9-.4.9-.4z",
  // the node type of a track row (ds/Icon's icons do not cover "group" or "vector")
  group: "M2.6 5.4h10.8v8H2.6zM5 5.4V3.4h6.2v2",
  vector: "M3.2 12.6c1.4-6.4 4.2-8.8 9.6-9.2M3.2 12.6a1 1 0 100-.01M12.8 3.4a1 1 0 100-.01",
} as const;

export type AnimIconName = keyof typeof P;

export function AnimIcon({
  name, size = 16, className, ...rest
}: { name: AnimIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  // `record` is a filled disc: the others are stroke only.
  const filled = name === "record" || name === "diamond";
  return (
    <svg
      viewBox="0 0 16 16" width={size} height={size} fill={filled ? "currentColor" : "none"} stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" className={className} {...rest}
    >
      <path d={P[name]} />
    </svg>
  );
}

export function AnyAnimIcon({ name, size = 16 }: { name: IconName | AnimIconName; size?: number }) {
  return name in P ? <AnimIcon name={name as AnimIconName} size={size} /> : <Icon name={name as IconName} size={size} />;
}

/** The icon for a node's TYPE (track row, target list). */
export function nodeKindIcon(n: Pick<NodeLite, "kind"> | undefined): IconName | AnimIconName {
  switch (n?.kind) {
    case "rect": return "rect";
    case "ellipse": return "ellipse";
    case "text": return "text";
    case "image": return "image";
    case "frame": return "frame";
    case "group": return "group";
    case "vector": return "vector";
    case "instance": return "components";
    default: return "rect";
  }
}

// Icon-only button: twin of IconButton (ds/index.tsx) that also accepts this
// file's icons, with a "record" tone (red: recording is armed).
// `label` is the accessible name and the tooltip text.
export function AnimIconButton({
  icon, label, shortcut, selected, tone = "accent", size = 28, className = "", children, ...props
}: Omit<ButtonProps, "children" | "aria-label"> & {
  icon: IconName | AnimIconName; label: string; shortcut?: string; selected?: boolean;
  tone?: "accent" | "record"; size?: number; className?: string; children?: ReactNode;
}) {
  const on = tone === "record" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent";
  return (
    <TooltipTrigger delay={350} closeDelay={0}>
      <RacButton
        {...props}
        aria-label={label}
        aria-pressed={selected === undefined ? undefined : selected}
        style={{ width: size, height: size }}
        className={`relative inline-flex shrink-0 items-center justify-center rounded-md outline-none transition-colors ` +
          `data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[focus-visible]:shadow-[var(--ring)] ` +
          `${selected ? on : "text-fg-muted hover:bg-surface-3 hover:text-fg"} ${className}`}
      >
        <AnyAnimIcon name={icon} />
        {children}
      </RacButton>
      <Tip label={label} shortcut={shortcut} />
    </TooltipTrigger>
  );
}
