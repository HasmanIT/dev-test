import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.2";
import { HttpError } from "./http.ts";

export const GRACE_MS = 10_000;

/**
 * The caller's in-progress attempt on a test, required to be before the deadline (+10 s grace).
 * A partial unique index guarantees at most one in-progress attempt per taker and test.
 */
export async function openAttemptFor(db: SupabaseClient, userId: string, testId: string) {
  const { data: attempt, error } = await db
    .from("attempts")
    .select("id, status, deadline_at")
    .eq("test_id", testId)
    .eq("user_id", userId)
    .eq("status", "in_progress")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!attempt) throw new HttpError(409, "you have no attempt in progress on this test");
  if (Date.now() > new Date(attempt.deadline_at).getTime() + GRACE_MS) throw new HttpError(409, "the deadline has passed");
  return attempt as { id: string; status: string; deadline_at: string };
}
