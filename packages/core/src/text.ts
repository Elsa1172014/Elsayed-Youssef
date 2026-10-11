const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** Normalizes Arabic/Latin text for matching: strips diacritics/tatweel, unifies letter variants, lowercases. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokenize(input: string): string[] {
  const n = normalizeText(input);
  return n ? n.split(/\s+/) : [];
}

/** Small Arabic -> Latin map so "الجزيرة" finds "Al Jazeera" and vice versa. */
const TRANSLIT: Record<string, string[]> = {
  الجزيره: ["al", "jazeera"],
  العربيه: ["al", "arabiya"],
  سكاي: ["sky"],
  نيوز: ["news"],
  اخبار: ["news"],
  رياضه: ["sports", "sport"],
  اطفال: ["kids"],
  افلام: ["movies"],
  وثائقي: ["documentary"],
  موسيقى: ["music"],
};

export function expandTokens(tokens: string[]): string[] {
  const out = new Set(tokens);
  for (const t of tokens) for (const x of TRANSLIT[t] ?? []) out.add(x);
  for (const [ar, lat] of Object.entries(TRANSLIT)) if (lat.every((l) => tokens.includes(l))) out.add(ar);
  return [...out];
}

/** Dice coefficient over character bigrams, in [0,1]. */
export function similarity(a: string, b: string): number {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let overlap = 0;
  for (const [g, c] of gx) overlap += Math.min(c, gy.get(g) ?? 0);
  const total = Math.max(x.length - 1, 0) + Math.max(y.length - 1, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}
