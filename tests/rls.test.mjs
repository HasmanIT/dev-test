// Acceptance 1: RLS, logged in as a taker.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanupUsers, fn, makeTest, makeUser, must, service } from "./helpers.mjs";

let admin, takerA, takerB, t, draft, attemptA, attemptB;

before(async () => {
  admin = await makeUser("admin", "RLS Admin");
  takerA = await makeUser("taker", "Taker A");
  takerB = await makeUser("taker", "Taker B");
  t = await makeTest();
  draft = await makeTest({ status: "draft" });

  const a = await fn(takerA.client, "start_attempt", { test_id: t.test.id });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  attemptA = a.body.attempt;
  const b = await fn(takerB.client, "start_attempt", { test_id: t.test.id });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  attemptB = b.body.attempt;

  // Give B some data so "unreadable" means hidden, not empty.
  must(await takerB.client.from("answers").insert({ attempt_id: attemptB.id, question_id: t.q.mcq, response: { selected: ["a"] } }));
  assert.equal((await fn(takerB.client, "reveal_hint", { hint_id: t.hintId })).status, 200);
  must(await service.from("question_keys").upsert({ question_id: t.q.ctf, flag_hash: "0".repeat(64), flag_salt: "0".repeat(32) }));
  await fn(takerB.client, "check_flag", { question_id: t.q.ctf, flag: "FLAG{wrong}" });
});

after(async () => {
  await service.from("tests").delete().in("id", [t.test.id, draft.test.id]);
  await cleanupUsers(admin, takerA, takerB);
});

for (const table of ["question_keys", "hints", "flag_attempts", "hint_reveals"]) {
  test(`taker cannot read ${table}`, async () => {
    const { data, error } = await takerA.client.from(table).select("*");
    assert.ok(error || data.length === 0, `${table} returned ${data?.length} rows`);
    // Sanity check: the rows exist (the service role sees them).
    const all = must(await service.from(table).select("*").limit(1));
    assert.ok(all.length > 0, `${table} should have rows for this test to mean anything`);
  });
}

test("taker cannot write grades (insert, update, delete)", async () => {
  const ins = await takerA.client.from("grades").insert({
    attempt_id: attemptA.id, question_id: t.q.mcq, score: 99, max_score: 2, graded_by: "auto",
  });
  assert.ok(ins.error, "insert into grades must fail");
  // Make a real grade, then try to change it.
  must(await service.from("grades").insert({ attempt_id: attemptA.id, question_id: t.q.short, score: 1, max_score: 5, graded_by: "ai" }));
  const upd = await takerA.client.from("grades").update({ score: 5 }).eq("attempt_id", attemptA.id).select();
  assert.ok(upd.error || upd.data.length === 0, "update of grades must not succeed");
  const del = await takerA.client.from("grades").delete().eq("attempt_id", attemptA.id).select();
  assert.ok(del.error || del.data.length === 0, "delete of grades must not succeed");
  const g = must(await service.from("grades").select("score").eq("attempt_id", attemptA.id).eq("question_id", t.q.short).single());
  assert.equal(Number(g.score), 1);
});

test("taker reads own grades only after results are released", async () => {
  let rows = must(await takerA.client.from("grades").select("*").eq("attempt_id", attemptA.id));
  assert.equal(rows.length, 0, "grades visible before release");
  must(await service.from("tests").update({ results_visible: true }).eq("id", t.test.id).select());
  rows = must(await takerA.client.from("grades").select("*").eq("attempt_id", attemptA.id));
  assert.ok(rows.length > 0, "own grades should be visible after release");
  must(await service.from("grades").insert({ attempt_id: attemptB.id, question_id: t.q.short, score: 2, max_score: 5, graded_by: "ai" }));
  rows = must(await takerA.client.from("grades").select("*").eq("attempt_id", attemptB.id));
  assert.equal(rows.length, 0, "another taker's grades visible");
  must(await service.from("tests").update({ results_visible: false }).eq("id", t.test.id).select());
});

test("taker cannot read another taker's attempt or answers", async () => {
  const att = must(await takerA.client.from("attempts").select("*").eq("id", attemptB.id));
  assert.equal(att.length, 0);
  const ans = must(await takerA.client.from("answers").select("*").eq("attempt_id", attemptB.id));
  assert.equal(ans.length, 0);
  const own = must(await takerA.client.from("attempts").select("*"));
  assert.deepEqual(own.map((r) => r.id), [attemptA.id]);
});

test("taker cannot write into another taker's attempt", async () => {
  const { error } = await takerA.client.from("answers").insert({ attempt_id: attemptB.id, question_id: t.q.short, response: { text: "hijack" } });
  assert.ok(error);
});

