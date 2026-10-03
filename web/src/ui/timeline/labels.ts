// Le etichette italiane degli insiemi chiusi del modello di animazione.

export const TRIGGER_LABELS: Record<string, string> = {
  enter: "Ingresso",
  hover: "Hover",
  tap: "Tocco",
  loop: "Loop",
  manual: "Manuale",
};

export const TRIGGER_HINTS: Record<string, string> = {
  enter: "Parte quando la schermata compare",
  hover: "Parte quando il puntatore entra nel bersaglio",
  tap: "Parte alla pressione sul bersaglio",
  loop: "Come l'ingresso, ma non finisce mai",
  manual: "La fa partire il codice",
};

export const EASING_LABELS: Record<string, string> = {
  linear: "Lineare",
  easeIn: "Ease in",
  easeOut: "Ease out",
  easeInOut: "Ease in-out",
  spring: "Molla",
  custom: "Curva…",
};
