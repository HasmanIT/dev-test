// Taker: starts an attempt on an open test. The server sets deadline_at = now + duration.
// Multiple attempts: tests.max_attempts caps them (NULL = unlimited). Only one attempt can be in
// progress at a time, and a retake unlocks only once the test's results have been released.
import { adminClient, parseBody, requireCaller, z } from "../_shared/auth.ts";
import { HttpError, serve } from "../_shared/http.ts";

const Body = z.object({ test_id: z.string().uuid() });

serve("start_attempt", async (req, body) => {
  const caller = await requireCaller(req, ["taker"]);
  const { test_id } = parseBody(Body, body);
  const db = adminClient();

  const { data: test, error: tErr } = await db
    .from("tests")
    .select("id, status, duration_minutes, max_attempts, results_visible")
    .eq("id", test_id)
    .maybeSingle();
  if (tErr) throw new Error(tErr.message);
  if (!test || test.status !== "open") throw new HttpError(409, "this test is not open");

  const { data: previous, error: pErr } = await db
    .from("attempts")
    .select("attempt_number, status")
    .eq("test_id", test_id)
    .eq("user_id", caller.id);
  if (pErr) throw new Error(pErr.message);

  if (previous.some((a) => a.status === "in_progress")) {
    throw new HttpError(409, "you already have an attempt in progress", { reason: "in_progress" });
  }
  if (test.max_attempts !== null && previous.length >= test.max_attempts) {
    throw new HttpError(409, test.max_attempts === 1 ? "you have already taken this test" : "you have used all your attempts", {
      reason: "no_attempts_left",
    });
  }
  if (previous.length > 0 && !test.results_visible) {
    throw new HttpError(409, "you can retake this test once your results are released", { reason: "results_not_released" });
  }

  const attemptNumber = previous.reduce((m, a) => Math.max(m, a.attempt_number), 0) + 1;
  const now = new Date();
  const deadline = new Date(now.getTime() + test.duration_minutes * 60_000);
  const { data: attempt, error } = await db
    .from("attempts")
    .insert({
      test_id,
      user_id: caller.id,
      attempt_number: attemptNumber,
      started_at: now.toISOString(),
      deadline_at: deadline.toISOString(),
    })
    .select("id, test_id, attempt_number, started_at, deadline_at, submitted_at, status")
    .single();
  if (error) {
    // Two starts at once: the unique indexes let only one through.
    if (error.code === "23505") throw new HttpError(409, "you already have an attempt in progress", { reason: "in_progress" });
    throw new Error(error.message);
  }
  return { attempt, server_now: now.toISOString() };
});
