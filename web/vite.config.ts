import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/opendesigner.v1.DocumentService": { target: "http://localhost:8080", changeOrigin: true },
      "/assets-api": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
  test: {
    // The panels (M1b) are React components: they need DOM + jest-dom matchers.
    // The tests so far are on pure functions and run unchanged under jsdom.
    environment: "jsdom",
    setupFiles: ["@testing-library/jest-dom/vitest"],
    // Vitest's default 5s is below the REAL cost of the component tests, and
    // produced INTERMITTENT false reds: files green in isolation that, running
    // together with the others with the workers in parallel, exceeded the limit on a
    // random test (TextEditorOverlay and LayersPanel above all). A red that changes
    // test on every run costs anyone an investigation round, on every trace, and says
    // nothing about any of them.
    //
    // They are slow because they DO a lot, all of it synchronously. The worst --
    // "reordering REPEATEDLY in the same spot keeps working"
    // (LayersPanel) -- is 20 real drag&drop reorders, each with its full
    // round of react-aria renders under jsdom; the second -- "when a node is being
    // edited the field exists and is ALIVE" (TextEditorOverlay) -- is a
    // userEvent.type inside a fully mounted <App />, which re-renders the whole
    // app on every keystroke. Neither has a waitFor, a fake timer or
    // a network wait: if they exceeded this limit it would be a real hang, and
    // the suite must fail.
    //
    // 30s ≈ 3x the worst measured UNDER LOAD on this machine (9.5s;
    // 11.6s in a previous run). Those numbers are the wall time the
    // reporter attributes to the test, hooks included, so an UPPER limit on
    // what testTimeout really governs (the body alone) -- which makes the
    // margin wider than 3x, not narrower. Enough for the scheduling noise between
    // workers, little enough that a wait that never resolves stays an error instead of
    // hanging CI. `hookTimeout` stays at its
    // default: these files' beforeEach hooks just install a scene,
    // none has ever exceeded it.
    testTimeout: 30_000,
  },
});
