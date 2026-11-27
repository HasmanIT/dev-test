// Admin: sets a question's answer key. For CTF, takes the plain flag and stores only
// sha256(salt + flag) with a random salt. The plain flag is never stored or logged.
import { adminClient, parseBody, requireCaller, z } from "../_shared/auth.ts";
import { HttpError, serve } from "../_shared/http.ts";

const Body = z.object({
  question_id: z.string().uuid(),
  correct: z.union([z.array(z.string().min(1).max(20)).max(26), z.number().int().min(1).max(500), z.null()]).optional(),
  rubric: z.string().max(4000).nullable().optional(),
  model_answer: z.string().max(4000).nullable().optional(),
  flag: z.string().trim().min(1).max(200).optional(),
});

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function hashFlag(salt: string, flag: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + flag));
  return hex(new Uint8Array(digest));
}

serve("set_question_key", async (req, body) => {
  await requireCaller(req, ["admin"]);
  const input = parseBody(Body, body);
  const db = adminClient();

  const { data: q, error: qErr } = await db.from("questions").select("id, type").eq("id", input.question_id).maybeSingle();
  if (qErr) throw new Error(qErr.message);
  if (!q) throw new HttpError(404, "question not found");
  if (input.flag !== undefined && q.type !== "ctf") throw new HttpError(400, "flags can only be set on ctf questions");

  const row: Record<string, unknown> = { question_id: q.id };
  if (input.correct !== undefined) row.correct = input.correct;
  if (input.rubric !== undefined) row.rubric = input.rubric;
  if (input.model_answer !== undefined) row.model_answer = input.model_answer;
  if (input.flag !== undefined) {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    row.flag_salt = salt;
    row.flag_hash = await hashFlag(salt, input.flag);
  }

  const { error } = await db.from("question_keys").upsert(row, { onConflict: "question_id" });
  if (error) throw new Error(error.message);
  return { ok: true, flag_set: input.flag !== undefined };
});
