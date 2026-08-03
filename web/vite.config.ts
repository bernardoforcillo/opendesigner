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
    // isolamento che, girando insieme agli altri 29 con i worker in parallelo,
    // sforavano il limite su un test a caso (TextEditorOverlay e LayersPanel su
    // tutti). Un rosso che cambia test a ogni esecuzione costa un giro di
    // indagine a chiunque, su ogni traccia, e non dice niente su nessuna.
    //
    // Il tetto è alzato, non tolto, e non copre nessuna ATTESA: i test lenti
    // sono lenti perché FANNO tanto, e tutto in modo sincrono. Il peggiore --
    // "riordinare RIPETUTAMENTE nello stesso punto continua a funzionare"
    // (LayersPanel) -- è 20 riordini drag&drop veri, ognuno con il suo giro
    // completo di render di react-aria sotto jsdom; il secondo -- "quando c'è
    // un nodo in editing il campo esiste ed è VIVO" (TextEditorOverlay) -- è un
    // userEvent.type dentro <App /> montata intera, che rirenderizza tutta
    // l'app a ogni tasto. Nessuno dei due ha un waitFor, un timer finto o
    // un'attesa di rete: se sforassero questo limite sarebbe un blocco vero, e
    // la suite deve fallire.
    //
    // 30s ≈ 3x il peggiore misurato SOTTO CARICO su questa macchina (9,5s;
    // 11,6s in un'esecuzione precedente). Quei numeri sono il wall time che il
    // reporter attribuisce al test, hook inclusi, quindi un limite SUPERIORE a
    // ciò che testTimeout governa davvero (il solo corpo) -- il che rende il
    // margine più largo di 3x, non più stretto. Abbastanza per il rumore di
    // pianificazione fra worker, abbastanza poco perché un'attesa che non si
    // risolve resti un errore invece di appendere la CI. `hookTimeout` resta al
    // suo default: i beforeEach di questi file installano una scena e basta,
    // nessuno ha mai sforato.
    testTimeout: 30_000,
  },
});
