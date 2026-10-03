import type { SceneState } from "./types";

// Indice frazionario per l'ordine di disegno / l'ordine del pannello livelli.
//
// Le order key sono confrontate SEMPRE lessicograficamente (è così che i nodi
// vengono ordinati ovunque, dal renderer al pannello). Il formato M0/M1a
// ("a" + 6 cifre) ordinava correttamente ma non permetteva di inserire nulla
// fra due vicini: fra "a000001" e "a000002" non esiste alcuna stringa. Qui una
// chiave è invece una FRAZIONE in base 36 sull'alfabeto ordinato 0-9a-z:
// "a000001" vale 0.a000001₃₆. L'ordine lessicografico coincide con l'ordine dei
// valori (le cifre mancanti valgono 0, e a parità di valore vince la stringa più
// corta), quindi le chiavi già persistite restano valide e continuano a
// ordinarsi correttamente accanto a quelle nuove.
//
// Invariante: nessuna chiave generata termina con il digit più basso ("0").
// Se una chiave terminasse con "0" nessuna chiave potrebbe più essere inserita
// subito prima di essa — fra "x" e "x0" non esiste alcuna stringa. Le chiavi
// legacy che finiscono con "0" (es. "a000000") restano accettate in INPUT: le
// leggiamo, semplicemente non ne emettiamo di nuove fatte così.

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const MAX_DIGIT = BASE - 1;

// Prima chiave di un documento vuoto: formato M0/M1a, così i documenti già
// salvati e quelli nuovi condividono lo stesso punto di partenza.
const FIRST_KEY = "a000000";

function toDigits(key: string, label: string): number[] {
  const out: number[] = [];
  for (const ch of key) {
    const d = DIGITS.indexOf(ch);
    if (d < 0) throw new Error(`orderKeyBetween: ${label} order key "${key}" has an invalid digit "${ch}"`);
    out.push(d);
  }
  return out;
}

function toKey(digits: number[]): string {
  return digits.map((d) => DIGITS[d]).join("");
}

// Chiave immediatamente successiva a `digits` (estremo superiore aperto).
// Incrementa la cifra non massima più a destra e scarta la coda: la coda era
// fatta di sole cifre massime, quindi il valore cresce ed il risultato non può
// terminare con "0" (una cifra incrementata vale almeno 1). Se sono tutte cifre
// massime allunghiamo la stringa: "zzz" < "zzzi" sia come valore sia come
// stringa, perché il valore 1.0 è un estremo che non si raggiunge mai.
function keyAfterDigits(digits: number[]): number[] {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] < MAX_DIGIT) {
      const out = [...digits.slice(0, i), digits[i] + 1];
      // Il riporto ha accorciato la chiave: la riportiamo alla larghezza di
      // partenza con zeri chiusi da "1" (resta > della chiave incrementata e
      // < della cifra successiva, e non finisce con "0"). Senza questo ogni
      // riporto perderebbe un digit e dopo poche centinaia di append la chiave
      // si ridurrebbe a "z" costringendo ad allungarla di continuo; così invece
      // "a00000z" → "a000011" e la larghezza resta stabile.
      if (out.length < digits.length) {
        while (out.length < digits.length - 1) out.push(0);
        out.push(1);
      }
      return out;
    }
  }
  return [...digits, Math.floor(BASE / 2)];
}

// Valore strettamente compreso fra `a` e `b` (cifre mancanti = 0), senza "0"
// finale. Richiede valore(a) < valore(b).
function midpointDigits(a: number[], b: number[]): number[] {
  const prefix: number[] = [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const da = a[i] ?? 0;
    const db = b[i] ?? 0;
    if (da === db) {
      prefix.push(da);
      continue;
    }
    // Primo digit diverso: essendo i prefissi uguali e valore(a) < valore(b),
    // qui vale da < db.
    if (db - da >= 2) {
      // C'è spazio per una cifra in mezzo: chiave della stessa lunghezza.
      return [...prefix, Math.floor((da + db) / 2)];
    }
    // Cifre consecutive: scendiamo nel ramo di `a` (qualunque cosa segua
    // resta sotto a `b`) e cerchiamo il successore della sua coda.
    return [...prefix, da, ...keyAfterDigits(a.slice(i + 1))];
  }
  // Stesse cifre fino in fondo ⇒ stesso valore: fra le due non esiste
  // letteralmente alcuna stringa (è il caso "x" / "x0").
  throw new Error(`orderKeyBetween: no key exists between "${toKey(a)}" and "${toKey(b)}"`);
}

/**
 * Restituisce una order key strettamente compresa fra `a` e `b` in ordine
 * lessicografico. `null` indica un estremo aperto: `orderKeyBetween(null, k)`
 * ordina prima di tutto, `orderKeyBetween(k, null)` dopo tutto.
 * Lancia se `a >= b`, invece di emettere una chiave che romperebbe l'ordine.
 */
export function orderKeyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`orderKeyBetween: invalid range "${a}" >= "${b}"`);
  }
  if (a === null && b === null) return FIRST_KEY;
  if (b === null) return toKey(keyAfterDigits(toDigits(a as string, "lower")));
  const hi = toDigits(b, "upper");
  if (a === null) return toKey(midpointDigits([], hi));
  return toKey(midpointDigits(toDigits(a, "lower"), hi));
}

// Deriva la prossima order key dai nodi già presenti nella scena, invece che da
// un contatore di modulo (bug M0: il contatore ripartiva da 0 dopo il reload e
// riemetteva "a000000" su un documento che ne aveva già uno, rendendo instabile
// l'ordine di disegno). Confronto lessicografico sulla chiave massima esistente,
// poi la chiave successiva dell'indice frazionario.
export function nextOrderKey(scene: SceneState | null): string {
  const keys = scene ? [...scene.nodes.values()].map((n) => n.orderKey) : [];
  if (keys.length === 0) return orderKeyBetween(null, null);

  const maxKey = keys.reduce((a, b) => (b > a ? b : a));
  return orderKeyBetween(maxKey, null);
}
