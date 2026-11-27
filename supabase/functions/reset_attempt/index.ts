// Admin: removes an attempt and everything under it (answers, grades, flag guesses, hint reveals),
// so the taker can start the test again.
import { adminClient, parseBody, requireCaller, z } from "../_shared/auth.ts";
import { HttpError, serve } from "../_shared/http.ts";

const Body = z.object({ attempt_id: z.string().uuid() });

serve("reset_attempt", async (req, body) => {
  await requireCaller(req, ["admin"]);
  const { attempt_id } = parseBody(Body, body);
  const { data, error } = await adminClient().from("attempts").delete().eq("id", attempt_id).select("id");
  if (error) throw new Error(error.message);
  if (!data.length) throw new HttpError(404, "attempt not found");
  return { deleted: attempt_id };
});
