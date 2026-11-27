import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.2";
import { z } from "npm:zod@4.6.7";
import { HttpError } from "./http.ts";

export type Role = "admin" | "taker";
export interface Caller {
  id: string;
  role: Role;
}

function serviceKey(): string {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return key;
}

function anonKey(): string {
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!key) throw new Error("SUPABASE_ANON_KEY is not set");
  return key;
}

let cachedAdmin: SupabaseClient | null = null;

/** Service-role client. Bypasses RLS: use only after the caller's role has been checked. */
export function adminClient(): SupabaseClient {
  if (!cachedAdmin) {
    cachedAdmin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cachedAdmin;
}

/** Verifies the caller's JWT with Supabase Auth and loads their role from profiles. */
export async function requireCaller(req: Request, allowed: Role[]): Promise<Caller> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new HttpError(401, "missing bearer token");

  const authClient = createClient(Deno.env.get("SUPABASE_URL")!, anonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "invalid or expired token");

  const { data: profile, error: pErr } = await adminClient()
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (pErr) throw new Error(`profile lookup failed: ${pErr.message}`);
  if (!profile) throw new HttpError(403, "no profile");

  const role = profile.role as Role;
  if (!allowed.includes(role)) throw new HttpError(403, "forbidden");
  return { id: data.user.id, role };
}

/** Validates a request body with Zod and returns a 400 listing the bad fields (never their values). */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fields = result.error.issues.map((i) => `${i.path.map(String).join(".") || "(body)"}: ${i.message}`);
    throw new HttpError(400, "invalid input", { fields });
  }
  return result.data;
}

export { z };
