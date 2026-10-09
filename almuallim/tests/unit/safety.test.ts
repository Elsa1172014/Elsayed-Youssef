import { describe, expect, it } from "vitest";
import { detectConcern, SUPPORT_NOTE } from "@/lib/safety/concerns";

describe("detectConcern", () => {
  it.each([
    ["أريد أن أموت", "self_harm"], ["أريد أَنْ أَمُوتَ", "self_harm"], ["أنا أفكر أن أنتحر", "self_harm"], ["I want to kill myself", "self_harm"],
    ["أبي يضربني كل يوم", "abuse"], ["he is touching me and I don't like it", "abuse"], ["someone is hitting me", "abuse"],
    ["الأولاد يتنمرون علي في الفصل", "bullying"], ["أنا في خطر", "danger"],
  ] as const)("%s → %s", (text, cat) => {
    expect(detectConcern(text)).toBe(cat); // diacritised input is normalised before matching
  });

  it("does not flag ordinary lesson talk (poems, war, weapons, 'killing time')", () => {
    for (const t of ["اشرح لي بيت الشعر: السيف أصدق أنباءً من الكتب", "ما إعراب كلمة سلاح في الجملة؟", "قُتل الجندي في المعركة، ما الفاعل؟", "I'm killing time before class", "ما هو الفاعل؟"]) {
      expect(detectConcern(t)).toBeNull();
    }
  });
  it("the support note asks for warmth, a trusted adult, and no therapy or promises of secrecy", () => {
    expect(SUPPORT_NOTE).toContain("شخص بالغ موثوق");
    expect(SUPPORT_NOTE).toContain("ولا تَعِد بالسرية");
  });
});
