/**
 * Conservative, deterministic detector for student messages that may indicate a safeguarding concern.
 * It does NOT decide anything: it flags the session for a teacher/safeguarding lead (category only, never the text)
 * while the tutor itself responds supportively per its prompt. Keyword matching has false negatives — it is a
 * safety net, not a safeguarding system. The school's own child-protection procedures remain authoritative.
 */
export type ConcernCategory = "self_harm" | "abuse" | "bullying" | "danger";

const RULES: { category: ConcernCategory; patterns: RegExp[] }[] = [
  {
    category: "self_harm",
    patterns: [/أريد أن أموت/, /ابغى اموت/, /اريد ان اموت/, /أنتحر|انتحر/, /أؤذي نفسي|اؤذي نفسي|أجرح نفسي|اجرح نفسي/, /لا أريد أن أعيش|لا اريد ان اعيش/, /want to die|kill myself|hurt myself|end my life/i],
  },
  {
    category: "abuse",
    patterns: [/يضربني|يضربونني|ضربني أبي|ضربتني أمي/, /يتحرش بي|تحرش بي|يلمسني/, /يهددني|يهددونني/, /someone (is )?(hitting|touching|abusing) me/i, /(he|she|they) (is|are) (touching|hitting|hurting|abusing) me/i],
  },
  { category: "bullying", patterns: [/يتنمر(ون)? علي|يتنمرون علي|يسخرون مني كل يوم|لا أحد يحبني/, /being bullied|they bully me/i] },
  // Deliberately narrow: lesson content (poems, history, stories) mentions weapons/war; only first-person danger statements flag.
  { category: "danger", patterns: [/أنا في خطر|انا في خطر|أشعر أنني في خطر/, /i am in danger|i('m| am) not safe/i] },
];

const norm = (s: string) => s.normalize("NFKC").replace(/[ً-ٟـ]/g, "");

export function detectConcern(text: string): ConcernCategory | null {
  const t = norm(text);
  for (const r of RULES) if (r.patterns.some((p) => p.test(t))) return r.category;
  return null;
}

export const CONCERN_LABEL_AR: Record<ConcernCategory, string> = {
  self_harm: "أذى النفس", abuse: "إساءة أو تهديد", bullying: "تنمّر", danger: "خطر محتمل",
};

/** Extra system instruction appended for the turn in which a concern was detected. */
export const SUPPORT_NOTE =
  "تنبيه: قد تحمل رسالة الطالب الأخيرة مؤشرًا على ضيق أو خطر. استجب بدفء وهدوء، وصدّق مشاعره، وشجّعه الآن على التحدث إلى معلّمه أو شخص بالغ موثوق في المدرسة أو البيت، ولا تقدّم نصائح علاجية ولا تَعِد بالسرية، ثم اعرض العودة إلى الدرس برفق إن أراد.";
