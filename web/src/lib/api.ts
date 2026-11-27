import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export class ApiError extends Error {
  constructor(message: string, public status: number, public details: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Calls an Edge Function and returns its JSON, or throws ApiError with the server's message. */
export async function callFn<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const res = error.context as globalThis.Response;
      let payload: Record<string, unknown> = {};
      try {
        payload = await res.json();
      } catch {
        /* not JSON */
      }
      const fields = Array.isArray(payload.fields) ? ` (${(payload.fields as string[]).join("; ")})` : "";
      throw new ApiError(String(payload.error ?? `Request failed (${res.status})`) + fields, res.status, payload);
    }
    throw new ApiError(error.message || "Network error", 0);
  }
  return data as T;
}

/** Throws a readable error for a failed Supabase query; returns data otherwise. */
export function must<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Server time minus browser time, in ms, so countdowns ignore a wrong browser clock. */
export async function clockOffset(): Promise<number> {
  const before = Date.now();
  const { data, error } = await supabase.rpc("server_now");
  const after = Date.now();
  if (error || !data) return 0;
  return new Date(data as string).getTime() - (before + after) / 2;
}
