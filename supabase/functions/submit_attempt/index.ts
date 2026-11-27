// Taker: submits (locks) their own attempt and grades it: mcq, bughunt and ctf automatically,
// short answers with grade_written. Works after the deadline too (auto-submit).
// Admin: submits any attempt, or every overdue attempt of a test ({ test_id, overdue_only: true })
// so attempts abandoned in a closed browser still get graded.
import { adminClient, parseBody, requireCaller, z } from "../_shared/auth.ts";
import { HttpError, serve } from "../_shared/http.ts";
import { GRACE_MS } from "../_shared/attempts.ts";
import { submitAndGrade } from "../_shared/grading.ts";

const Body = z.union([
  z.object({ attempt_id: z.string().uuid() }),
  z.object({ test_id: z.string().uuid(), overdue_only: z.literal(true) }),
]);

serve("submit_attempt", async (req, body) => {
  const caller = await requireCaller(req, ["taker", "admin"]);
  const input = parseBody(Body, body);
  const db = adminClient();

  if ("attempt_id" in input) {
    const { data: attempt, error } = await db.from("attempts").select("id, user_id").eq("id", input.attempt_id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!attempt || (caller.role !== "admin" && attempt.user_id !== caller.id)) throw new HttpError(404, "attempt not found");
    const result = await submitAndGrade(db, attempt.id);
    return { attempt_id: attempt.id, ...result };
  }

  if (caller.role !== "admin") throw new HttpError(403, "forbidden");
  const cutoff = new Date(Date.now() - GRACE_MS).toISOString();
  const { data: overdue, error } = await db
    .from("attempts")
    .select("id")
    .eq("test_id", input.test_id)
    .eq("status", "in_progress")
    .lt("deadline_at", cutoff);
  if (error) throw new Error(error.message);
  const results = [];
  for (const a of overdue) results.push({ attempt_id: a.id, ...(await submitAndGrade(db, a.id)) });
  return { submitted: results.length, results };
});
