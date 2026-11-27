// Scoring shared by submit_attempt, grade_written and override_grade.
// Every score is written here with the service role. Hint costs are subtracted from the
// question's score for every type, and a score never goes below 0.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.2";
import { gradeWithAI } from "./openai.ts";

interface Question {
  id: string;
  type: "mcq" | "short" | "bughunt" | "ctf";
  prompt: string;
  points: number;
}

interface Key {
  question_id: string;
  correct: unknown;
  rubric: string | null;
  model_answer: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function must<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data as T;
}

/** Sum of revealed hint costs per question for one attempt. */
export async function hintPenalties(db: SupabaseClient, attemptId: string): Promise<Map<string, number>> {
  const rows = await must<{ hints: { question_id: string; cost_points: number } | null }[]>(
    db.from("hint_reveals").select("hints(question_id, cost_points)").eq("attempt_id", attemptId),
    "load hint reveals",
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.hints) continue;
    map.set(r.hints.question_id, (map.get(r.hints.question_id) ?? 0) + r.hints.cost_points);
  }
  return map;
}

async function upsertGrade(db: SupabaseClient, row: Record<string, unknown>) {
  await must(db.from("grades").upsert(row, { onConflict: "attempt_id,question_id" }).select("id"), "save grade");
}

function sameSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const sa = new Set(a.map(String));
  const sb = new Set(b.map(String));
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/** Auto-grades mcq, bughunt and ctf questions for one attempt. */
async function gradeAutomatic(
  db: SupabaseClient,
  attemptId: string,
  questions: Question[],
  keys: Map<string, Key>,
  answers: Map<string, Record<string, unknown>>,
  penalties: Map<string, number>,
) {
  const ctfIds = questions.filter((q) => q.type === "ctf").map((q) => q.id);
  const captured = new Set<string>();
  if (ctfIds.length) {
    const rows = await must<{ question_id: string }[]>(
      db.from("flag_attempts").select("question_id").eq("attempt_id", attemptId).eq("result", "correct"),
      "load captures",
    );
    rows.forEach((r) => captured.add(r.question_id));
  }

  for (const q of questions) {
    if (q.type === "short") continue;
    const key = keys.get(q.id);
    const answer = answers.get(q.id);
    const penalty = penalties.get(q.id) ?? 0;
    let raw = 0;
    let feedback = "";
    let needsReview = false;

    if (q.type === "mcq") {
      if (!key || !Array.isArray(key.correct)) {
        needsReview = true;
        feedback = "No answer key set for this question.";
      } else if (!answer) {
        feedback = "Not answered.";
      } else {
        const ok = sameSet(answer.selected, key.correct);
        raw = ok ? q.points : 0;
        feedback = ok ? "Correct." : "Incorrect.";
      }
    } else if (q.type === "bughunt") {
      const keyLine = typeof key?.correct === "number" ? key.correct : Number(key?.correct);
      if (!key || !Number.isInteger(keyLine)) {
        needsReview = true;
        feedback = "No answer key set for this question.";
      } else if (!answer) {
        feedback = "Not answered.";
      } else {
        const ok = Number(answer.line) === keyLine;
        raw = ok ? q.points : 0;
        feedback = ok ? "You found the bug." : "That line is not the bug.";
      }
    } else if (q.type === "ctf") {
      const ok = captured.has(q.id);
      raw = ok ? q.points : 0;
      feedback = ok ? "Flag captured." : "Flag not captured.";
    }

    await upsertGrade(db, {
      attempt_id: attemptId,
      question_id: q.id,
      score: round2(Math.max(0, raw - penalty)),
      max_score: q.points,
      hint_penalty: penalty,
      feedback: penalty > 0 && raw > 0 ? `${feedback} Hints cost ${penalty} point(s).` : feedback,
      graded_by: "auto",
      ai_rationale: null,
      ai_met: null,
      ai_missed: null,
      needs_review: needsReview,
    });
  }
}

/**
 * AI-grades the short questions of one attempt (all of them, or only `onlyQuestionIds`).
 * Empty answers score 0 without an API call. On failure the grade is 0 with needs_review = true.
 */
