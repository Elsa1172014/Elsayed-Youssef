
import React, { useState, useRef, useEffect } from 'react';
import { Layout } from './components/Layout';
import { GRADES, TEXT_TYPES, SKILLS } from './constants';
import { AppState, AssessmentData, StudentAnswers, Question, TextImage } from './types';
import { generateAssessment, generateBloomQuestions, extractVisualIdeas, generateImageForIdea, evaluateAnswer } from './services/geminiService';
import { GoogleGenAI, Modality } from "@google/genai";

const BLOOM_LEVELS = [
  { id: 'remember', label: 'تذكر', icon: '🧠', color: 'bg-blue-500', hover: 'hover:bg-blue-600' },
  { id: 'understand', label: 'فهم', icon: '💡', color: 'bg-green-500', hover: 'hover:bg-green-600' },
  { id: 'apply', label: 'تطبيق', icon: '🛠️', color: 'bg-yellow-500', hover: 'hover:bg-yellow-600' },
  { id: 'analyze', label: 'تحليل', icon: '🔍', color: 'bg-orange-500', hover: 'hover:bg-orange-600' },
  { id: 'evaluate', label: 'تقييم', icon: '⚖️', color: 'bg-purple-500', hover: 'hover:bg-purple-600' },
  { id: 'create', label: 'ابتكار', icon: '🚀', color: 'bg-red-500', hover: 'hover:bg-red-600' },
];

const SuccessEffect: React.FC<{ gender: 'male' | 'female' | null }> = ({ gender }) => {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 1500);
    return () => clearTimeout(timer);
  }, []);

  if (!visible || !gender) return null;

  const emojis = gender === 'female' ? ['💖', '🌹', '✨', '🌸', '💝'] : ['🛡️', '⚔️', '🏇', '👑', '💪', '🔥'];

  return (
    <div className="absolute inset-0 pointer-events-none z-50 overflow-hidden flex items-center justify-center">
      {emojis.map((emoji, i) => (
        <span
          key={i}
          className="absolute animate-bounce text-4xl opacity-0"
          style={{
            animation: `float-up 1.5s ease-out forwards`,
            animationDelay: `${i * 0.1}s`,
            left: `${20 + Math.random() * 60}%`,
            top: '50%'
          }}
        >
          {emoji}
        </span>
      ))}
      <style>{`
        @keyframes float-up {
          0% { transform: translateY(0) scale(0.5); opacity: 0; }
          50% { opacity: 1; }
          100% { transform: translateY(-100px) scale(1.5); opacity: 0; }
        }
      `}</style>
    </div>
  );
};

