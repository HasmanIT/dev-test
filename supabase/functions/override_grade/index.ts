// Admin: overrides one question's score. Sets graded_by = admin and keeps the AI rationale visible.
import { adminClient, parseBody, requireCaller, z } from "../_shared/auth.ts";
import { HttpError, serve } from "../_shared/http.ts";

const Body = z.object({
  attempt_id: z.string().uuid(),
  question_id: z.string().uuid(),
  score: z.number().min(0).max(1000),
  feedback: z.string().max(2000).nullable().optional(),
});

serve("override_grade", async (req, body) => {
  await requireCaller(req, ["admin"]);
  const input = parseBody(Body, body);
  const db = adminClient();

  const { data: attempt, error: aErr } = await db.from("attempts").select("id, test_id, status").eq("id", input.attempt_id).maybeSingle();
  if (aErr) throw new Error(aErr.message);
  if (!attempt) throw new HttpError(404, "attempt not found");
  if (attempt.status === "in_progress") throw new HttpError(409, "attempt has not been submitted");

  const { data: q, error: qErr } = await db.from("questions").select("id, points, test_id").eq("id", input.question_id).maybeSingle();
  if (qErr) throw new Error(qErr.message);
  if (!q || q.test_id !== attempt.test_id) throw new HttpError(404, "question not found in this attempt's test");

  const score = Math.min(q.points, Math.round(input.score * 100) / 100);
  const row: Record<string, unknown> = {
    attempt_id: attempt.id,
    question_id: q.id,
    score,
    max_score: q.points,
    graded_by: "admin",
    needs_review: false,
  };
  if (input.feedback !== undefined) row.feedback = input.feedback;

  // Upsert touches only these columns, so ai_rationale / ai_met / ai_missed are kept.
  const { data, error } = await db.from("grades").upsert(row, { onConflict: "attempt_id,question_id" }).select().single();
  if (error) throw new Error(error.message);
  return { grade: data };
});
