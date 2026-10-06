import type { SVGProps } from "react";

// THE ICONS (and small pieces) OF DEVELOPMENT MODE. Same design as ds/Icon.tsx
// -- 16x16 grid, 1.5 stroke, round caps, currentColor -- but in a separate
// file so as not to touch the shared set. Decorative (aria-hidden): the
// accessible name comes from the button that contains them.
const P = {
  terminal: "M3 3h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zM4.8 6.2L7 8.2l-2.2 2M8.6 10.4h2.6",
  rocket: "M9.6 2.4c2.2-.2 3.8.2 4 .4.2.2.6 1.8.4 4-.2 1.7-1.6 3-3 3.9l-3.2-3.2c.9-1.4 2.2-2.8 3.8-3.1zM6.8 6.4L4.4 6.8 2.8 8.6 5.2 9M9.6 9.2L9.2 11.6 7.4 13.2 7 10.8M4.6 11.4c-.9.2-1.6.9-1.8 2 1.1-.2 1.8-.9 2-1.8",
  circleCheck: "M8 14A6 6 0 108 2a6 6 0 000 12zM5.4 8.2l1.8 1.8 3.4-3.6",
  circleX: "M8 14A6 6 0 108 2a6 6 0 000 12zM6 6l4 4M10 6l-4 4",
  circleDot: "M8 14A6 6 0 108 2a6 6 0 000 12zM8 9.4a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8z",
  circleWarn: "M8 14A6 6 0 108 2a6 6 0 000 12zM8 5v3.4M8 10.8a.3.3 0 100-.01",
  file: "M4 2h5l3 3v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1zM9 2v3h3M5.4 8.2h5.2M5.4 10.6h3.4",
  folder: "M2.4 4.2a1 1 0 011-1h3l1.4 1.6h4.8a1 1 0 011 1v6.2a1 1 0 01-1 1H3.4a1 1 0 01-1-1z",
  split: "M3 3h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zM8 3v10",
  refresh: "M13.4 8a5.4 5.4 0 11-1.6-3.8M13.4 2.6v3h-3",
  wand: "M3 13l7.2-7.2M9.4 4.2l2.4 2.4M11.6 2l.6 1.2 1.2.6-1.2.6-.6 1.2-.6-1.2-1.2-.6 1.2-.6zM4.4 3.4l.4.8.8.4-.8.4-.4.8-.4-.8-.8-.4.8-.4z",
  package: "M8 1.8l5.4 2.8v6.8L8 14.2l-5.4-2.8V4.6zM2.8 4.8L8 7.6l5.2-2.8M8 7.6v6.4",
  robot: "M4 5.4h8a1 1 0 011 1V12a1 1 0 01-1 1H4a1 1 0 01-1-1V6.4a1 1 0 011-1zM8 5.4V3M8 2.6a.4.4 0 100-.01M6 8.8a.3.3 0 100-.01M10 8.8a.3.3 0 100-.01M6.4 11h3.2",
} as const;

export type DevIconName = keyof typeof P;

export function DevIcon({
  name, size = 16, className, ...rest
}: { name: DevIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" className={className} {...rest}
    >
      <path d={P[name]} />
    </svg>
  );
}

export const DEV_ICON_NAMES = Object.keys(P) as DevIconName[];
