import { z } from "zod";

export const MODES = ["explain", "socratic", "practice", "assessment", "review"] as const;
export const LEVELS = ["support", "core", "challenge"] as const;
export const SKILLS = ["grammar", "vocabulary", "rhetoric", "comprehension", "writing", "reading_aloud"] as const;

export const modeSchema = z.enum(MODES);
export const levelSchema = z.enum(LEVELS);
export const skillSchema = z.enum(SKILLS);
export type Mode = z.infer<typeof modeSchema>;
export type Level = z.infer<typeof levelSchema>;
export type Skill = z.infer<typeof skillSchema>;

/** Everything the tutor knows about the situation. Built server-side from the DB — never trusted from the client. */
export interface TutorContext {
  sessionId: string;
  studentId: string;
  yearGroup: number | null;
  mode: Mode;
  level: Level;
  versionId: string | null;
  lessonId: string | null;
  lessonTitle: string | null;
  currentPage: number | null;
  objective: string | null;
  /** AI estimates (never teacher grades) per skill, 0..1, used only to pick difficulty. */
  mastery: Partial<Record<Skill, { estimate: number; evidence: number }>>;
}

export const MODE_LABEL_AR: Record<Mode, string> = {
  explain: "اشرح لي",
  socratic: "حوار موجَّه",
  practice: "تدريب",
  assessment: "تقييم",
  review: "مراجعة",
};
