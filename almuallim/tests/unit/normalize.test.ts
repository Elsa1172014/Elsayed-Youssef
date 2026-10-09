import { describe, expect, it } from "vitest";
import { arabicRatio, looksVisuallyReversed, normalizeArabic, reverseVisualLines, tokenize } from "@/lib/arabic/normalize";

describe("normalizeArabic", () => {
  it("strips tashkeel and tatweel", () => {
    expect(normalizeArabic("كَتَبَ الطَّالِبُ الدَّرْسَ")).toBe("كتب الطالب الدرس");
    expect(normalizeArabic("العــــربية")).toBe(normalizeArabic("العربية"));
  });
  it("unifies alef, ya and ta marbuta variants", () => {
    expect(normalizeArabic("أحمد إبراهيم آمن")).toBe("احمد ابراهيم امن");
    expect(normalizeArabic("مدرسة")).toBe(normalizeArabic("مدرسه"));
    expect(normalizeArabic("على")).toBe(normalizeArabic("علي"));
  });
  it("folds presentation forms and lam-alef ligatures (typical PDF extraction output)", () => {
    expect(normalizeArabic("ﺍﻟﻔﺎﻋﻞ")).toBe("الفاعل");
    expect(normalizeArabic("ﻷﻥ")).toBe("لان");
    expect(normalizeArabic("ﻻ")).toBe("لا");
  });
  it("maps Arabic-Indic and Persian digits and removes punctuation", () => {
    expect(normalizeArabic("الصفحة ١٢٣؟")).toBe("الصفحه 123");
    expect(normalizeArabic("«الفاعل»، المفعول.")).toBe("الفاعل المفعول");
  });
  it("is idempotent", () => {
    const once = normalizeArabic("الدَّرسُ الأوَّلُ: الفاعِلُ ١");
    expect(normalizeArabic(once)).toBe(once);
  });
  it("removes bidi control characters", () => {
    expect(normalizeArabic("‫الفاعل‬")).toBe("الفاعل");
  });
  it("tokenizes", () => {
    expect(tokenize(normalizeArabic("الفاعل  اسم مرفوع"))).toEqual(["الفاعل", "اسم", "مرفوع"]);
  });
});

describe("visual-order detection", () => {
  const logical = "ذهب الطالب الى المدرسة في الصباح وكان معه كتاب من المكتبة وهذا ما قد حدث";
  it("does not flag normal text", () => {
    expect(looksVisuallyReversed(logical)).toBe(false);
  });
  it("flags reversed text and can repair it", () => {
    const reversed = reverseVisualLines(logical);
    expect(looksVisuallyReversed(reversed)).toBe(true);
    expect(looksVisuallyReversed(reverseVisualLines(reversed))).toBe(false);
  });
});

describe("arabicRatio", () => {
  it("measures the Arabic share of letters", () => {
    expect(arabicRatio("الفاعل")).toBe(1);
    expect(arabicRatio("abc")).toBe(0);
    expect(arabicRatio("ابabcd")).toBeCloseTo(2 / 6);
  });
});
