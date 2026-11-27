import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.2";
import { HttpError } from "./http.ts";

export const GRACE_MS = 10_000;

/** The caller's attempt on a test, required to be in progress and before the deadline (+10 s grace). */
export async function openAttemptFor(db: SupabaseClient, userId: string, testId: string) {
  const { data: attempt, error } = await db
    .from("attempts")
    .select("id, status, deadline_at")
    .eq("test_id", testId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!attempt) throw new HttpError(403, "you have not started this test");
  if (attempt.status !== "in_progress") throw new HttpError(409, "this attempt has been submitted");
  if (Date.now() > new Date(attempt.deadline_at).getTime() + GRACE_MS) throw new HttpError(409, "the deadline has passed");
  return attempt as { id: string; status: string; deadline_at: string };
}
