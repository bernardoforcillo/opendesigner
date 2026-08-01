import type { SceneState } from "./types";

// Deriva la prossima order key dai nodi già presenti nella scena, invece che da un
// contatore di modulo (bug M0: il contatore ripartiva da 0 dopo il reload e
// riemetteva "a000000" su un documento che ne aveva già uno, rendendo instabile
// l'ordine di disegno). Confronto lessicografico sulla chiave massima esistente,
// poi incremento numerico mantenendo lo stesso formato zero-padded.
export function nextOrderKey(scene: SceneState | null): string {
  const keys = scene ? Object.values(scene.nodes).map((n) => n.orderKey) : [];
  if (keys.length === 0) return "a000000";

  const maxKey = keys.reduce((a, b) => (b > a ? b : a));
  const parsed = parseInt(maxKey.slice(1), 10);
  const next = Number.isFinite(parsed) ? parsed + 1 : 0;
  return "a" + String(next).padStart(6, "0");
}
