// Multiple attempts: tests.max_attempts, one attempt in progress at a time, retakes only after
// results are released, hints and flag guesses tracked per attempt.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanupUsers, fn, makeTest, makeUser, must, service } from "./helpers.mjs";

let taker, other, t, unlimited;

before(async () => {
  taker = await makeUser("taker", "Retaker");
  other = await makeUser("taker", "Other");
  t = await makeTest();
  must(await service.from("tests").update({ max_attempts: 2 }).eq("id", t.test.id).select());
  unlimited = await makeTest();
  must(await service.from("tests").update({ max_attempts: null, results_visible: true }).eq("id", unlimited.test.id).select());
});

after(async () => {
  await service.from("tests").delete().in("id", [t.test.id, unlimited.test.id]);
  await cleanupUsers(taker, other);
});

const start = (u, testId) => fn(u.client, "start_attempt", { test_id: testId });
const submit = (u, attemptId) => fn(u.client, "submit_attempt", { attempt_id: attemptId });

test("default stays one-shot: a test without max_attempts changes allows one attempt", async () => {
  const one = await makeTest();
  try {
    const row = must(await service.from("tests").select("max_attempts").eq("id", one.test.id).single());
    assert.equal(row.max_attempts, 1);
    must(await service.from("tests").update({ results_visible: true }).eq("id", one.test.id).select());
    const a = await start(other, one.test.id);
    assert.equal(a.status, 200);
    assert.equal(a.body.attempt.attempt_number, 1);
    assert.equal((await submit(other, a.body.attempt.id)).status, 200);
    const again = await start(other, one.test.id);
    assert.equal(again.status, 409);
    assert.equal(again.body.reason, "no_attempts_left");
  } finally {
    await service.from("tests").delete().eq("id", one.test.id);
  }
});

test("max_attempts = 2: in-progress lock, release gate, limit, per-attempt hints and flags", async () => {
  const a1 = await start(taker, t.test.id);
  assert.equal(a1.status, 200, JSON.stringify(a1.body));
  assert.equal(a1.body.attempt.attempt_number, 1);

  const dup = await start(taker, t.test.id);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.reason, "in_progress");

  // Attempt 1: reveal the hint, capture nothing.
  assert.equal((await fn(taker.client, "reveal_hint", { hint_id: t.hintId })).status, 200);
  must(await taker.client.from("answers").insert({ attempt_id: a1.body.attempt.id, question_id: t.q.mcq, response: { selected: ["a"] } }).select());
  assert.equal((await submit(taker, a1.body.attempt.id)).status, 200);

  const early = await start(taker, t.test.id);
  assert.equal(early.status, 409, "retake must wait for released results");
  assert.equal(early.body.reason, "results_not_released");

  must(await service.from("tests").update({ results_visible: true }).eq("id", t.test.id).select());
  const a2 = await start(taker, t.test.id);
  assert.equal(a2.status, 200, JSON.stringify(a2.body));
  assert.equal(a2.body.attempt.attempt_number, 2);

  // Attempt 2 starts clean: no answers, hints unrevealed, no captures.
  const ans2 = must(await taker.client.from("answers").select("*").eq("attempt_id", a2.body.attempt.id));
  assert.equal(ans2.length, 0);
  const hints2 = must(await taker.client.rpc("my_hints", { p_attempt_id: a2.body.attempt.id }));
  assert.ok(hints2.every((h) => !h.revealed && h.text === null), "hints must start unrevealed on a new attempt");

  // Answers and flag checks go to attempt 2 only.
  must(await taker.client.from("answers").insert({ attempt_id: a2.body.attempt.id, question_id: t.q.mcq, response: { selected: ["b"] } }).select());
  const late1 = await taker.client.from("answers").update({ response: { selected: ["b"] } }).eq("attempt_id", a1.body.attempt.id).select();
  assert.ok(late1.error || late1.data.length === 0, "a submitted attempt must stay locked");
  assert.equal((await submit(taker, a2.body.attempt.id)).status, 200);

  const g1 = must(await service.from("grades").select("score").eq("attempt_id", a1.body.attempt.id).eq("question_id", t.q.mcq).single());
  const g2 = must(await service.from("grades").select("score").eq("attempt_id", a2.body.attempt.id).eq("question_id", t.q.mcq).single());
  assert.equal(Number(g1.score), 0);
  assert.equal(Number(g2.score), 2);
  const ctf1 = must(await service.from("grades").select("hint_penalty").eq("attempt_id", a1.body.attempt.id).eq("question_id", t.q.ctf).single());
  const ctf2 = must(await service.from("grades").select("hint_penalty").eq("attempt_id", a2.body.attempt.id).eq("question_id", t.q.ctf).single());
  assert.equal(Number(ctf1.hint_penalty), 3, "attempt 1 paid for its hint");
  assert.equal(Number(ctf2.hint_penalty), 0, "attempt 2 did not reveal it");

  const done = await start(taker, t.test.id);
  assert.equal(done.status, 409);
  assert.equal(done.body.reason, "no_attempts_left");

  // The taker sees both of their own attempts and their grades; never another taker's.
  const mine = must(await taker.client.from("attempts").select("attempt_number").eq("test_id", t.test.id).order("attempt_number"));
  assert.deepEqual(mine.map((a) => a.attempt_number), [1, 2]);
  assert.ok(must(await taker.client.from("grades").select("id").eq("attempt_id", a1.body.attempt.id)).length > 0);
  assert.equal(must(await other.client.from("attempts").select("id").eq("test_id", t.test.id)).length, 0);
});

test("an admin reset frees an attempt", async () => {
  const admin = await makeUser("admin", "Reset Admin");
  try {
    const rows = must(await service.from("attempts").select("id, attempt_number").eq("test_id", t.test.id).eq("user_id", taker.id).order("attempt_number"));
    const r = await fn(admin.client, "reset_attempt", { attempt_id: rows[1].id });
    assert.equal(r.status, 200);
    const again = await start(taker, t.test.id);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.attempt.attempt_number, 2, "numbering continues from the remaining attempts");
    assert.equal((await submit(taker, again.body.attempt.id)).status, 200);
  } finally {
    await cleanupUsers(admin);
  }
});

test("max_attempts = NULL allows any number of attempts", async () => {
  for (let n = 1; n <= 3; n++) {
    const a = await start(other, unlimited.test.id);
    assert.equal(a.status, 200, `attempt ${n}: ${JSON.stringify(a.body)}`);
    assert.equal(a.body.attempt.attempt_number, n);
    assert.equal((await submit(other, a.body.attempt.id)).status, 200);
  }
});

test("only one attempt can be in progress, even when two starts race", async () => {
  const racer = await makeUser("taker", "Racer");
  try {
    const results = await Promise.all([start(racer, unlimited.test.id), start(racer, unlimited.test.id), start(racer, unlimited.test.id)]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
    const live = must(await service.from("attempts").select("id").eq("user_id", racer.id).eq("status", "in_progress"));
    assert.equal(live.length, 1);
  } finally {
    await cleanupUsers(racer);
  }
});
