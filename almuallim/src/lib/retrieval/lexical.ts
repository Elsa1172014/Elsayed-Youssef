import { normalizeArabic, tokenize } from "@/lib/arabic/normalize";

// Very common function words that add noise to an OR-style lexical query (already normalised forms).
const STOPWORDS = new Set([
  "في", "من", "علي", "الي", "عن", "ان", "ما", "ماذا", "هل", "هو", "هي", "هذا", "هذه", "ذلك", "تلك", "التي", "الذي",
  "كان", "كانت", "او", "ثم", "قد", "لا", "لم", "لن", "مع", "كل", "بعض", "يا", "اي", "كيف", "لماذا", "متي", "اين",
  "اريد", "اشرح", "لي", "لنا", "انا", "نحن", "هناك", "بين", "عند", "حول",
]);

// Longest first so "وال" wins over "و".
const PREFIXES = ["وال", "بال", "كال", "فال", "لل", "ال", "و", "ب", "ل", "ف"];

/**
 * Light, deterministic query expansion. The index has no stemmer, so "فاعل" would not find "الفاعل".
 * We add prefix-stripped and "ال"-prefixed variants of each content token; the SQL side ORs them.
 */
export function expandQueryTokens(query: string): string[] {
  const out = new Set<string>();
  for (const t of tokenize(normalizeArabic(query))) {
    if (STOPWORDS.has(t) || t.length < 2) continue;
    out.add(t);
    for (const p of PREFIXES) {
      if (t.startsWith(p) && t.length - p.length >= 3) out.add(t.slice(p.length));
    }
    if (!t.startsWith("ال") && /[ء-ي]/.test(t)) out.add("ال" + t);
  }
  return [...out];
}

export const lexicalQueryText = (query: string): string => expandQueryTokens(query).join(" ");
