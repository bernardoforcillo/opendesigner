// HYPHENATION. Where a word may break across two lines. This is a syllable heuristic for the Latin
// alphabet (English, Italian, Spanish, French, German, ...), not a dictionary of patterns: it finds the
// breaks that follow the common vowel / consonant structure and is deliberately conservative (never fewer
// than two letters before the hyphen or three after it, nothing in words with digits or punctuation).

const VOWELS = new Set("aeiouyàáâäãåèéêëìíîïòóôöõùúûüœæ");
// Consonant pairs that stay together (a mute followed by a liquid, and digraphs).
const CLUSTERS = new Set(["bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "gr", "pl", "pr", "tr", "ch", "gh", "sh", "th", "ph", "wh", "sc", "gn", "qu"]);

const isLetter = (c: string) => /\p{L}/u.test(c);
const isVowel = (c: string) => VOWELS.has(c.toLowerCase());

/** The indices i (0 < i < length) where `word` may be split into word[0..i] + "-" and word[i..]. */
export function hyphenPoints(word: string): number[] {
  const w = Array.from(word);
  if (w.length < 5 || !w.every(isLetter)) return [];
  const points: number[] = [];
  const v = w.map(isVowel);
  for (let i = 2; i <= w.length - 3; i++) {
    // V | C V: a consonant between two vowels goes with the second.
    if (v[i - 1] && !v[i] && v[i + 1]) { points.push(i); continue; }
    // C | C: between two consonants -- always when they are the same letter, otherwise unless they form a
    // cluster that stays together -- as long as there is a vowel on each side.
    if (!v[i - 1] && !v[i] && v.slice(0, i).some(Boolean) && v.slice(i).some(Boolean)) {
      const same = w[i - 1].toLowerCase() === w[i].toLowerCase();
      if (same || !CLUSTERS.has((w[i - 1] + w[i]).toLowerCase())) points.push(i);
    }
  }
  return points;
}
