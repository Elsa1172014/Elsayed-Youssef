"use client";
import { VOICE_ERROR_MESSAGE_AR, type VoiceState } from "@/lib/voice/client";
import { orbLabel, orbMode, VoiceOrb } from "./VoiceOrb";

interface Props {
  state: VoiceState;
  supported: boolean;
  onStart: () => void;
  onStop: () => void;
  onMute: (muted: boolean) => void;
  onInterrupt: () => void;
  disabled?: boolean;
}

const BUSY = new Set(["requesting-mic", "fetching-token", "connecting"]);

export function VoicePanel({ state, supported, onStart, onStop, onMute, onInterrupt, disabled }: Props) {
  const mode = orbMode(state.phase, state.activity, state.muted);
  const live = state.phase === "live" || state.phase === "reconnecting";
  const busy = BUSY.has(state.phase);
  const btn = "rounded-xl px-4 py-2 text-sm font-semibold ring-1 ring-line disabled:opacity-50";

  return (
    <section aria-label="المحادثة الصوتية" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
      <VoiceOrb mode={mode} />
      <p role="status" aria-live="polite" className="text-center text-sm font-semibold">
        {state.phase === "reconnecting" ? `انقطع الاتصال — جارٍ إعادة المحاولة (${state.reconnectAttempt})…` : orbLabel(mode)}
      </p>

      {state.error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{VOICE_ERROR_MESSAGE_AR[state.error.code]}</p>
      )}
      {state.warning && <p className="text-xs text-warn">تنبيه: {state.warning}</p>}
      {!supported && (
        <p role="note" className="rounded-lg bg-accent/10 px-3 py-2 text-sm text-warn">{VOICE_ERROR_MESSAGE_AR.unsupported}</p>
      )}

      <div className="flex flex-wrap justify-center gap-2">
        {!live && !busy && (
          <button type="button" onClick={onStart} disabled={!supported || disabled} className={`${btn} bg-brand text-brand-ink`}>
            {state.phase === "error" || state.phase === "ended" ? "إعادة بدء المحادثة الصوتية" : "ابدأ المحادثة الصوتية"}
          </button>
        )}
        {busy && <button type="button" disabled className={`${btn} bg-bg`}>جارٍ التحضير…</button>}
        {live && (
          <>
            <button type="button" aria-pressed={state.muted} onClick={() => onMute(!state.muted)} className={`${btn} ${state.muted ? "bg-warn/20" : "bg-bg"}`}>
              {state.muted ? "إلغاء الكتم" : "كتم الميكروفون"}
            </button>
            <button type="button" onClick={onInterrupt} disabled={state.activity !== "model-speaking"} className={`${btn} bg-bg`}>
              أوقف المعلّم
            </button>
            <button type="button" onClick={onStop} className={`${btn} bg-danger/10 text-danger`}>إنهاء</button>
          </>
        )}
      </div>
      <p className="text-center text-xs text-muted">
        يمكنك مقاطعة المعلّم بالكلام في أي لحظة. في الفصل المزدحم استخدم سماعة رأس بميكروفون. على الجوال يتوقف الصوت عند قفل الشاشة. الكتابة متاحة دائمًا.
      </p>
    </section>
  );
}
