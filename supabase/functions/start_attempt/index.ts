// Taker: starts an open test. The server sets deadline_at = now + duration; one attempt per test.
import { adminClient, parseBody, requireCaller, z } from "../_shared/auth.ts";
import { HttpError, serve } from "../_shared/http.ts";

const Body = z.object({ test_id: z.string().uuid() });

serve("start_attempt", async (req, body) => {
  const caller = await requireCaller(req, ["taker"]);
  const { test_id } = parseBody(Body, body);
  const db = adminClient();

  const { data: test, error: tErr } = await db.from("tests").select("id, status, duration_minutes").eq("id", test_id).maybeSingle();
  if (tErr) throw new Error(tErr.message);
  if (!test || test.status !== "open") throw new HttpError(409, "this test is not open");

  const now = new Date();
  const deadline = new Date(now.getTime() + test.duration_minutes * 60_000);
  const { data: attempt, error } = await db
    .from("attempts")
    .insert({ test_id, user_id: caller.id, started_at: now.toISOString(), deadline_at: deadline.toISOString() })
    .select("id, test_id, started_at, deadline_at, submitted_at, status")
    .single();
  if (error) {
    if (error.code === "23505") throw new HttpError(409, "you have already started this test");
    throw new Error(error.message);
  }
  return { attempt, server_now: now.toISOString() };
});