function decodeBase64Audio(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodePCMToAudioBuffer(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const QuestionItem: React.FC<{
  q: Question;
  index: number;
  qId: string;
  showAnswers: boolean;
  studentAnswer: string;
  isCorrect: boolean | null;
  successCriteriaText: string;
  onAnswerChange: (val: string) => void;
  onMarkCorrect: (correct: boolean) => void;
  isVisible: boolean;
  onToggleReveal: () => void;
  studentGender: 'male' | 'female' | null;
}> = ({ q, index, qId, showAnswers, studentAnswer, isCorrect, successCriteriaText, onAnswerChange, onMarkCorrect, isVisible, onToggleReveal, studentGender }) => {
  const isMCQ = q.options && q.options.length > 0;
  const points = isMCQ ? 1 : 2;
  const initialTime = isMCQ ? 30 : 90;
  const [timeLeft, setTimeLeft] = useState(initialTime);
  const [timerActive, setTimerActive] = useState(false);
  const [timerFinished, setTimerFinished] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiFeedback, setAiFeedback] = useState<string | null>(null);
  const [triggerEffect, setTriggerEffect] = useState(false);

  useEffect(() => {
    let interval: any;
    if (timerActive && timeLeft > 0) {
      interval = setInterval(() => {
        setTimeLeft((prev) => prev - 1);
      }, 1000);
    } else if (timeLeft === 0) {
      setTimerActive(false);
      setTimerFinished(true);
      if (interval) clearInterval(interval);
    }
    return () => clearInterval(interval);
  }, [timerActive, timeLeft]);

  const handleInteraction = () => {
    if (!timerActive && !timerFinished && !showAnswers) {
      setTimerActive(true);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleAiCheck = async () => {
    if (!studentAnswer.trim()) {
      alert("يرجى كتابة إجابة أولاً");
      return;
    }
    setAiLoading(true);
    try {
      const evaluation = await evaluateAnswer(q.question, q.answer, studentAnswer, successCriteriaText);
      setAiFeedback(evaluation.feedback);
      const correct = evaluation.score >= 1;
      onMarkCorrect(correct);
      if (correct) {
        setTriggerEffect(true);
        setTimeout(() => setTriggerEffect(false), 2000);
      }
    } catch (err) {
      alert("فشل تقييم المعلم الذكي حالياً.");
    } finally {
      setAiLoading(false);
    }
  };

  const handleOptionClick = (opt: string) => {
    handleInteraction(); 
    onAnswerChange(opt);
    if (opt === q.answer) {
      setTriggerEffect(true);
      setTimeout(() => setTriggerEffect(false), 2000);
    }
  };

  return (
    <div className={`relative pt-4 pr-6 border-r-4 transition-all duration-500 ${timerActive ? 'border-indigo-500 bg-indigo-50/5' : 'border-gray-100'}`}>
      {triggerEffect && <SuccessEffect gender={studentGender} />}
      <div className="flex gap-4">
        <div className="flex flex-col items-center shrink-0 mt-2">
          <span className={`font-bold text-2xl font-sans w-12 h-12 flex items-center justify-center rounded-full mb-3 shadow-sm transition-colors ${timerFinished ? 'bg-red-100 text-red-600' : 'bg-indigo-100 text-indigo-700'}`}>
            {index}
          </span>
          
          <button 
            onClick={onToggleReveal}
            className={`no-print p-2 rounded-full transition-all shadow-sm ${isVisible ? 'bg-indigo-600 text-white' : 'bg-white text-gray-400 hover:bg-gray-100 border'}`}
            title="إظهار الإجابة والتحقق"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              {isVisible ? (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </>
              ) : (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
          </button>
        </div>

        <div className="space-y-6 w-full pb-4">
          <div className="flex items-start justify-between gap-4">
            <p className="text-2xl leading-relaxed font-amiri font-bold text-gray-900">
              {q.type && <span className="text-xs bg-indigo-50 text-indigo-600 px-2 py-1 rounded border border-indigo-100 ml-3 font-sans align-middle uppercase tracking-widest font-black">[{q.type}]</span>}
              {q.question}
            </p>
          </div>
          
          <div className="w-full">
            {isMCQ ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                {q.options!.map((opt, oi) => (
                  <button 
                    key={oi} 
                    disabled={showAnswers || isVisible}
                    onClick={() => handleOptionClick(opt)}
                    className={`text-right font-sans text-lg p-5 border-2 rounded-2xl transition-all shadow-sm ${studentAnswer === opt ? 'bg-indigo-50 border-indigo-500 scale-[1.01]' : 'bg-white hover:border-indigo-200 border-gray-100'} ${isVisible && opt === q.answer ? 'bg-green-50 border-green-500 ring-2 ring-green-100' : ''} ${isVisible && studentAnswer === opt && opt !== q.answer ? 'bg-red-50 border-red-500' : ''}`}
                  >
                    <span className="font-black text-indigo-700 ml-3">{String.fromCharCode(97 + oi).toUpperCase()}.</span>
                    {opt}
                  </button>
                ))}
              </div>
            ) : (
              <div className="relative mt-2">
                <textarea 
                  disabled={showAnswers || isVisible}
                  value={studentAnswer}
                  onFocus={handleInteraction}
                  onKeyDown={handleInteraction}
                  onChange={(e) => { handleInteraction(); onAnswerChange(e.target.value); }}
                  rows={4}
                  className={`w-full p-5 border-2 border-dashed rounded-2xl bg-gray-50/30 focus:bg-white focus:border-indigo-400 focus:outline-none text-xl font-amiri leading-loose no-print transition-all ${timerFinished ? 'border-red-300 bg-red-50/5' : 'border-gray-200'}`}
                  placeholder="اكتب إجابتك هنا..."
                />
              </div>
            )}
          </div>

          <div className="flex justify-between items-center bg-gray-50 px-4 py-2 rounded-lg border border-gray-100 no-print">
            <div className="flex items-center gap-2 text-amber-800">
              <span className="bg-amber-100 px-2 py-0.5 rounded text-[12px] font-black uppercase">
                {points} {points === 1 ? 'درجة' : 'درجتان'}
              </span>
            </div>
            <div className={`flex items-center gap-2 font-mono text-sm font-bold ${timeLeft < 10 ? 'text-red-600 animate-pulse' : 'text-gray-500'}`}>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              {formatTime(timeLeft)}
            </div>
          </div>

          {isVisible && (
            <div className="mt-6 p-6 bg-white border-2 border-indigo-100 rounded-xl shadow-lg space-y-6 animate-in slide-in-from-right-4 duration-500">
              <div className="space-y-4">
                <div className="flex gap-4">
                  <div className="bg-green-600 text-white p-1 rounded h-fit shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <div>
                    <span className="font-black text-green-800 text-sm block mb-1 uppercase tracking-tight">الإجابة النموذجية:</span>
                    <p className="text-green-950 font-amiri font-bold text-2xl">{q.answer}</p>
                  </div>
                </div>
                <div className="flex gap-4 pt-4 border-t border-gray-100">
                  <div className="bg-indigo-600 text-white p-1 rounded h-fit shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>
                  </div>
                  <div>
                    <span className="font-black text-indigo-700 text-sm block mb-1 uppercase tracking-tight">الدليل من النص:</span>
                    <p className="italic text-gray-800 font-amiri bg-indigo-50/30 p-3 rounded-lg border border-indigo-100/50 leading-relaxed">"{q.evidence}"</p>
                  </div>
                </div>
              </div>

              {!isMCQ && (
                <div className="space-y-4">
                  <div className="flex flex-col md:flex-row items-center justify-between gap-4 p-4 bg-indigo-50 rounded-xl border border-indigo-100">
                    <div className="flex items-center gap-3">
                      <div className="bg-indigo-600 text-white p-2 rounded-lg">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                      </div>
                      <p className="text-sm font-bold text-indigo-900">المعلم الذكي: اطلب تقييماً دقيقاً لإجابتك</p>
                    </div>
                    <button 
                      onClick={handleAiCheck}
                      disabled={aiLoading}
                      className="bg-indigo-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-indigo-700 transition-all flex items-center gap-2 disabled:opacity-50"
                    >
                      {aiLoading ? (
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      ) : 'قيم إجابتي'}
                    </button>
                  </div>

                  {aiFeedback && (
                    <div className="p-5 bg-white border-2 border-indigo-200 rounded-xl shadow-inner animate-in fade-in slide-in-from-top-2 duration-500">
                      <h5 className="font-black text-indigo-700 text-xs mb-3 flex items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                        تحليل المعلم الذكي وتوصياته:
                      </h5>
                      <p className="text-gray-800 leading-relaxed font-sans text-sm whitespace-pre-wrap">{aiFeedback}</p>
                    </div>
                  )}
                </div>
              )}

              {isMCQ && (
                <div className={`p-4 rounded-xl text-center font-bold text-lg ${studentAnswer === q.answer ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                  {studentAnswer === q.answer ? `إجابة صحيحة! حصلت على ${points} درجة.` : `إجابة خاطئة. حاور نفسك واستخدم الدليل.`}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [loadingImages, setLoadingImages] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [assessment, setAssessment] = useState<AssessmentData | null>(null);
  const [showAnswers, setShowAnswers] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [studentAnswers, setStudentAnswers] = useState<StudentAnswers>({});
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [bloomQuestions, setBloomQuestions] = useState<Record<string, Question[]>>({
    below: [], within: [], above: []
  });
  const [loadingBloom, setLoadingBloom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusedLevel, setFocusedLevel] = useState<'below' | 'within' | 'above' | null>(null);
  const [customIdeaInput, setCustomIdeaInput] = useState("");
  const [isAddingImage, setIsAddingImage] = useState(false);
  const [studentGender, setStudentGender] = useState<'male' | 'female' | null>(null);
  const [studentName, setStudentName] = useState("");
  const [isPrintingTextOnly, setIsPrintingTextOnly] = useState(false);
  const [isPrintingBlank, setIsPrintingBlank] = useState(false);
  
  const [globalTimeLeft, setGlobalTimeLeft] = useState<number | null>(null);
  const [isAssessmentStarted, setIsAssessmentStarted] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);

  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    below: true, within: true, above: true, rubric: false, successCriteria: false
  });

  const [formState, setFormState] = useState<AppState>({
    grade: "Y12", textType: "مقال", skill: "تفكير ناقد",
    objective: "أن يقيّم الطالب حجة الكاتب ويحدد مواضع القوة والضعف مع الاستدلال بعبارتين من النص.",
    criteria: "1) يحدد الفكرة الرئيسة بدقة.\n2) يذكر دليلين نصيين مناسبين.\n3) يصوغ حكمًا نقديًا منطقيًا بلغة سليمة.",
    countBelow: 3, countWithin: 3, countAbove: 3, text: "",
    totalTime: 45
  });

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormState(prev => ({ ...prev, [name]: name === 'totalTime' || name.startsWith('count') ? parseInt(value) || 0 : value }));
  };

  const handleGenerate = async () => {
    if (!formState.text.trim()) {
      alert("يرجى إدخل النص أولاً");
      return;
    }
    setLoading(true);
    setLoadingImages(true);
    setError(null);
    setStudentAnswers({});
    setResults({});
    setBloomQuestions({ below: [], within: [], above: [] });
    setFocusedLevel(null);
    setIsAssessmentStarted(false);
    setGlobalTimeLeft(null);

    try {
      const data = await generateAssessment(formState);
      data.meta.totalTime = formState.totalTime;
      setAssessment(data);
      setShowSidebar(false);
      
      try {
        const ideas = await extractVisualIdeas(formState.text);
        const images: TextImage[] = [];
        for (const idea of ideas) {
          const url = await generateImageForIdea(idea);
          if (url) images.push({ idea, url });
        }
        setAssessment(prev => prev ? ({ ...prev, images }) : null);
      } catch (imgErr) {
        console.warn("Failed to generate images", imgErr);
      } finally {
        setLoadingImages(false);
      }
      
    } catch (err) {
      console.error(err);
      setError("حدث خطأ أثناء توليد الأسئلة.");
      setLoadingImages(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let interval: any;
    if (isAssessmentStarted && globalTimeLeft !== null && globalTimeLeft > 0) {
      interval = setInterval(() => {
        setGlobalTimeLeft(prev => (prev !== null ? prev - 1 : null));
      }, 1000);
    } else if (globalTimeLeft === 0) {
      alert("انتهى وقت التقييم الكلي!");
      setIsAssessmentStarted(false);
    }
    return () => clearInterval(interval);
  }, [isAssessmentStarted, globalTimeLeft]);

  const startAssessment = () => {
    if (assessment?.meta?.totalTime) {
      setGlobalTimeLeft(assessment.meta.totalTime * 60);
      setIsAssessmentStarted(true);
    }
  };

  const formatGlobalTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleAddCustomIdea = async () => {
    if (!customIdeaInput.trim()) return;
    setIsAddingImage(true);
    try {
      const url = await generateImageForIdea(customIdeaInput);
      if (url) {
        setAssessment(prev => prev ? {
          ...prev,
          images: [...(prev.images || []), { idea: customIdeaInput, url }]
        } : null);
        setCustomIdeaInput("");
      }
    } catch (err) {
      alert("فشل توليد الصورة المخصصة.");
    } finally {
      setIsAddingImage(false);
    }
  };

  const handleBloomClick = async (sectionId: string, level: { id: string, label: string }, count: number) => {
    if (loadingBloom || !assessment) return;
    setLoadingBloom(`${sectionId}-${level.id}`);
    try {
      const questions = await generateBloomQuestions(formState.text, level.label, formState.grade, count);
      setBloomQuestions(prev => {
        const taggedQuestions = questions.map(q => ({ ...q, type: level.label }));
        return { 
          ...prev, 
          [sectionId]: [...(prev[sectionId] || []), ...taggedQuestions] 
        };
      });
    } catch (err) {
      console.error(err);
      alert("حدث خطأ أثناء توليد أسئلة بلوم.");
    } finally {
      setLoadingBloom(null);
    }
  };

  const handleTTS = async () => {
    if (!formState.text.trim() || isSpeaking) return;
    setIsSpeaking(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `اقرأ النص التالي: ${formState.text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const ctx = audioContextRef.current;
        const audioBuffer = await decodePCMToAudioBuffer(decodeBase64Audio(base64Audio), ctx, 24000, 1);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.onended = () => setIsSpeaking(false);
        source.start();
      } else setIsSpeaking(false);
    } catch (err) {
      setIsSpeaking(false);
    }
  };

  const handlePrintBlank = () => {
    setIsPrintingBlank(true);
    setIsPrintingTextOnly(false);
    setExpandedSections({ below: true, within: true, above: true, rubric: true, successCriteria: true });
    
    setTimeout(() => {
      window.print();
      setIsPrintingBlank(false);
    }, 200);
  };

  const handlePrintTextOnly = () => {
    setIsPrintingTextOnly(true);
    setIsPrintingBlank(false);
    
    setTimeout(() => {
      window.print();
      setIsPrintingTextOnly(false);
    }, 200);
  };

  return (
    <Layout>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {showSidebar && (
          <div className="lg:col-span-4 space-y-6 no-print animate-in slide-in-from-right-4 duration-300">
            <div className="bg-white rounded-xl shadow-md p-6 border border-gray-100">
              <h2 className="text-xl font-bold mb-6 border-b pb-3 flex items-center gap-2 text-indigo-700 font-sans">
                بيانات التقييم
              </h2>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="block text-sm font-semibold mb-1">الصف</label><select name="grade" value={formState.grade} onChange={handleInputChange} className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-indigo-500">{GRADES.map(g => <option key={g} value={g}>{g}</option>)}</select></div>
                  <div><label className="block text-sm font-semibold mb-1">نوع النص</label><select name="textType" value={formState.textType} onChange={handleInputChange} className="w-full p-2 border rounded-lg">{TEXT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></div>
                </div>
                <div><label className="block text-sm font-semibold mb-1">المهارة</label><select name="skill" value={formState.skill} onChange={handleInputChange} className="w-full p-2 border rounded-lg">{SKILLS.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
                
                <div>
                  <label className="block text-sm font-semibold mb-1 text-indigo-700">زمن ورقة العمل (بالدقائق)</label>
                  <input 
                    type="number" 
                    name="totalTime" 
                    value={formState.totalTime} 
                    onChange={handleInputChange} 
                    min="5" 
                    max="180" 
                    className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 font-bold"
                  />
                </div>

                <div><label className="block text-sm font-semibold mb-1">الهدف</label><textarea name="objective" value={formState.objective} onChange={handleInputChange} rows={2} className="w-full p-2 border rounded-lg text-sm" /></div>
                <div><label className="block text-sm font-semibold mb-1">المعايير</label><textarea name="criteria" value={formState.criteria} onChange={handleInputChange} rows={3} className="w-full p-2 border rounded-lg text-sm" /></div>
                
                <div className="pt-4 border-t">
                  <label className="block text-sm font-bold mb-3 text-indigo-600">عدد الأسئلة المطلوبة لكل مستوى:</label>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="text-center">
                      <label className="block text-[10px] font-bold text-gray-500 mb-1">أقل</label>
                      <input type="number" name="countBelow" value={formState.countBelow} onChange={handleInputChange} min="1" max="10" className="w-full p-2 border rounded-lg text-center font-bold" />
                    </div>
                    <div className="text-center">
                      <label className="block text-[10px] font-bold text-gray-500 mb-1">ضمن</label>
                      <input type="number" name="countWithin" value={formState.countWithin} onChange={handleInputChange} min="1" max="10" className="w-full p-2 border rounded-lg text-center font-bold" />
                    </div>
                    <div className="text-center">
                      <label className="block text-[10px] font-bold text-gray-500 mb-1">فوق</label>
                      <input type="number" name="countAbove" value={formState.countAbove} onChange={handleInputChange} min="1" max="10" className="w-full p-2 border rounded-lg text-center font-bold" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-md p-6 border border-gray-100">
              <h2 className="text-xl font-bold mb-6 border-b pb-3 text-indigo-700">النص القرائي</h2>
              <textarea name="text" value={formState.text} onChange={handleInputChange} rows={12} className="w-full p-3 border rounded-lg font-amiri text-lg" placeholder="ألصق النص هنا..." />
              <button onClick={handleGenerate} disabled={loading} className={`w-full mt-4 p-4 rounded-xl font-bold text-white shadow-lg transition-transform active:scale-95 ${loading ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                {loading ? "جاري التوليد..." : "توليد ورقة العمل"}
              </button>
            </div>
          </div>
        )}

        <div className={showSidebar ? "lg:col-span-8" : "lg:col-span-12"}>
          {assessment ? (
            <div className="space-y-6">
              <div className="no-print bg-white p-4 rounded-xl shadow-sm border flex flex-wrap gap-4 justify-between items-center sticky top-4 z-50">
                <div className="flex gap-4 items-center flex-wrap">
                  {showAnswers && (
                    <button 
                      onClick={() => setShowSidebar(!showSidebar)} 
                      className="flex items-center gap-2 bg-indigo-50 text-indigo-700 px-4 py-2 rounded-lg text-sm font-bold hover:bg-indigo-100 transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        {showSidebar ? <path d="M18 6 6 18M6 6l12 12"/> : <path d="M4 6h16M4 12h16M4 18h16"/>}
                      </svg>
                      {showSidebar ? "إخفاء المدخلات" : "إظهار الإعدادات"}
                    </button>
                  )}
                  {showAnswers && <div className="h-6 w-px bg-gray-200 mx-2 hidden md:block"></div>}
                  
                  {globalTimeLeft !== null ? (
                    <div className={`flex items-center gap-3 px-4 py-2 rounded-xl font-black shadow-inner transition-colors ${globalTimeLeft < 60 ? 'bg-red-600 text-white animate-pulse' : 'bg-gray-900 text-white'}`}>
                       <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                       <span className="font-mono text-xl">{formatGlobalTime(globalTimeLeft)}</span>
                    </div>
                  ) : (
                    <button 
                      onClick={startAssessment}
                      className="bg-green-600 text-white px-4 py-2 rounded-lg font-bold hover:bg-green-700 transition-all flex items-center gap-2"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      بدء التقييم الموقوت
                    </button>
                  )}
                </div>
                
                <div className="flex gap-2 flex-wrap">
                  <div className="flex gap-2">
                    <button 
                      onClick={() => setShowAnswers(!showAnswers)} 
                      className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${!showAnswers ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'}`}
                    >
                      {showAnswers ? 'عرض الطالب' : 'الطالب'}
                    </button>
                    {showAnswers && (
                      <button 
                        onClick={() => setShowAnswers(true)} 
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${showAnswers ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'}`}
                      >
                        المعلم
                      </button>
                    )}
                  </div>
                  <button onClick={handlePrintBlank} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-bold hover:bg-green-700 transition-colors flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 18H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14" rx="1"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/></svg>
                    حفظ ورقة العمل PDF
                  </button>
                  <button onClick={handlePrintTextOnly} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-bold hover:bg-indigo-700 transition-colors flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>
                    تحميل النص فقط PDF
                  </button>
                </div>
              </div>

              <div className="bg-white shadow-2xl rounded-sm p-10 font-amiri worksheet-page border border-gray-200 min-h-screen animate-in fade-in duration-700 relative">
                
                <div className="border-b-4 border-double border-black pb-6 mb-8 text-center relative">
                  <h1 className="text-3xl font-bold">ورقة عمل: {assessment.meta.title}</h1>
                  
                  <div className="flex justify-center gap-8 mt-4 font-sans no-print">
                    <button 
                      onClick={() => setStudentGender('female')}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl border-2 transition-all ${studentGender === 'female' ? 'bg-pink-100 border-pink-500 scale-105' : 'bg-white border-gray-200 hover:border-pink-200'}`}
                    >
                      <span className="text-2xl">👩‍🎓</span>
                      <span className="font-bold text-pink-700">طالبة</span>
                    </button>
                    <button 
                      onClick={() => setStudentGender('male')}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl border-2 transition-all ${studentGender === 'male' ? 'bg-blue-100 border-blue-500 scale-105' : 'bg-white border-gray-200 hover:border-blue-200'}`}
                    >
                      <span className="text-2xl">👨‍🎓</span>
                      <span className="font-bold text-blue-700">طالب</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-4 text-lg mt-6 font-sans">
                    <div className="border border-black p-3 flex flex-col items-start gap-1">
                      <div className="flex items-center gap-2 w-full">
                        <span className="shrink-0 font-bold">اسم الطالب:</span>
                        <input 
                          type="text" 
                          value={studentName}
                          onChange={(e) => setStudentName(e.target.value)}
                          className="border-b border-black outline-none flex-grow bg-transparent px-2 font-amiri"
                          placeholder="...................."
                        />
                      </div>
                    </div>
                    <div className="border border-black p-3 font-bold">الصف: {assessment.meta.grade}</div>
                    <div className="border border-black p-3 font-bold">التاريخ: {new Date().toLocaleDateString('ar-EG')}</div>
                  </div>
                </div>

                {!isPrintingTextOnly && (
                  <div className="no-print mb-8 p-4 bg-indigo-50 border-2 border-indigo-100 rounded-2xl flex flex-col md:flex-row items-center justify-center gap-4">
                    <span className="font-bold text-indigo-900 ml-4 shrink-0">اختر مستوى التحدي الذي يناسبك:</span>
                    <div className="flex flex-wrap justify-center gap-3">
                      <button onClick={() => setFocusedLevel('below')} className={`px-6 py-2 rounded-xl font-bold transition-all border-2 ${focusedLevel === 'below' ? 'bg-red-500 text-white border-red-600 scale-105 shadow-md' : 'bg-white text-red-600 border-red-100 hover:border-red-300'}`}>مستوى أقل من المتوقع</button>
                      <button onClick={() => setFocusedLevel('within')} className={`px-6 py-2 rounded-xl font-bold transition-all border-2 ${focusedLevel === 'within' ? 'bg-yellow-500 text-white border-yellow-600 scale-105 shadow-md' : 'bg-white text-yellow-600 border-yellow-100 hover:border-yellow-300'}`}>مستوى ضمن المتوقع</button>
                      <button onClick={() => setFocusedLevel('above')} className={`px-6 py-2 rounded-xl font-bold transition-all border-2 ${focusedLevel === 'above' ? 'bg-green-500 text-white border-green-600 scale-105 shadow-md' : 'bg-white text-green-600 border-green-100 hover:border-green-300'}`}>مستوى فوق المتوقع</button>
                      <button onClick={() => setFocusedLevel(null)} className={`px-6 py-2 rounded-xl font-bold transition-all border-2 ${focusedLevel === null ? 'bg-indigo-600 text-white border-indigo-700 scale-105 shadow-md' : 'bg-white text-indigo-600 border-indigo-100 hover:border-indigo-300'}`}>عرض كافة المستويات</button>
                    </div>
                  </div>
                )}

                <div className="mb-12">
                  <div className="flex items-center justify-between border-b-2 border-black mb-4">
                    <h2 className="text-2xl font-bold">النص القرائي:</h2>
                    <div className="flex gap-2 no-print">
                      <button onClick={handleTTS} disabled={isSpeaking} className="bg-indigo-100 p-2 rounded-full text-indigo-700 hover:bg-indigo-200 transition-colors">
                        {isSpeaking ? '🔊' : '🔈'}
                      </button>
                    </div>
                  </div>
                  
                  <div className="flex flex-col md:flex-row gap-8">
                    <div className="flex-grow text-xl leading-relaxed text-justify p-6 bg-blue-50/20 rounded-xl border border-blue-100 font-amiri whitespace-pre-wrap">
                      {formState.text}
                    </div>
                    
                    {!isPrintingTextOnly && (
                      <div className="md:w-72 space-y-6 shrink-0 no-print">
                        <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100 space-y-3">
                          <h4 className="text-sm font-bold text-indigo-800">إضافة صورة بصرية</h4>
                          <textarea value={customIdeaInput} onChange={(e) => setCustomIdeaInput(e.target.value)} placeholder="وصف المشهد..." className="w-full p-2 text-sm border rounded-lg" rows={2} />
                          <button onClick={handleAddCustomIdea} disabled={isAddingImage} className="w-full py-2 bg-indigo-600 text-white rounded-lg text-sm font-bold disabled:opacity-50">توليد</button>
                        </div>
                        <div className="space-y-4">
                          {assessment.images?.map((img, idx) => (
                            <div key={idx} className="bg-white border rounded-xl overflow-hidden shadow-sm">
                              <img src={img.url} alt={img.idea} className="w-full h-32 object-cover" />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Visual images for PDF print only if not text-only */}
                    {!isPrintingTextOnly && (
                      <div className="hidden print:block w-48 space-y-4 shrink-0">
                         {assessment.images?.map((img, idx) => (
                            <img key={idx} src={img.url} className="w-full rounded border border-gray-200" />
                         ))}
                      </div>
                    )}
                  </div>
                </div>

                {!isPrintingTextOnly && (
                  <div className="space-y-10">
                    {(focusedLevel === null || focusedLevel === 'below') && (
                      <SectionCard 
                        title="المستوى الأول: أقل من التوقعات" id="below" 
                        questions={[...assessment.below, ...(bloomQuestions.below || [])]} 
                        isExpanded={expandedSections.below} onToggle={() => setExpandedSections(p => ({...p, below: !p.below}))}
                        showAnswers={isPrintingBlank ? false : showAnswers} 
                        studentAnswers={isPrintingBlank ? {} : studentAnswers} results={isPrintingBlank ? {} : results} 
                        onAnswerChange={(id, val) => setStudentAnswers(p => ({...p, [id]: val}))}
                        onResultChange={(id, res) => setResults(p => ({...p, [id]: res}))}
                        startIndex={1} onBloomClick={(lvl, count) => handleBloomClick('below', lvl, count)} loadingBloom={loadingBloom}
                        onFocus={() => setFocusedLevel('below')} isFocused={focusedLevel === 'below'}
                        successCriteriaText={formState.criteria}
                        studentGender={studentGender}
                        isPrintingBlank={isPrintingBlank}
                      />
                    )}
                    {(focusedLevel === null || focusedLevel === 'within') && (
                      <SectionCard 
                        title="المستوى الثاني: ضمن التوقعات" id="within" 
                        questions={[...assessment.within, ...(bloomQuestions.within || [])]} 
                        isExpanded={expandedSections.within} onToggle={() => setExpandedSections(p => ({...p, within: !p.within}))}
                        showAnswers={isPrintingBlank ? false : showAnswers} 
                        studentAnswers={isPrintingBlank ? {} : studentAnswers} results={isPrintingBlank ? {} : results}
                        onAnswerChange={(id, val) => setStudentAnswers(p => ({...p, [id]: val}))}
                        onResultChange={(id, res) => setResults(p => ({...p, [id]: res}))}
                        startIndex={assessment.below.length + (bloomQuestions.below?.length || 0) + 1} 
                        onBloomClick={(lvl, count) => handleBloomClick('within', lvl, count)} loadingBloom={loadingBloom}
                        onFocus={() => setFocusedLevel('within')} isFocused={focusedLevel === 'within'}
                        successCriteriaText={formState.criteria}
                        studentGender={studentGender}
                        isPrintingBlank={isPrintingBlank}
                      />
                    )}
                    {(focusedLevel === null || focusedLevel === 'above') && (
                      <SectionCard 
                        title="المستوى الثالث: فوق التوقعات" id="above" 
                        questions={[...assessment.above, ...(bloomQuestions.above || [])]} 
                        isExpanded={expandedSections.above} onToggle={() => setExpandedSections(p => ({...p, above: !p.above}))}
                        showAnswers={isPrintingBlank ? false : showAnswers} 
                        studentAnswers={isPrintingBlank ? {} : studentAnswers} results={isPrintingBlank ? {} : results}
                        onAnswerChange={(id, val) => setStudentAnswers(p => ({...p, [id]: val}))}
                        onResultChange={(id, res) => setResults(p => ({...p, [id]: res}))}
                        startIndex={assessment.below.length + (bloomQuestions.below?.length || 0) + assessment.within.length + (bloomQuestions.within?.length || 0) + 1} 
                        onBloomClick={(lvl, count) => handleBloomClick('above', lvl, count)} loadingBloom={loadingBloom}
                        onFocus={() => setFocusedLevel('above')} isFocused={focusedLevel === 'above'}
                        successCriteriaText={formState.criteria}
                        studentGender={studentGender}
                        isPrintingBlank={isPrintingBlank}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : !loading && (
            <div className="bg-white border-2 border-dashed rounded-2xl p-20 text-center text-gray-400">
              أدخل البيانات والنص في اللوحة الجانبية ثم اضغط "توليد ورقة العمل"
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
};

interface SectionCardProps {
  title: string;
  id: string;
  questions: Question[];
  isExpanded: boolean;
  onToggle: () => void;
  showAnswers: boolean;
  studentAnswers: StudentAnswers;
  results: Record<string, boolean>;
  onAnswerChange: (id: string, val: string) => void;
  onResultChange: (id: string, res: boolean) => void;
  startIndex: number;
  onBloomClick: (lvl: any, count: number) => void;
  loadingBloom: string | null;
  onFocus: () => void;
  isFocused: boolean;
  successCriteriaText: string;
  studentGender: 'male' | 'female' | null;
  isPrintingBlank?: boolean;
}

const SectionCard: React.FC<SectionCardProps> = ({ 
  title, id, questions, isExpanded, onToggle, showAnswers, studentAnswers, results,
  onAnswerChange, onResultChange, startIndex, onBloomClick, loadingBloom, onFocus, isFocused, successCriteriaText, studentGender, isPrintingBlank
}) => {
  const [bloomOpen, setBloomOpen] = useState(false);
  const [targetCount, setTargetCount] = useState(3);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());

  const toggleReveal = (qId: string) => {
    setRevealedIds(prev => {
      const next = new Set(prev);
      if (next.has(qId)) next.delete(qId);
      else next.add(qId);
      return next;
    });
  };

  const calculateScore = () => {
    let current = 0;
    let total = 0;
    questions.forEach((q, i) => {
      const qId = `${id}-${i}`;
      const isMCQ = q.options && q.options.length > 0;
      const points = isMCQ ? 1 : 2;
      total += points;
      if (isMCQ) {
        if (studentAnswers[qId] === q.answer) current += points;
      } else {
        if (results[qId] === true) current += points;
      }
    });
    return { current, total };
  };

  const { current, total } = calculateScore();
  const allRevealed = questions.length > 0 && questions.every((_, i) => revealedIds.has(`${id}-${i}`));
  
  return (
    <div className={`border rounded-xl overflow-hidden shadow-sm transition-all break-inside-avoid ${isFocused ? 'ring-4 ring-indigo-200 border-indigo-500' : 'border-gray-200'}`}>
      <div className="w-full flex items-center justify-between p-5 bg-gray-50 no-print">
        <div className="flex items-center gap-4">
          <button onClick={onToggle} className="text-xl font-bold text-gray-800 flex items-center gap-3">
            <span className={`transform transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
            {title}
          </button>
          {!isFocused && (
            <button onClick={onFocus} className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-1 rounded">تركيز</button>
          )}
        </div>
        {!isPrintingBlank && (
          <div className="bg-indigo-600 text-white px-3 py-1 rounded-full text-xs font-black shadow-inner">
            النتيجة: {current} / {total}
          </div>
        )}
      </div>

      <div className={`${isExpanded ? 'p-6' : 'h-0 overflow-hidden'} transition-all bg-white print:h-auto print:p-6`}>
        <div className="space-y-16">
          {questions.map((q, i) => {
            const qId = `${id}-${i}`;
            const isMCQ = q.options && q.options.length > 0;
            return (
              <QuestionItem
                key={qId}
                q={q}
                index={startIndex + i}
                qId={qId}
                showAnswers={showAnswers}
                studentAnswer={studentAnswers[qId] || ''}
                isCorrect={isMCQ ? (studentAnswers[qId] === q.answer) : (results[qId] ?? null)}
                successCriteriaText={successCriteriaText}
                onAnswerChange={(val) => onAnswerChange(qId, val)}
                onMarkCorrect={(res) => onResultChange(qId, res)}
                isVisible={isPrintingBlank ? false : (showAnswers || revealedIds.has(qId))}
                onToggleReveal={() => toggleReveal(qId)}
                studentGender={studentGender}
              />
            );
          })}
        </div>

        {allRevealed && questions.length > 0 && !isPrintingBlank && (
          <div className="mt-12 p-8 bg-indigo-900 text-white rounded-2xl shadow-2xl text-center space-y-4 animate-in zoom-in-90 duration-500 no-print">
            <h4 className="text-2xl font-bold">نتيجة {title}</h4>
            <div className="flex justify-center items-baseline gap-2">
              <span className="text-6xl font-black text-indigo-300">{current}</span>
              <span className="text-2xl opacity-50">/ {total}</span>
            </div>
          </div>
        )}

        <div className="mt-16 pt-8 border-t-2 border-indigo-50 no-print">
          <button 
            onClick={() => setBloomOpen(!bloomOpen)}
            className="flex items-center gap-3 text-indigo-700 font-bold text-lg hover:bg-indigo-50 p-3 rounded-xl transition-all group"
          >
            <span className={`bg-indigo-100 p-1 rounded transition-transform duration-300 ${bloomOpen ? 'rotate-90' : ''}`}>
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </span>
            توسيع "سلّم بلوم" بأسئلة إضافية لهذا المستوى
          </button>
          
          {bloomOpen && (
            <div className="mt-6 p-6 bg-indigo-50/30 rounded-2xl border-2 border-dashed border-indigo-100 animate-in zoom-in-95 duration-300">
              <div className="flex flex-col md:flex-row items-center justify-between gap-6 mb-8">
                <p className="text-base font-bold text-gray-800">توليد تلقائي حسب مستويات بلوم:</p>
                <div className="flex items-center gap-3 bg-white p-3 rounded-2xl border shadow-sm px-6">
                  <label className="text-sm font-bold text-indigo-700">العدد:</label>
                  <input type="number" min="1" max="10" value={targetCount} onChange={(e) => setTargetCount(parseInt(e.target.value) || 1)} className="w-16 p-2 border-2 border-indigo-50 rounded-xl text-center font-bold" />
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                {BLOOM_LEVELS.map((lvl) => (
                  <button key={lvl.id} disabled={!!loadingBloom} onClick={() => onBloomClick(lvl, targetCount)} className={`group relative flex flex-col items-center p-5 rounded-2xl transition-all ${lvl.color} text-white shadow-lg disabled:opacity-50`}>
                    <span className="text-3xl mb-2">{lvl.icon}</span>
                    <span className="text-sm font-bold">{lvl.label}</span>
                    {loadingBloom === `${id}-${lvl.id}` && (
                      <div className="absolute inset-0 bg-black/20 rounded-2xl flex items-center justify-center">
                        <div className="w-8 h-8 border-4 border-white border-t-transparent rounded-full animate-spin"></div>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;
