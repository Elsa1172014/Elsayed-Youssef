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
  | { id: string; role: "tutor-text"; text: string; via: "voice" }
  | { id: string; role: "system"; text: string };

export interface SessionState {
  id: string;
  mode: Mode;
  level: Level;
  versionId: string | null;
  lessonId: string | null;
}
