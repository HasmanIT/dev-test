// Admin: re-runs AI grading of short answers for one attempt (optionally one question).
// submit_attempt runs the same grader in-process for new submissions.
import { adminClient, parseBody, requireCaller, z } from "../_shared/auth.ts";
import { HttpError, serve } from "../_shared/http.ts";
import { gradeWritten } from "../_shared/grading.ts";

const Body = z.object({
  attempt_id: z.string().uuid(),
  question_id: z.string().uuid().optional(),
});

serve("grade_written", async (req, body) => {
  await requireCaller(req, ["admin"]);
  const input = parseBody(Body, body);
  const db = adminClient();

  const { data: attempt, error } = await db.from("attempts").select("id, status").eq("id", input.attempt_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!attempt) throw new HttpError(404, "attempt not found");
  if (attempt.status === "in_progress") throw new HttpError(409, "attempt has not been submitted");

  return await gradeWritten(db, attempt.id, input.question_id ? [input.question_id] : undefined);
});
