
export interface Question {
  type: string;
  question: string;
  answer: string;
  evidence: string;
  success_criteria: string;
  options?: string[]; // For multiple choice
}

export interface TextImage {
  url: string;
  idea: string;
}

export interface AssessmentData {
  meta: {
    title: string;
    grade: string;
    textType: string;
    skill: string;
    objective: string;
    criteria: string[];
    totalTime?: number; // Added for global timer
  };
  below: Question[];
  within: Question[];
  above: Question[];
  images?: TextImage[];
  rubric?: {
    category: string;
    levels: {
      name: string;
      description: string;
    }[];
  }[];
}

export interface AppState {
  grade: string;
  textType: string;
  skill: string;
  objective: string;
  criteria: string;
  countBelow: number;
  countWithin: number;
  countAbove: number;
  text: string;
  totalTime: number; // Added: Overall worksheet time in minutes
}

export type StudentAnswers = Record<string, string>;
