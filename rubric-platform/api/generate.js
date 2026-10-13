import { GoogleGenAI, ApiError } from '@google/genai';
import { randomUUID } from 'node:crypto';
import { authenticate, send, redis, readBody, cleanCriteria, GOALS_KEY } from './_lib.js';

// Set GEMINI_MODEL to the exact model id shown in Google AI Studio (e.g. the Gemini 3.x model you use).
const MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

const EXAMPLE = {
  name: 'تقييم حجة الكاتب',
  advanced: 'أقيّم حجة الكاتب بعمق، فأحدّد دعواه وأدلته، وأحكم على مدى اتساقها وإقناعها بتعليل واضح.',
  proficient: 'أقيّم حجة الكاتب بصورة صحيحة، فأحدّد دعواه وأدلته، وأبدي حكمًا مناسبًا على مدى إقناعها.',
  developing: 'أحدّد دعوى الكاتب وبعض أدلته، وأبدي حكمًا على حجته بالطريقة التي تناسب مستواي.',
  beginner: 'أحدّد دعوى الكاتب، وأعبّر عن رأيي في حجته بالطريقة التي تناسب مستواي.',
};

function buildPrompt(goal) {
  return `أنت خبير تقويم تربوي. ولّد سلّم تقدير (Rubric) للتقييم الذاتي للطالب، باللغة العربية الفصحى المبسّطة، بناءً على الهدف التالي.

الهدف: ${goal}

المطلوب:
- استخرج من الهدف ثلاث مهارات أساسية يجب أن يتقنها الطالب ليحقق الهدف، وكل مهارة منها محك معياري. ثلاثة محكّات بالضبط، لا يتداخل بعضها مع بعض، ومرتبة من الأسبق إلى الأعمق، واسم كل محك عبارة قصيرة (3 إلى 7 كلمات) تسمّي المهارة نفسها.
- لكل محك أربعة مستويات تعبّر عن درجة تحقيق الهدف: advanced (متقدّم جدًّا: يحقق الهدف بصورة كاملة ومتعمقة)، proficient (متقن: يحققه بصورة صحيحة وجيدة)، developing (نامٍ: يحقق جزءًا كبيرًا منه، ويضمّ الوصف عبارة: بالطريقة التي تناسب مستواي)، beginner (مبتدئ: يحقق جزءًا منه، ويضمّ الوصف عبارة: بالطريقة التي تناسب مستواي).
- التقييم ذاتي: اكتب كل وصف بصيغة المتكلم المفرد (أحلّل، أحدّد، أربط، أستخلص، أعبّر…)، ولا تستخدم صيغة الغائب مطلقًا.
- يصف كل مستوى ما يحققه الطالب فعلًا من الهدف، ويُمنع منعًا باتًّا استخدام عبارات سلبية أو نقص مثل: أواجه صعوبة، لا أستطيع، لا أتمكن، أخطئ، ضعيف. في مستوى المبتدئ والنامي استخدم صياغة إيجابية تصف ما يفعله فعلًا.
- لا تُنهِ الوصف بعبارة عامة عن تحقيق الهدف (مثل: فأحقق الهدف)، بل اكتفِ بوصف ما يفعله الطالب. المحكّات مرتبة، ويقيّم الطالب نفسه في المحك الأول وحده ثم ينتقل إلى الثاني والثالث.
- كل وصف جملة واحدة، يصف سلوكًا قابلًا للملاحظة، ويتدرج بين المستويات في الاتساع والدقة والعمق، دون أرقام أو درجات.
- اتبع أسلوب المثال التالي في الصياغة والطول.

مثال لمحك واحد:
${JSON.stringify(EXAMPLE)}

أعد JSON صالحًا فقط، بلا شرح ولا علامات \`\`\`، بهذا الشكل:
{"criteria":[{"name":"","advanced":"","proficient":"","developing":"","beginner":""},{...},{...}]}`;
}

function extractJson(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const teacher = authenticate(req, res);
  if (!teacher) return;

  const body = await readBody(req);
  const goal = String(body.goal ?? '').trim();
  if (goal.length < 8) return send(res, 400, { error: 'اكتب الهدف التعليمي كاملًا.' });
  if (goal.length > 600) return send(res, 400, { error: 'الهدف طويل جدًّا، اختصره في 600 حرف أو أقل.' });
  if (!process.env.GEMINI_API_KEY) return send(res, 500, { error: 'مفتاح GEMINI_API_KEY غير مضبوط في الخادم.' });

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      ...(process.env.GEMINI_BASE_URL ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } } : {}),
    });
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: buildPrompt(goal),
      config: { responseMimeType: 'application/json', temperature: 0.7 },
    });

    const text = response.text ?? '';
    if (!text) return send(res, 422, { error: 'تعذّر توليد المحكّات لهذا الهدف. أعد صياغته وحاول مرة أخرى.' });
    const criteria = cleanCriteria(extractJson(text)?.criteria);
    if (!criteria) return send(res, 502, { error: 'جاء الناتج بصيغة غير صالحة. أعد المحاولة.' });

    const now = Date.now();
    const saved = { id: randomUUID(), goal, teacher, criteria, createdAt: now, updatedAt: now };
    await redis(['HSET', GOALS_KEY, saved.id, JSON.stringify(saved)]);
    return send(res, 200, { goal: saved });
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 429) return send(res, 429, { error: 'الطلبات كثيرة الآن، انتظر قليلًا ثم أعد المحاولة.' });
      if (e.status === 400 || e.status === 401 || e.status === 403) return send(res, 500, { error: 'مفتاح Gemini أو اسم النموذج غير صالح في إعدادات الخادم.' });
      if (e.status === 404) return send(res, 500, { error: 'اسم النموذج GEMINI_MODEL غير موجود. تحقق منه في Google AI Studio.' });
      return send(res, 502, { error: 'تعذّر الاتصال بخدمة التوليد. أعد المحاولة.' });
    }
    return send(res, 500, { error: e.message || 'خطأ في الخادم.' });
  }
}
