// DEVICE FRAMES for Present. Purely presentational: the prototype plays on the frame's own size, and
// a device frame draws a bezel (and the few details that make it read as a phone, a tablet or a
// browser window) AROUND it. Pure geometry: the frame's box in, the boxes of the parts out, so the
// view only places divs and the numbers can be tested without a DOM.

export type DeviceId = "generic" | "phone" | "tablet" | "desktop" | "none";

export interface DeviceSpec {
  id: DeviceId;
  label: string;
  /** Border (px) around the screen on the left, right and bottom. */
  bezel: number;
  /** Extra space above the screen: the top bezel of a phone, the title bar of a browser window. */
  top: number;
  /** Corner radius of the device body. */
  radius: number;
  /** Corner radius of the screen itself (the body's, minus the bezel). */
  screenRadius: number;
}

export const DEVICES: readonly DeviceSpec[] = [
  { id: "generic", label: "Generic", bezel: 8, top: 8, radius: 22, screenRadius: 14 },
  { id: "phone", label: "Phone", bezel: 12, top: 12, radius: 46, screenRadius: 34 },
  { id: "tablet", label: "Tablet", bezel: 20, top: 20, radius: 30, screenRadius: 10 },
  { id: "desktop", label: "Desktop", bezel: 0, top: 36, radius: 10, screenRadius: 0 },
  { id: "none", label: "No frame", bezel: 0, top: 0, radius: 0, screenRadius: 0 },
];

export function deviceById(id: string | null | undefined): DeviceSpec {
  return DEVICES.find((d) => d.id === id) ?? DEVICES[0];
}

export interface Box { left: number; top: number; width: number; height: number }

/** A detail drawn on the device: where, how big, and what it is. */
export interface DevicePart extends Box {
  kind: "island" | "homebar" | "camera" | "titlebar" | "dot" | "address";
  radius: number;
  /** For the three window buttons of a desktop frame: which. */
  index?: number;
}

export interface DeviceGeometry {
  /** The device body, around the screen. null for "No frame". */
  body: (Box & { radius: number }) | null;
  /** Corner radius the screen is clipped with. */
  screenRadius: number;
  parts: DevicePart[];
}

/**
 * The geometry of a device around the screen `s` (px, in the stage). Parts are in the same
 * coordinates. The island and the home bar of a phone sit INSIDE the screen's box (they overlay the
 * prototype, like the real ones); a tablet's camera sits in the bezel; a desktop's title bar sits above.
 */
export function deviceGeometry(spec: DeviceSpec, s: Box): DeviceGeometry {
  if (spec.id === "none") return { body: null, screenRadius: 0, parts: [] };
  const body = {
    left: s.left - spec.bezel,
    top: s.top - spec.top,
    width: s.width + spec.bezel * 2,
    height: s.height + spec.top + spec.bezel,
    radius: spec.radius,
  };
  const parts: DevicePart[] = [];
  switch (spec.id) {
    case "phone": {
      const w = Math.round(Math.min(120, Math.max(60, s.width * 0.3)));
      parts.push({ kind: "island", left: s.left + (s.width - w) / 2, top: s.top + 10, width: w, height: 24, radius: 12 });
      parts.push({ kind: "homebar", left: s.left + (s.width - 120) / 2, top: s.top + s.height - 12, width: 120, height: 4, radius: 2 });
      break;
    }
    case "tablet":
      parts.push({ kind: "camera", left: s.left + s.width / 2 - 3, top: s.top - spec.top / 2 - 3, width: 6, height: 6, radius: 3 });
      break;
    case "desktop": {
      const y = s.top - spec.top;
      parts.push({ kind: "titlebar", left: s.left, top: y, width: s.width, height: spec.top, radius: 0 });
      for (let i = 0; i < 3; i++) parts.push({ kind: "dot", index: i, left: s.left + 14 + i * 18, top: y + spec.top / 2 - 5, width: 10, height: 10, radius: 5 });
      const aw = Math.max(0, Math.min(360, s.width - 140));
      if (aw >= 80) parts.push({ kind: "address", left: s.left + (s.width - aw) / 2, top: y + 8, width: aw, height: spec.top - 16, radius: (spec.top - 16) / 2 });
      break;
    }
  }
  return { body, screenRadius: spec.screenRadius, parts };
}