export async function gradeWritten(db: SupabaseClient, attemptId: string, onlyQuestionIds?: string[]) {
  const attempt = await must<{ test_id: string }>(
    db.from("attempts").select("test_id").eq("id", attemptId).single(),
    "load attempt",
  );
  let qQuery = db.from("questions").select("id, type, prompt, points").eq("test_id", attempt.test_id).eq("type", "short");
  if (onlyQuestionIds?.length) qQuery = qQuery.in("id", onlyQuestionIds);
  const questions = await must<Question[]>(qQuery, "load questions");
  if (!questions.length) return { graded: 0, needs_review: 0 };

  const ids = questions.map((q) => q.id);
  const [keys, answers, penalties] = await Promise.all([
    must<Key[]>(db.from("question_keys").select("question_id, correct, rubric, model_answer").in("question_id", ids), "load keys"),
    must<{ question_id: string; response: Record<string, unknown> }[]>(
      db.from("answers").select("question_id, response").eq("attempt_id", attemptId).in("question_id", ids),
      "load answers",
    ),
    hintPenalties(db, attemptId),
  ]);
  const keyMap = new Map(keys.map((k) => [k.question_id, k]));
  const answerMap = new Map(answers.map((a) => [a.question_id, a.response]));

  const results = await Promise.all(questions.map(async (q) => {
    const text = String(answerMap.get(q.id)?.text ?? "").trim();
    const key = keyMap.get(q.id);
    const penalty = penalties.get(q.id) ?? 0;
    const base = { attempt_id: attemptId, question_id: q.id, max_score: q.points, hint_penalty: penalty, graded_by: "ai" };

    if (!text) {
      await upsertGrade(db, {
        ...base, score: 0, feedback: "No answer given.", ai_rationale: "No answer given.",
        ai_met: [], ai_missed: [], needs_review: false,
      });
      return false;
    }

    try {
      if (!key?.rubric) throw new Error("no rubric set");
      const ai = await gradeWithAI({
        question: q.prompt,
        rubric: key.rubric,
        modelAnswer: key.model_answer ?? "",
        maxPoints: q.points,
        answer: text,
      });
      await upsertGrade(db, {
        ...base,
        score: round2(Math.max(0, ai.score - penalty)),
        feedback: penalty > 0 ? `Hints cost ${penalty} point(s).` : null,
        ai_rationale: ai.rationale,
        ai_met: ai.met,
        ai_missed: ai.missed,
        needs_review: false,
      });
      return false;
    } catch (err) {
      console.error(`[grade_written] question ${q.id} failed: ${err instanceof Error ? err.message : "unknown"}`);
      await upsertGrade(db, {
        ...base, score: 0, feedback: "Automatic grading failed; an admin will review this answer.",
        ai_rationale: null, ai_met: null, ai_missed: null, needs_review: true,
      });
      return true;
    }
  }));

  return { graded: questions.length, needs_review: results.filter(Boolean).length };
}

/** Locks (if needed) and fully grades one attempt. */
export async function submitAndGrade(db: SupabaseClient, attemptId: string) {
  // Lock first so no further answers can be written, then grade.
  const { data: locked, error } = await db
    .from("attempts")
    .update({ status: "submitted", submitted_at: new Date().toISOString() })
    .eq("id", attemptId)
    .eq("status", "in_progress")
    .select("id, test_id")
    .maybeSingle();
  if (error) throw new Error(`lock attempt: ${error.message}`);
  if (!locked) return { already: true };

  const questions = await must<Question[]>(
    db.from("questions").select("id, type, prompt, points").eq("test_id", locked.test_id),
    "load questions",
  );
  const ids = questions.map((q) => q.id);
  const [keys, answers, penalties] = await Promise.all([
    ids.length
      ? must<Key[]>(db.from("question_keys").select("question_id, correct, rubric, model_answer").in("question_id", ids), "load keys")
      : Promise.resolve([] as Key[]),
    must<{ question_id: string; response: Record<string, unknown> }[]>(
      db.from("answers").select("question_id, response").eq("attempt_id", attemptId),
      "load answers",
    ),
    hintPenalties(db, attemptId),
  ]);

  await gradeAutomatic(
    db,
    attemptId,
    questions,
    new Map(keys.map((k) => [k.question_id, k])),
    new Map(answers.map((a) => [a.question_id, a.response])),
    penalties,
  );
  const written = await gradeWritten(db, attemptId);

  await must(db.from("attempts").update({ status: "graded" }).eq("id", attemptId).select("id"), "mark graded");
  return { already: false, needs_review: written.needs_review };
}
