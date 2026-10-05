import type { SVGProps } from "react";

// THE ICONS: a single set, drawn on a 16x16 grid with a 1.5 stroke and
// rounded caps. No library: it is about thirty paths, colored with
// `currentColor`, so they follow the text (and the theme) on their own.
//
// Icons are decorative (aria-hidden): the accessible NAME comes from the
// button that contains them (aria-label), never from the icon -- so tests and
// screen readers see the same labels as ever.
const P: Record<string, string> = {
  select: "M3.2 2.4l9.2 4.3-4 1.3-1.4 4z",
  hand: "M5.5 8V3.8a1 1 0 012 0V7m0-3.7a1 1 0 012 0V7m0-2.2a1 1 0 012 0V9m0-2.2a1 1 0 012 0V10a4.5 4.5 0 01-4.5 4.5h-.6A4 4 0 015 12.6L3 9.6a1 1 0 011.6-1.2L5.5 9.7",
  frame: "M5.6 2v12M10.4 2v12M2 5.6h12M2 10.4h12",
  rect: "M3.5 3.5h9a1 1 0 011 1v7a1 1 0 01-1 1h-9a1 1 0 01-1-1v-7a1 1 0 011-1z",
  ellipse: "M8 3.2c3 0 5.5 2 5.5 4.8S11 12.8 8 12.8 2.5 10.8 2.5 8 5 3.2 8 3.2z",
  text: "M3 4.2V3h10v1.2M8 3v10M6 13h4",
  pen: "M2.8 13.2l.8-3.2 6.7-6.7a1.2 1.2 0 011.7 0l.9.9a1.2 1.2 0 010 1.7L6.2 12.6zM9.2 4.4l2.4 2.4",
  image: "M3 3h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zM2.4 11.2l3.2-3.1 2.4 2.3 2-1.8 3.6 3.3M10.6 6.2a.4.4 0 100-.01",
  connect: "M3 11.5V5.5m0 0h4.2a2.3 2.3 0 012.3 2.3v1.5M3 5.5m-.01 0a1.2 1.2 0 102.4 0 1.2 1.2 0 10-2.4 0M9.5 9.3l-1.6 1.6M9.5 9.3l1.6 1.6M12.6 12.5a1.3 1.3 0 11-2.6 0 1.3 1.3 0 012.6 0z",
  play: "M5.2 3.4v9.2a.5.5 0 00.8.4l7-4.6a.5.5 0 000-.8L6 3a.5.5 0 00-.8.4z",
  layers: "M8 2.3l5.7 3.2L8 8.7 2.3 5.5zM2.3 8.3L8 11.5l5.7-3.2M2.3 10.8L8 14l5.7-3.2",
  components: "M8 2.2l2.6 2.6L8 7.4 5.4 4.8zM8 8.6l2.6 2.6L8 13.8l-2.6-2.6zM3.4 6.7L6 9.3 3.4 11.9.8 9.3zM12.6 6.7l2.6 2.6-2.6 2.6-2.6-2.6z",
  flow: "M3.6 6.2a1.9 1.9 0 100-3.8 1.9 1.9 0 000 3.8zM12.4 13.6a1.9 1.9 0 100-3.8 1.9 1.9 0 000 3.8zM5.5 4.3h2.8a2.2 2.2 0 012.2 2.2v3.4",
  page: "M4 2h5l3 3v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1zM9 2v3h3",
  chevronDown: "M4.2 6.2L8 10l3.8-3.8",
  chevronRight: "M6.2 4.2L10 8l-3.8 3.8",
  chevronUp: "M4.2 9.8L8 6l3.8 3.8",
  eye: "M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8zM8 9.8a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6z",
  eyeOff: "M2.6 2.6l10.8 10.8M6.6 4a6 6 0 011.4-.4C12 3.6 14.4 8 14.4 8a11 11 0 01-2 2.6M9.7 9.8A1.8 1.8 0 016.2 8M4.2 5.4A11 11 0 001.6 8S4 12.4 8 12.4a6 6 0 002.2-.4",
  lock: "M4.5 7h7a1 1 0 011 1v4.2a1 1 0 01-1 1h-7a1 1 0 01-1-1V8a1 1 0 011-1zM5.6 7V5.2a2.4 2.4 0 014.8 0V7",
  plus: "M8 3.2v9.6M3.2 8h9.6",
  minus: "M3.2 8h9.6",
  x: "M4 4l8 8M12 4l-8 8",
  check: "M3.4 8.4l3 3 6.2-6.8",
  trash: "M2.8 4.4h10.4M6.2 4.4V3a1 1 0 011-1h1.6a1 1 0 011 1v1.4M4.2 4.4l.6 8.4a1 1 0 001 .9h4.4a1 1 0 001-.9l.6-8.4",
  copy: "M5.6 5.6h6.8a1 1 0 011 1v6.8a1 1 0 01-1 1H5.6a1 1 0 01-1-1V6.6a1 1 0 011-1zM10.4 5.6V3.6a1 1 0 00-1-1H3.6a1 1 0 00-1 1v5.8a1 1 0 001 1h1",
  share: "M10.4 5.2L5.6 7.6m4.8 3.2L5.6 8.4M12 5.4a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6zM4 9.8a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6zM12 14.2a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6z",
  download: "M8 2.4v8M4.8 7.4L8 10.6l3.2-3.2M2.8 13.2h10.4",
  code: "M5.4 4.6L2 8l3.4 3.4M10.6 4.6L14 8l-3.4 3.4M9.2 3L6.8 13",
  more: "M3.4 8.4a.5.5 0 100-.01M8 8.4a.5.5 0 100-.01M12.6 8.4a.5.5 0 100-.01",
  search: "M7 11.6a4.6 4.6 0 100-9.2 4.6 4.6 0 000 9.2zM10.4 10.4l3.2 3.2",
  undo: "M5.4 3.6L2.6 6.4l2.8 2.8M2.8 6.4h6.4a3.6 3.6 0 010 7.2H6.4",
  redo: "M10.6 3.6l2.8 2.8-2.8 2.8M13.2 6.4H6.8a3.6 3.6 0 000 7.2h2.8",
  sun: "M8 10.6a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2zM8 1.6v1.4M8 13v1.4M1.6 8H3M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1",
  moon: "M13.4 9.4A5.8 5.8 0 016.6 2.6a5.8 5.8 0 106.8 6.8z",
  bolt: "M9 1.8L3.6 9h3.7l-.6 5.2L12.4 7H8.7z",
  cpu: "M5 5h6a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1zM6.4 1.8v1.6M9.6 1.8v1.6M6.4 12.6v1.6M9.6 12.6v1.6M1.8 6.4h1.6M1.8 9.6h1.6M12.6 6.4h1.6M12.6 9.6h1.6",
  warning: "M8 2.4l6 10.6H2zM8 6.6v3M8 11.4a.3.3 0 100-.01",
  info: "M8 14a6 6 0 100-12 6 6 0 000 12zM8 7.2v3.6M8 5.2a.3.3 0 100-.01",
  flag: "M3.6 14V2.4M3.6 3h7.2l-1.4 2.6 1.4 2.6H3.6",
  link: "M6.8 9.2a3 3 0 004.2 0l2-2a3 3 0 00-4.2-4.2l-.8.8M9.2 6.8a3 3 0 00-4.2 0l-2 2a3 3 0 004.2 4.2l.8-.8",
  route: "M4 13.2a1.6 1.6 0 100-3.2 1.6 1.6 0 000 3.2zM12 6a1.6 1.6 0 100-3.2A1.6 1.6 0 0012 6zM5.6 11.6h4a2.4 2.4 0 000-4.8H6.4a2.4 2.4 0 010-4.8H10",
  grid: "M2.6 2.6h4v4h-4zM9.4 2.6h4v4h-4zM2.6 9.4h4v4h-4zM9.4 9.4h4v4h-4z",
  rotate: "M13.4 8a5.4 5.4 0 11-1.6-3.8M13.4 2.6v3h-3",
  panelLeft: "M3 2.6h10a1 1 0 011 1v8.8a1 1 0 01-1 1H3a1 1 0 01-1-1V3.6a1 1 0 011-1zM6 2.6v10.8",
  panelRight: "M3 2.6h10a1 1 0 011 1v8.8a1 1 0 01-1 1H3a1 1 0 01-1-1V3.6a1 1 0 011-1zM10 2.6v10.8",
  user: "M8 8.2a2.8 2.8 0 100-5.6 2.8 2.8 0 000 5.6zM2.8 14c.4-2.4 2.5-3.8 5.2-3.8s4.8 1.4 5.2 3.8",
  sparkle: "M8 2l1.3 3.7L13 7l-3.7 1.3L8 12 6.7 8.3 3 7l3.7-1.3zM12.6 11.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z",
};

export type IconName = keyof typeof P;

export function Icon({
  name, size = 16, className, ...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
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

export const ICON_NAMES = Object.keys(P) as IconName[];
