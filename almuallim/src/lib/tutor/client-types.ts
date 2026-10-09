import type { TranscriptEntry } from "@/lib/voice/client";
import type { VerifiedAnswer } from "./answer";
import type { Level, Mode } from "./types";

export interface BookOption {
  versionId: string;
  title: string;
  lessons: { id: string; title: string; unit: string | null; startPage: number; endPage: number }[];
}

export type ChatMessage =
  | { id: string; role: "student"; text: string; via: "text" | "voice" }
  | { id: string; role: "tutor"; answer: VerifiedAnswer; via: "text" | "voice" }
  | { id: string; role: "tutor-text"; text: string; via: "voice"; final: boolean; interrupted?: boolean }
  | { id: string; role: "system"; text: string };

export interface SessionState {
  id: string;
  mode: Mode;
  level: Level;
  versionId: string | null;
  lessonId: string | null;
}

/**
 * Fold live voice transcript entries into the chat log (upsert by id so streaming assistant text updates in
 * place). Entries keep their arrival order relative to text messages.
 */
export function mergeVoiceTranscript(prev: ChatMessage[], entries: TranscriptEntry[]): ChatMessage[] {
  const out = [...prev];
  for (const e of entries) {
    const idx = out.findIndex((m) => m.id === e.id);
    const msg: ChatMessage =
      e.role === "user"
        ? { id: e.id, role: "student", text: e.text, via: "voice" }
        : { id: e.id, role: "tutor-text", text: e.text, via: "voice", final: e.final, interrupted: e.interrupted };
    if (idx >= 0) out[idx] = msg;
    else out.push(msg);
  }
  return out;
}
