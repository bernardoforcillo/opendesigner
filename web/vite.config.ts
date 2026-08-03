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
    // I 5s di default di vitest sono sotto il costo REALE dei test di
    // componente, e producevano falsi rossi INTERMITTENTI: file verdi in
    // isolamento che, girando insieme agli altri con i worker in parallelo,
    // sforavano il limite su un test a caso (TextEditorOverlay e LayersPanel su
    // tutti). Un rosso che cambia test a ogni esecuzione costa un giro di
    // indagine a chiunque, su ogni traccia, e non dice niente su nessuna.
    //
    // Il tetto è alzato, non tolto, e non copre nessuna ATTESA: i test lenti
    // sono lenti perché FANNO tanto, e tutto in modo sincrono. Nessuno ha un
    // waitFor, un timer finto o un'attesa di rete: se sforassero questo limite
    // sarebbe un blocco vero, e la suite deve fallire. 30s ≈ 3x il peggiore
    // misurato SOTTO CARICO su questa macchina (11,6s), margine SUPERIORE
    // perché quel numero è wall time con hook inclusi. `hookTimeout` resta al
    // default: i beforeEach installano una scena e basta.
    testTimeout: 30_000,
  },
});