test("taker cannot change profiles.role (own or anyone's)", async () => {
  const own = await takerA.client.from("profiles").update({ role: "admin" }).eq("id", takerA.id).select();
  assert.ok(own.error, "role change must raise");
  const other = await takerA.client.from("profiles").update({ role: "admin" }).eq("id", takerB.id).select();
  assert.ok(other.error || other.data.length === 0);
  const p = must(await service.from("profiles").select("role").eq("id", takerA.id).single());
  assert.equal(p.role, "taker");
  // A display-name change is allowed.
  must(await takerA.client.from("profiles").update({ display_name: "Renamed A" }).eq("id", takerA.id).select());
});

test("taker cannot see other profiles, draft tests or questions of unstarted tests", async () => {
  const profiles = must(await takerA.client.from("profiles").select("id"));
  assert.deepEqual(profiles.map((p) => p.id), [takerA.id]);
  const drafts = must(await takerA.client.from("tests").select("id").eq("id", draft.test.id));
  assert.equal(drafts.length, 0);
  const qs = must(await takerA.client.from("questions").select("id").eq("test_id", draft.test.id));
  assert.equal(qs.length, 0);
});

test("taker cannot create, edit or delete tests and questions", async () => {
  const ins = await takerA.client.from("tests").insert({ title: "hack", status: "open" });
  assert.ok(ins.error);
  const upd = await takerA.client.from("tests").update({ results_visible: true }).eq("id", t.test.id).select();
  assert.ok(upd.error || upd.data.length === 0);
  const qd = await takerA.client.from("questions").delete().eq("test_id", t.test.id).select();
  assert.ok(qd.error || qd.data.length === 0);
  const attIns = await takerA.client.from("attempts").update({ deadline_at: "2999-01-01T00:00:00Z" }).eq("id", attemptA.id).select();
  assert.ok(attIns.error || attIns.data.length === 0, "taker must not extend their deadline");
});

test("an answer saved after the deadline is rejected", async () => {
  must(await takerA.client.from("answers").upsert({ attempt_id: attemptA.id, question_id: t.q.bughunt, response: { line: 3 } }, { onConflict: "attempt_id,question_id" }));
  // Move the deadline 11 s into the past (beyond the 10 s grace).
  must(await service.from("attempts").update({ deadline_at: new Date(Date.now() - 11_000).toISOString() }).eq("id", attemptA.id).select());
  const late = await takerA.client.from("answers").upsert({ attempt_id: attemptA.id, question_id: t.q.bughunt, response: { line: 7 } }, { onConflict: "attempt_id,question_id" });
  assert.ok(late.error, "late update must fail");
  const lateInsert = await takerA.client.from("answers").insert({ attempt_id: attemptA.id, question_id: t.q.mcq, response: { selected: ["b"] } });
  assert.ok(lateInsert.error, "late insert must fail");
  const saved = must(await service.from("answers").select("response").eq("attempt_id", attemptA.id).eq("question_id", t.q.bughunt).single());
  assert.equal(saved.response.line, 3);
});

test("an answer within the 10-second grace is accepted", async () => {
  must(await service.from("attempts").update({ deadline_at: new Date(Date.now() - 5_000).toISOString() }).eq("id", attemptB.id).select());
  must(await takerB.client.from("answers").upsert({ attempt_id: attemptB.id, question_id: t.q.bughunt, response: { line: 2 } }, { onConflict: "attempt_id,question_id" }));
});

test("short answers over 600 characters are rejected", async () => {
  must(await service.from("attempts").update({ deadline_at: new Date(Date.now() + 600_000).toISOString() }).eq("id", attemptB.id).select());
  const { error } = await takerB.client.from("answers").upsert({ attempt_id: attemptB.id, question_id: t.q.short, response: { text: "x".repeat(601) } }, { onConflict: "attempt_id,question_id" });
  assert.ok(error);
});

test("admin-only Edge Functions refuse a taker", async () => {
  const calls = [
    ["invite_user", { email: "x@example.test", password: "password123", display_name: "X" }],
    ["set_question_key", { question_id: t.q.ctf, flag: "FLAG{x}" }],
    ["override_grade", { attempt_id: attemptA.id, question_id: t.q.mcq, score: 2 }],
    ["grade_written", { attempt_id: attemptA.id }],
    ["reset_attempt", { attempt_id: attemptB.id }],
  ];
  for (const [name, body] of calls) {
    const r = await fn(takerA.client, name, body);
    assert.equal(r.status, 403, `${name} returned ${r.status}`);
  }
  const sweep = await fn(takerA.client, "submit_attempt", { test_id: t.test.id, overdue_only: true });
  assert.equal(sweep.status, 403);
  const other = await fn(takerA.client, "submit_attempt", { attempt_id: attemptB.id });
  assert.equal(other.status, 404, "taker must not submit someone else's attempt");
});

test("anonymous requests are refused", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { URL_, ANON } = await import("./helpers.mjs");
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
  for (const table of ["profiles", "tests", "questions", "attempts", "answers", "grades"]) {
    const { data, error } = await anon.from(table).select("*").limit(1);
    assert.ok(error || data.length === 0, `anon read ${table}`);
  }
  const r = await fn(anon, "start_attempt", { test_id: t.test.id });
  assert.equal(r.status, 401);
});
