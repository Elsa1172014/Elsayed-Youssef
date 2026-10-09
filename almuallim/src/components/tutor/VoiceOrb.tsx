import type { Activity, VoicePhase } from "@/lib/voice/client";

export type OrbMode = "idle" | "connecting" | "listening" | "user-speaking" | "thinking" | "speaking" | "muted" | "error";

export function orbMode(phase: VoicePhase, activity: Activity | null, muted: boolean): OrbMode {
  if (phase === "error") return "error";
  if (phase === "requesting-mic" || phase === "fetching-token" || phase === "connecting" || phase === "reconnecting") return "connecting";
  if (phase !== "live") return "idle";
  if (muted) return "muted";
  if (activity === "user-speaking") return "user-speaking";
  if (activity === "model-speaking") return "speaking";
  if (activity === "thinking") return "thinking";
  return "listening";
}

const LABEL: Record<OrbMode, string> = {
  idle: "المحادثة الصوتية متوقفة", connecting: "جارٍ الاتصال…", listening: "أستمع إليك", "user-speaking": "أسمعك…",
  thinking: "أفكّر…", speaking: "المعلّم يتحدث", muted: "الميكروفون مكتوم", error: "حدث خطأ",
};
export const orbLabel = (m: OrbMode) => LABEL[m];

/** The animated voice orb. Animation is driven by the real session state (not decorative randomness). */
export function VoiceOrb({ mode }: { mode: OrbMode }) {
  return (
    <div className={`orb orb-${mode}`} role="img" aria-label={LABEL[mode]} data-mode={mode}>
      <span className="orb-ring orb-ring-1" aria-hidden />
      <span className="orb-ring orb-ring-2" aria-hidden />
      <span className="orb-core" aria-hidden>
        <span className="orb-bars" aria-hidden>
          <i /><i /><i /><i /><i />
        </span>
      </span>
    </div>
  );
}
