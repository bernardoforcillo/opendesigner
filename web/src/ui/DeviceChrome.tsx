import { deviceGeometry, type Box, type DeviceSpec } from "@/flow/devices";

// The device frame of Present, BEHIND the screen's canvas: the body, and the details that tell a
// phone, a tablet or a browser window apart (see flow/devices.ts). The island and the home bar of a
// phone sit over the screen, so they are drawn by `DeviceOverlay`, above the canvas.

const BODY_COLOR: Record<string, string> = {
  generic: "var(--surface)",
  phone: "#0d0d10",
  tablet: "#16161a",
  desktop: "#1d1e22",
};

export function DeviceBody({ spec, screen, label }: { spec: DeviceSpec; screen: Box; label: string }) {
  const g = deviceGeometry(spec, screen);
  if (!g.body) return null;
  return (
    <div data-device={spec.id} aria-hidden="true">
      <div
        className="absolute shadow-[0_40px_90px_-30px_rgba(0,0,0,0.85),0_0_0_1px_var(--line-strong)]"
        style={{ ...px(g.body), borderRadius: g.body.radius, background: BODY_COLOR[spec.id] }}
      />
      {g.parts.filter((p) => p.kind === "camera" || p.kind === "titlebar" || p.kind === "dot" || p.kind === "address").map((p, i) => (
        <div
          key={`${p.kind}-${i}`}
          className="absolute"
          style={{
            ...px(p), borderRadius: p.radius,
            background: p.kind === "dot" ? ["#ff5f57", "#febc2e", "#28c840"][p.index ?? 0] : p.kind === "address" ? "rgba(255,255,255,0.09)" : p.kind === "camera" ? "#2b2c33" : "transparent",
          }}
        >
          {p.kind === "address" && (
            <span className="block truncate px-3 text-center font-mono text-[11px] leading-[20px] text-white/60">{label}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** The parts that overlay the screen (a phone's island and home bar): above the canvas, never clickable. */
export function DeviceOverlay({ spec, screen }: { spec: DeviceSpec; screen: Box }) {
  const g = deviceGeometry(spec, screen);
  return (
    <div aria-hidden="true" className="pointer-events-none">
      {g.parts.filter((p) => p.kind === "island" || p.kind === "homebar").map((p) => (
        <div
          key={p.kind}
          className="absolute"
          style={{ ...px(p), borderRadius: p.radius, background: p.kind === "island" ? "#0d0d10" : "rgba(255,255,255,0.55)", mixBlendMode: p.kind === "homebar" ? "difference" : undefined }}
        />
      ))}
    </div>
  );
}

const px = (b: Box) => ({ left: b.left, top: b.top, width: b.width, height: b.height });
