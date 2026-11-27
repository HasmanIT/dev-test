// Acceptance 2 (invite → login → no admin data) and 4 (a taker completes the demo test;
// mcq and bughunt are auto-graded; late saves are rejected). Uses the seeded demo test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEMO_FLAGS, DEMO_TEST_ID, cleanupUsers, fn, makeUser, must, service, signIn } from "./helpers.mjs";

const Q = (n) => `d0000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
let admin, invited, taker;

before(async () => {
  const demo = must(await service.from("tests").select("id").eq("id", DEMO_TEST_ID));
  assert.equal(demo.length, 1, "seed.sql demo test is missing; run `supabase db reset`");
  admin = await makeUser("admin", "Flow Admin");
});

after(async () => {
  await service.from("attempts").delete().eq("test_id", DEMO_TEST_ID);
  await service.from("tests").update({ status: "draft", results_visible: false }).eq("id", DEMO_TEST_ID);
  await cleanupUsers(admin, invited);
});

test("acceptance 2: admin invites a taker, the taker logs in and cannot reach admin data", async () => {
  const email = `invited-${randomUUID().slice(0, 8)}@example.test`;
  const r = await fn(admin.client, "invite_user", { email, password: "Start-pass-123", display_name: "Invited Intern" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  invited = { id: r.body.user_id };

  const dup = await fn(admin.client, "invite_user", { email, password: "Start-pass-123", display_name: "Again" });
  assert.equal(dup.status, 409);

  const client = await signIn(email, "Start-pass-123");
  const me = must(await client.from("profiles").select("*"));
  assert.equal(me.length, 1);
  assert.equal(me[0].role, "taker");
  assert.equal(me[0].display_name, "Invited Intern");

  assert.equal(must(await client.from("question_keys").select("*")).length, 0);
  assert.equal(must(await client.from("hints").select("*")).length, 0);
  assert.equal(must(await client.from("attempts").select("*")).length, 0);
  assert.equal(must(await client.from("profiles").select("*").neq("id", r.body.user_id)).length, 0);
  assert.equal(must(await client.from("tests").select("*").eq("status", "draft")).length, 0);
  const { data: isAdmin } = await client.rpc("is_admin");
  assert.equal(isAdmin, false);
  assert.equal((await fn(client, "invite_user", { email: "y@example.test", password: "password123", display_name: "Y" })).status, 403);
  taker = { id: r.body.user_id, client };
});

test("acceptance 4: a taker completes the demo test", async () => {
  // Admin opens the demo test (through RLS, as the admin).
  must(await admin.client.from("tests").update({ status: "open" }).eq("id", DEMO_TEST_ID).select());

  // Before starting, the taker sees the test but none of its questions.
  assert.equal(must(await taker.client.from("tests").select("id").eq("id", DEMO_TEST_ID)).length, 1);
  assert.equal(must(await taker.client.from("questions").select("id").eq("test_id", DEMO_TEST_ID)).length, 0);

  const start = await fn(taker.client, "start_attempt", { test_id: DEMO_TEST_ID });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const attempt = start.body.attempt;
  const dl = new Date(attempt.deadline_at).getTime() - new Date(attempt.started_at).getTime();
  assert.equal(dl, 40 * 60_000, "deadline is start + 40 minutes, set by the server");
  assert.equal((await fn(taker.client, "start_attempt", { test_id: DEMO_TEST_ID })).status, 409, "only one attempt");

  const questions = must(await taker.client.from("questions").select("id, type").eq("test_id", DEMO_TEST_ID));
  assert.equal(questions.length, 10);

  const save = async (qid, response) =>
    must(await taker.client.from("answers").upsert({ attempt_id: attempt.id, question_id: qid, response }, { onConflict: "attempt_id,question_id" }));
  await save(Q(1), { selected: ["b"] }); // right
  await save(Q(2), { selected: ["c"] }); // wrong
  await save(Q(3), { selected: ["b"] }); // right
  await save(Q(4), { selected: ["a", "d"] }); // incomplete -> wrong (all-or-nothing)
  await save(Q(4), { selected: ["d", "b", "a"] }); // autosave overwrites -> right
  await save(Q(5), { selected: ["b"] }); // right
  await save(Q(6), { text: "Floats are binary so 0.1 is not exact and errors add up; use integer paise or Decimal." });
  await save(Q(7), { text: "No, it's still in history. Revoke and rotate the key, use env vars." });
  await save(Q(8), { line: 12 }); // right

  // Hints: listed with cost but no text until revealed; reveal records once.
  let hints = must(await taker.client.rpc("my_hints", { p_attempt_id: attempt.id }));
  const h109 = hints.filter((h) => h.question_id === Q(9));
  assert.equal(h109.length, 3);
  assert.ok(hints.every((h) => h.text === null), "hint text leaked before reveal");
  const rev = await fn(taker.client, "reveal_hint", { hint_id: h109[0].hint_id });
  assert.equal(rev.status, 200);
  assert.ok(rev.body.text.length > 0);
  assert.equal((await fn(taker.client, "reveal_hint", { hint_id: h109[0].hint_id })).status, 200, "re-reveal is idempotent");
  hints = must(await taker.client.rpc("my_hints", { p_attempt_id: attempt.id }));
  assert.equal(hints.filter((h) => h.revealed).length, 1);

  // CTF: Q9 captured with one hint (−2); Q10 never captured.
  const wrong = await fn(taker.client, "check_flag", { question_id: Q(9), flag: "FLAG{000000000000}" });
  assert.equal(wrong.status, 200);
  assert.equal(wrong.body.correct, false);
  const right = await fn(taker.client, "check_flag", { question_id: Q(9), flag: `  ${DEMO_FLAGS["01"]}\n` });
  assert.equal(right.body.correct, true);
  assert.ok(!JSON.stringify(right.body).includes("566722d04e14"), "response must not echo the flag");

  // Q10: 10 wrong guesses, then the 11th is refused with a cooldown.
  for (let i = 1; i <= 10; i++) {
    const r = await fn(taker.client, "check_flag", { question_id: Q(10), flag: `FLAG{wrong${i}}` });
    assert.equal(r.status, 200, `guess ${i}`);
    assert.equal(r.body.correct, false);
  }
  const cooled = await fn(taker.client, "check_flag", { question_id: Q(10), flag: DEMO_FLAGS["02"] });
  assert.equal(cooled.status, 429);
  assert.ok(cooled.body.retry_after_seconds > 0 && cooled.body.retry_after_seconds <= 60);

  // Submit.
  const sub = await fn(taker.client, "submit_attempt", { attempt_id: attempt.id });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));

  // Late saves are rejected once submitted.
  const late = await taker.client.from("answers").upsert({ attempt_id: attempt.id, question_id: Q(1), response: { selected: ["a"] } }, { onConflict: "attempt_id,question_id" });
  assert.ok(late.error, "save after submit must fail");
  assert.equal((await fn(taker.client, "check_flag", { question_id: Q(10), flag: DEMO_FLAGS["02"] })).status, 409);
  assert.equal((await fn(taker.client, "reveal_hint", { hint_id: h109[1].hint_id })).status, 409);

  // Grades are hidden until released, then visible.
  assert.equal(must(await taker.client.from("grades").select("*").eq("attempt_id", attempt.id)).length, 0);
  must(await admin.client.from("tests").update({ results_visible: true }).eq("id", DEMO_TEST_ID).select());
  const grades = must(await taker.client.from("grades").select("*").eq("attempt_id", attempt.id));
  const g = Object.fromEntries(grades.map((x) => [x.question_id, x]));
  assert.equal(grades.length, 10);

  const expectAuto = { 1: 2, 2: 0, 3: 2, 4: 2, 5: 2, 8: 4, 9: 18, 10: 0 };
  for (const [n, score] of Object.entries(expectAuto)) {
    assert.equal(g[Q(n)].graded_by, "auto", `Q${n} graded_by`);
    assert.equal(Number(g[Q(n)].score), score, `Q${n} score`);
  }
  assert.equal(Number(g[Q(9)].hint_penalty), 2);
  for (const n of [6, 7]) {
    assert.equal(g[Q(n)].graded_by, "ai");
    assert.equal(Number(g[Q(n)].max_score), 5);
    assert.ok(g[Q(n)].needs_review || g[Q(n)].ai_rationale, `Q${n} has a rationale or is flagged for review`);
  }
  const att = must(await taker.client.from("attempts").select("status, submitted_at").eq("id", attempt.id).single());
  assert.equal(att.status, "graded");
  assert.ok(att.submitted_at);

  // Admin: override keeps the AI rationale; reset removes everything.
  const ov = await fn(admin.client, "override_grade", { attempt_id: attempt.id, question_id: Q(6), score: 4.5, feedback: "Good" });
  assert.equal(ov.status, 200, JSON.stringify(ov.body));
  assert.equal(ov.body.grade.graded_by, "admin");
  assert.equal(Number(ov.body.grade.score), 4.5);
  assert.equal(ov.body.grade.ai_rationale, g[Q(6)].ai_rationale);
  assert.equal(ov.body.grade.needs_review, false);
  const tooHigh = await fn(admin.client, "override_grade", { attempt_id: attempt.id, question_id: Q(6), score: 50 });
  assert.equal(Number(tooHigh.body.grade.score), 5, "override is clamped to max points");

  const reset = await fn(admin.client, "reset_attempt", { attempt_id: attempt.id });
  assert.equal(reset.status, 200);
  for (const table of ["answers", "grades", "flag_attempts", "hint_reveals"]) {
    assert.equal(must(await service.from(table).select("id").eq("attempt_id", attempt.id)).length, 0, `${table} not cleared`);
  }
  assert.equal((await fn(taker.client, "start_attempt", { test_id: DEMO_TEST_ID })).status, 200, "taker can start again after reset");
});

test("auto-submit: the admin sweep submits and grades an overdue attempt", async () => {
  const t2 = await makeUser("taker", "Sleepy");
  try {
    const s = await fn(t2.client, "start_attempt", { test_id: DEMO_TEST_ID });
    assert.equal(s.status, 200);
    await t2.client.from("answers").insert({ attempt_id: s.body.attempt.id, question_id: Q(1), response: { selected: ["b"] } });
    must(await service.from("attempts").update({ deadline_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", s.body.attempt.id).select());
    const sweep = await fn(admin.client, "submit_attempt", { test_id: DEMO_TEST_ID, overdue_only: true });
    assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
    assert.ok(sweep.body.results.some((r) => r.attempt_id === s.body.attempt.id));
    const a = must(await service.from("attempts").select("status").eq("id", s.body.attempt.id).single());
    assert.equal(a.status, "graded");
    const g = must(await service.from("grades").select("score").eq("attempt_id", s.body.attempt.id).eq("question_id", Q(1)).single());
    assert.equal(Number(g.score), 2);
  } finally {
    await cleanupUsers(t2);
  }
});

test("a closed or draft test cannot be started", async () => {
  must(await service.from("tests").update({ status: "closed" }).eq("id", DEMO_TEST_ID).select());
  const t3 = await makeUser("taker", "Late");
  try {
    const r = await fn(t3.client, "start_attempt", { test_id: DEMO_TEST_ID });
    assert.equal(r.status, 409);
  } finally {
    await cleanupUsers(t3);
  }
});
