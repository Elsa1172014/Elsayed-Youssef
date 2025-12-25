
// Fix: Use direct API_KEY from process.env and improve response text extraction
import { GoogleGenAI, Type } from "@google/genai";
import { AppState, AssessmentData, Question, TextImage } from "../types";

export const generateAssessment = async (state: AppState): Promise<AssessmentData> => {
  // Use API_KEY directly as per guidelines
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const prompt = `
أنت خبير لغة عربية ومصمم تقييمات مدرسية للمراحل العليا. مهمتك توليد أسئلة عالية الجودة من النص المعطى فقط دون اختلاق معلومات.

المدخلات:
- الصف الدراسي: ${state.grade}
- نوع النص: ${state.textType}
- المهارة المستهدفة: ${state.skill}
- الهدف التعليمي: ${state.objective}
- معايير النجاح: 
${state.criteria}
- عدد الأسئلة المطلوبة:
  - أقل من التوقعات: ${state.countBelow}
  - ضمن التوقعات: ${state.countWithin}
  - فوق التوقعات: ${state.countAbove}

النص:
${state.text}

القواعد الذهبية لتصميم الأسئلة:
1. منع الأسئلة المغلقة "هل".
2. استخدام منهجية تفكيك النص (حلل، استنبط، قيم).
3. التنويع بين المقالي والاختيار من متعدد.

يجب أن يكون المخرج بصيغة JSON حصراً بهذا الهيكل:
{
  "meta": {
    "title": "عنوان النص",
    "grade": "${state.grade}",
    "textType": "${state.textType}",
    "skill": "${state.skill}",
    "objective": "${state.objective}",
    "criteria": ["قائمة معايير النجاح"]
  },
  "below": [ { "type": "تحليل", "question": "...", "answer": "...", "evidence": "...", "success_criteria": "1", "options": [] } ],
  "within": [ { "type": "تحليل", "question": "...", "answer": "...", "evidence": "...", "success_criteria": "2", "options": [] } ],
  "above": [ { "type": "تحليل", "question": "...", "answer": "...", "evidence": "...", "success_criteria": "3", "options": [] } ],
  "rubric": [ { "category": "المعيار", "levels": [ { "name": "متميز", "description": "..." } ] } ]
}
`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.7,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error("لم يتم استلام استجابة من النموذج.");
  }

  return JSON.parse(text) as AssessmentData;
};

export const evaluateAnswer = async (
  question: string, 
  modelAnswer: string, 
  studentAnswer: string, 
  criteria: string
): Promise<{ feedback: string, score: 0 | 1 | 2 }> => {
  // Use API_KEY directly as per guidelines
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const prompt = `
أنت معلم لغة عربية خبير. قم بتقييم إجابة الطالب التالية بناءً على السؤال، الإجابة النموذجية، ومعايير النجاح.

السؤال: ${question}
الإجابة النموذجية: ${modelAnswer}
إجابة الطالب: ${studentAnswer}
معايير النجاح: ${criteria}

المطلوب:
1. تقديم تغذية راجعة بناءة وموجزة باللغة العربية (ما أحسن فيه وما يحتاج لتطويره).
2. تحديد الدرجة المستحقة (0 إذا كانت خاطئة تماماً، 1 إذا كانت ناقصة، 2 إذا كانت وافية).

أخرج النتيجة كـ JSON:
{
  "feedback": "نص التغذية الراجعة هنا...",
  "score": 2
}
`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });

  return JSON.parse(response.text || '{"feedback": "فشل التقييم", "score": 0}');
};

export const extractVisualIdeas = async (text: string): Promise<string[]> => {
  // Use API_KEY directly as per guidelines
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const prompt = `حلل النص التالي واستخرج منه ما لا يقل عن 5 أفكار بصرية محورية (ويمكن أن تصل لـ 8) تعبر عن المشاهد أو المفاهيم العميقة في النص.
  أعطني فقط وصفاً فنياً مركزاً لكل فكرة باللغة العربية.
  النص: ${text}
  أخرج النتيجة كـ JSON مصفوفة نصوص فقط: ["فكرة 1", "فكرة 2", "فكرة 3", "فكرة 4", "فكرة 5"]`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });

  return JSON.parse(response.text || "[]");
};

export const generateImageForIdea = async (idea: string): Promise<string | null> => {
  // Use API_KEY directly as per guidelines
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        {
          text: `A cinematic educational illustration representing this idea: ${idea}. High quality, photorealistic or high-end digital art, clean, professional composition for a high school worksheet.`,
        },
      ],
    },
  });

  if (response.candidates?.[0]?.content?.parts) {
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
  }
  return null;
};

export const generateBloomQuestions = async (text: string, level: string, grade: string, count: number): Promise<Question[]> => {
  // Use API_KEY directly as per guidelines
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const prompt = `
بناءً على النص، ولد عدد (${count}) أسئلة تحليلية مبتكرة لمستوى "${level}" من هرم بلوم للصف ${grade}.
يجب أن تكون الأسئلة باللغة العربية الفصحى وتعكس المستوى المطلوب بدقة.

النص:
${text}

أخرج النتيجة كـ JSON حصراً (مصفوفة من الكائنات):
[
  { "type": "${level}", "question": "...", "answer": "...", "evidence": "...", "success_criteria": "1" }
]
`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.7,
    },
  });

  const output = response.text;
  if (!output) throw new Error("فشل في استلام أسئلة بلوم");
  
  return JSON.parse(output.trim()) as Question[];
};
