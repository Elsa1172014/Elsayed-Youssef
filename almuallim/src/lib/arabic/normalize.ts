/**
 * Deterministic Arabic text normalisation shared by indexing and querying.
 * The SAME function must be used on both sides, otherwise lexical retrieval silently degrades.
 *
 * Lossy by design (for matching only) — the original text is always stored and displayed separately.
 */

// Tashkeel, Quranic marks, superscript alef, tatweel
const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ]/g;
// Bidi controls, zero-width characters, BOM, soft hyphen
const INVISIBLES = /[​-‏‪-‮⁦-⁩﻿­]/g;
const PUNCT = /[،؛؟٪-٭۔«»"'`´‘’“”„‹›()\[\]{}<>.,:;!?\-–—_…•·|/\\*+=~^%$#@&]/g;

const DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

/** NUL and other C0 control characters (PostgreSQL rejects \u0000 in text columns; PDFs emit them). */
export function stripControlChars(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF\uFFFD]/g, "");
}

export function stripInvisibles(s: string): string {
  return s.replace(INVISIBLES, "");
}

export function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d] ?? d);
}

export function normalizeArabic(input: string): string {
  return (
    // NFKC folds Arabic presentation forms (U+FB50–FDFF, U+FE70–FEFF) that PDF text layers
    // frequently emit back to base letters, and splits lam-alef ligatures into two letters.
    stripInvisibles(input.normalize("NFKC"))
      .replace(DIACRITICS, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/[ڤ]/g, "ف")
      .replace(/[گ]/g, "ك")
      .replace(/ک/g, "ك")
      .replace(/ی/g, "ي")
      .replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d] ?? d)
      .replace(PUNCT, " ")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function tokenize(normalized: string): string[] {
  return normalized.split(" ").filter(Boolean);
}

/** Rough token estimate for budgeting (Arabic averages ~2.2 chars/token on modern tokenizers). */
export function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 2.2));
}

const COMMON_WORDS = ["في", "من", "علي", "الي", "ان", "عن", "هذا", "التي", "الذي", "كان", "او", "ما", "قد", "مع", "لا"];
const COMMON_SET = new Set(COMMON_WORDS);
const REVERSED_SET = new Set(COMMON_WORDS.map((w) => [...w].reverse().join("")).filter((w) => !COMMON_SET.has(w)));

/**
 * Some Arabic PDFs store glyphs in visual (left-to-right) order, so extracted text comes out reversed
 * ("ني" instead of "في"). Detect by counting very common words and their reversals.
 */
export function looksVisuallyReversed(text: string): boolean {
  const toks = tokenize(normalizeArabic(text));
  let fwd = 0;
  let rev = 0;
  for (const t of toks) {
    if (COMMON_SET.has(t)) fwd++;
    else if (REVERSED_SET.has(t)) rev++;
  }
  return rev >= 3 && rev > fwd * 2;
}

/** Reverse each line's characters (used only when {@link looksVisuallyReversed} is true). */
export function reverseVisualLines(text: string): string {
  return text
    .split("\n")
    .map((l) => [...l].reverse().join(""))
    .join("\n");
}

export function containsArabic(s: string): boolean {
  return /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(s);
}

/** Share of letters in `s` that are Arabic (0..1). Used to judge extraction quality. */
export function arabicRatio(s: string): number {
  const letters = s.normalize("NFKC").match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  const ar = letters.filter((c) => containsArabic(c)).length;
  return ar / letters.length;
}
