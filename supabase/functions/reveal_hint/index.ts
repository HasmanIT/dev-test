// Taker: reveals a hint for an in-progress attempt. Records the reveal once and returns the text.
import { adminClient, parseBody, requireCaller, z } from "../_shared/auth.ts";
import { HttpError, serve } from "../_shared/http.ts";
import { openAttemptFor } from "../_shared/attempts.ts";

const Body = z.object({ hint_id: z.string().uuid() });

serve("reveal_hint", async (req, body) => {
  const caller = await requireCaller(req, ["taker"]);
  const { hint_id } = parseBody(Body, body);
  const db = adminClient();

  const { data: hint, error: hErr } = await db
    .from("hints")
    .select("id, text, cost_points, question_id, questions(test_id)")
    .eq("id", hint_id)
    .maybeSingle();
  if (hErr) throw new Error(hErr.message);
  const testId = (hint?.questions as { test_id?: string } | null)?.test_id;
  if (!hint || !testId) throw new HttpError(404, "hint not found");

  const attempt = await openAttemptFor(db, caller.id, testId);

  const { error } = await db
    .from("hint_reveals")
    .upsert({ attempt_id: attempt.id, hint_id }, { onConflict: "attempt_id,hint_id", ignoreDuplicates: true });
  if (error) throw new Error(error.message);

  return { hint_id, question_id: hint.question_id, text: hint.text, cost_points: hint.cost_points };
});
