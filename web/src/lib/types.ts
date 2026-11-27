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
  /** How many attempts each taker gets; null = unlimited. */
  max_attempts: number | null;
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
  attempt_number: number;
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

/** Why a taker can or can't start another attempt (mirrors start_attempt's rules). */
export type StartState = "start" | "continue" | "retake" | "wait_for_results" | "no_attempts_left" | "closed";

export function startState(test: Test, attempts: Attempt[], isTaker: boolean): StartState {
  if (attempts.some((a) => a.status === "in_progress")) return "continue";
  if (!isTaker || test.status !== "open") return "closed";
  if (test.max_attempts !== null && attempts.length >= test.max_attempts) return "no_attempts_left";
  if (attempts.length === 0) return "start";
  return test.results_visible ? "retake" : "wait_for_results";
}

export function attemptsLabel(test: Pick<Test, "max_attempts">): string {
  if (test.max_attempts === null) return "unlimited attempts";
  return test.max_attempts === 1 ? "1 attempt" : `${test.max_attempts} attempts`;
}
