export interface RecognitionCandidate {
  pageNumber: number;
  printedLabel: string | null;
  lessonTitle: string | null;
  score: number;
  printedNumberMatch: boolean;
}

export type RecognitionResult =
  | { status: "no_page" }
  | { status: "matched"; decision: "confident" | "ambiguous" | "none"; confidence: number; reason: string; candidates: RecognitionCandidate[] };

export interface ConfirmedPage {
  pageNumber: number;
  printedLabel: string | null;
  lessonId: string | null;
  lessonTitle: string | null;
  bookTitle: string;
  objectives: string[];
}
