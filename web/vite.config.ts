import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/brawt.v1.DocumentService": { target: "http://localhost:8080", changeOrigin: true },
      "/assets-api": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
  test: {
    // I pannelli (M1b) sono componenti React: servono DOM + matcher jest-dom.
    // I test finora sono su funzioni pure e girano invariati sotto jsdom.
    environment: "jsdom",
    setupFiles: ["@testing-library/jest-dom/vitest"],
  },
});
