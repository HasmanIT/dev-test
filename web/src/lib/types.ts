export type Role = "admin" | "taker";
export type QuestionType = "mcq" | "short" | "bughunt" | "ctf";
export type TestStatus = "draft" | "open" | "closed";
export type AttemptStatus = "in_progress" | "submitted" | "graded";

export interface Profile {
  id: string;
  display_name: string;
  email: string;
  role: Role;
  created_at: string;
}

export interface Test {
  id: string;
  title: string;
  description: string;
  duration_minutes: number;
  status: TestStatus;
  results_visible: boolean;
  created_at: string;
  updated_at: string;
}

export interface Choice {
  id: string;
  text: string;
}

export interface QuestionOptions {
  choices?: Choice[];
  multiple?: boolean;
  code?: string;
  language?: string;
}

export interface Question {
  id: string;
  test_id: string;
  position: number;
  type: QuestionType;
  prompt: string;
  points: number;
  options: QuestionOptions;
  repo_url: string | null;
}

export interface QuestionKey {
  question_id: string;
  correct: string[] | number | null;
  rubric: string | null;
  model_answer: string | null;
  flag_hash: string | null;
}

export interface Hint {
  id: string;
  question_id: string;
  position: number;
  text: string;
  cost_points: number;
}

export interface MyHint {
  hint_id: string;
  question_id: string;
  position: number;
  cost_points: number;
  revealed: boolean;
  text: string | null;
}

export interface Attempt {
  id: string;
  test_id: string;
  user_id: string;
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  status: AttemptStatus;
}

export type Response = { selected?: string[]; text?: string; line?: number };

export interface Answer {
  attempt_id: string;
  question_id: string;
  response: Response;
  updated_at?: string;
}

export interface Grade {
  id: string;
  attempt_id: string;
  question_id: string;
  score: number;
  max_score: number;
  hint_penalty: number;
  feedback: string | null;
  graded_by: "auto" | "ai" | "admin";
  ai_rationale: string | null;
  ai_met: string[] | null;
  ai_missed: string[] | null;
  needs_review: boolean;
  updated_at: string;
}

export const TYPE_LABELS: Record<QuestionType, string> = {
  mcq: "Quick-fire",
  short: "Short answer",
  bughunt: "Bug hunt",
  ctf: "Capture the flag",
};
