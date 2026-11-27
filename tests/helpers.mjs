// Shared helpers for the acceptance tests. They talk to a running Supabase (local or hosted):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// For a local stack, `npm run env` in this folder writes them to .env.test from `supabase status`.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const envFile = new URL("./.env.test", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

export const URL_ = process.env.SUPABASE_URL ?? process.env.API_URL;
export const ANON = process.env.SUPABASE_ANON_KEY ?? process.env.ANON_KEY;
export const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY;
// Edge Functions only accept browser requests from allowed origins; tests send none (like a server).
if (!URL_ || !ANON || !SERVICE) {
  throw new Error("Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (or create tests/.env.test).");
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
export const service = createClient(URL_, SERVICE, opts);

export const DEMO_TEST_ID = "d0000000-0000-4000-8000-000000000001";
export const DEMO_FLAGS = { "01": "FLAG{566722d04e14}", "02": "FLAG{48f1e3c3cb9a}" };
export const ALL_FLAGS = {
  "01-missing-paisa": "FLAG{566722d04e14}",
  "02-time-traveler": "FLAG{48f1e3c3cb9a}",
  "03-merge-mayhem": "FLAG{6b70e8b9a341}",
  "04-knock-knock": "FLAG{843a4158d56b}",
};

export function must({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

/** Creates a confirmed user and returns a signed-in client for them. */
export async function makeUser(role = "taker", name = "Test User") {
  const email = `t-${randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { display_name: name },
  });
  if (error) throw error;
  if (role === "admin") must(await service.from("profiles").update({ role: "admin" }).eq("id", data.user.id).select());
  return { id: data.user.id, email, password, client: await signIn(email, password) };
}

export async function signIn(email, password) {
  const client = createClient(URL_, ANON, opts);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

/** Calls an Edge Function as `client`; returns { status, body }. */
export async function fn(client, name, body) {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token ?? ANON;
  const res = await fetch(`${URL_}/functions/v1/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: json };
}

/** Creates an open test with one question of each type (service role). Returns ids. */
export async function makeTest({ status = "open", duration = 40 } = {}) {
  const test = must(await service.from("tests").insert({ title: `t-${randomUUID().slice(0, 6)}`, duration_minutes: duration, status }).select().single());
  const qs = must(await service.from("questions").insert([
    { test_id: test.id, position: 1, type: "mcq", prompt: "Pick b", points: 2, options: { choices: [{ id: "a", text: "A" }, { id: "b", text: "B" }], multiple: false } },
    { test_id: test.id, position: 2, type: "short", prompt: "Explain", points: 5, options: {} },
    { test_id: test.id, position: 3, type: "bughunt", prompt: "Bug", points: 4, options: { code: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") } },
    { test_id: test.id, position: 4, type: "ctf", prompt: "Flag", points: 20, options: {} },
  ]).select());
  const byType = Object.fromEntries(qs.map((q) => [q.type, q.id]));
  must(await service.from("question_keys").insert([
    { question_id: byType.mcq, correct: ["b"] },
    { question_id: byType.short, rubric: "Point one\nPoint two", model_answer: "Model" },
    { question_id: byType.bughunt, correct: 7 },
  ]).select());
  const hints = must(await service.from("hints").insert([
    { question_id: byType.ctf, position: 1, text: "secret hint text", cost_points: 3 },
  ]).select());
  return { test, q: byType, hintId: hints[0].id };
}

export async function cleanupUsers(...users) {
  for (const u of users) if (u?.id) await service.auth.admin.deleteUser(u.id);
}
