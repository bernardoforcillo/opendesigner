// The exported app WORKS: it exports the example flow (Login -> Home ->
// Detail) in the `react` target, installs the dependencies, builds with Vite and
// runs the Playwright tests GENERATED from the flows against the real app in Chromium.
//
//   pnpm export-app                       # uses Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH)
//   CHROMIUM_PATH=/usr/bin/chromium pnpm export-app
//
// It needs the network for `npm install` (see /root/.ccr/README.md if it goes through a proxy).
// It writes the project to web/export-parity-out/shop-app (gitignored).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const webDir = process.cwd();
const repoDir = path.resolve(webDir, "..");
const WORK = path.resolve(webDir, "export-parity-out");
const appDir = path.join(WORK, "shop-app");
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

function run(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

// An already installed Chromium (chromium-NNNN) if the one Playwright expects is missing.
function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && fs.existsSync(root)) {
    for (const d of fs.readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const p = path.join(root, d, "chrome-linux", "chrome");
      if (fs.existsSync(p)) return p;
    }
  }
  return "";
}

const bin = path.join(WORK, "opendesigner");
run("go", ["build", "-o", bin, "./cmd/opendesigner"], repoDir);
run("go", ["run", "./scripts/gen-export-samples", "-out", path.join(WORK, "samples")], repoDir);
run(bin, ["export", "-json", path.join(WORK, "samples", "shop.json"), "-target", "react", "-out", appDir], repoDir);
run("npm", ["install", "--no-audit", "--no-fund"], appDir);
run("npm", ["run", "build"], appDir);
run("npx", ["playwright", "test"], appDir, { PW_CHROMIUM_PATH: chromiumPath() });
console.log("App exported: build succeeded and the flow tests passed.");
