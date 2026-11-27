// Taker: checks a CTF flag against the salted hash and logs every guess (the guess itself is not stored).
// 10 wrong guesses per question, then a 60-second cooldown. Never returns the flag or hash.
import { adminClient, parseBody, requireCaller, z } from "../_shared/auth.ts";
import { HttpError, serve } from "../_shared/http.ts";
import { openAttemptFor } from "../_shared/attempts.ts";

const WRONG_LIMIT = 10;
const COOLDOWN_MS = 60_000;

const Body = z.object({
  question_id: z.string().uuid(),
  flag: z.string().trim().min(1).max(200),
});

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

serve("check_flag", async (req, body) => {
  const caller = await requireCaller(req, ["taker"]);
  const input = parseBody(Body, body);
  const db = adminClient();

  const { data: q, error: qErr } = await db.from("questions").select("id, type, test_id").eq("id", input.question_id).maybeSingle();
  if (qErr) throw new Error(qErr.message);
  if (!q || q.type !== "ctf") throw new HttpError(404, "ctf question not found");

  const attempt = await openAttemptFor(db, caller.id, q.test_id);

  const { data: log, error: lErr } = await db
    .from("flag_attempts")
    .select("result, created_at")
    .eq("attempt_id", attempt.id)
    .eq("question_id", q.id)
    .order("created_at", { ascending: true });
  if (lErr) throw new Error(lErr.message);

  if (log.some((r) => r.result === "correct")) return { correct: true, already_captured: true };

  const wrong = log.filter((r) => r.result === "wrong");
  if (wrong.length > 0 && wrong.length % WRONG_LIMIT === 0) {
    const last = new Date(wrong[wrong.length - 1].created_at).getTime();
    const waitMs = last + COOLDOWN_MS - Date.now();
    if (waitMs > 0) {
      await db.from("flag_attempts").insert({ attempt_id: attempt.id, question_id: q.id, result: "rate_limited" });
      throw new HttpError(429, "too many wrong guesses; wait before trying again", {
        retry_after_seconds: Math.ceil(waitMs / 1000),
      });
    }
  }

  const { data: key, error: kErr } = await db
    .from("question_keys")
    .select("flag_hash, flag_salt")
    .eq("question_id", q.id)
    .maybeSingle();
  if (kErr) throw new Error(kErr.message);
  if (!key?.flag_hash || !key.flag_salt) throw new HttpError(409, "this challenge has no flag set yet; tell the admin");

  const correct = constantTimeEqual(await sha256Hex(key.flag_salt + input.flag), key.flag_hash);
  const { error: iErr } = await db
    .from("flag_attempts")
    .insert({ attempt_id: attempt.id, question_id: q.id, result: correct ? "correct" : "wrong" });
  if (iErr) throw new Error(iErr.message);

  const wrongCount = wrong.length + (correct ? 0 : 1);
  return {
    correct,
    wrong_guesses: wrongCount,
    guesses_before_cooldown: correct ? null : WRONG_LIMIT - (wrongCount % WRONG_LIMIT || WRONG_LIMIT),
  };
});
