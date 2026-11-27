// Acceptance 5: for each challenge 1–4 the reference solution prints a flag the platform accepts,
// the unsolved starter prints none (checked by make_flag.py), and 10 wrong guesses trigger the cooldown.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALL_FLAGS, cleanupUsers, fn, makeUser, must, service } from "./helpers.mjs";

const solutions = process.env.CTF_SOLUTIONS_DIR ?? fileURLToPath(new URL("../../intern-ctf-solutions", import.meta.url));
let admin, taker, testRow, questions, flags;

before(async () => {
  // Prefer live flags from the reference solutions; fall back to the recorded values.
  const script = `${solutions}/tools/make_flag.py`;
  if (existsSync(script)) {
    const out = execFileSync(process.env.PYTHON ?? "python", [script], { encoding: "utf8", timeout: 120_000 });
    flags = Object.fromEntries(out.trim().split(/\r?\n/).map((l) => l.split(": ")));
    console.log("make_flag.py:\n" + out.trim());
  } else {
    console.log(`make_flag.py not found at ${script}; using recorded flags`);
    flags = ALL_FLAGS;
  }
  assert.equal(Object.keys(flags).length, 4);
  for (const f of Object.values(flags)) assert.match(f, /^FLAG\{[0-9a-f]{12}\}$/);

  admin = await makeUser("admin", "CTF Admin");
  taker = await makeUser("taker", "CTF Taker");
  testRow = must(await admin.client.from("tests").insert({ title: "CTF check", duration_minutes: 40, status: "open" }).select().single());
  questions = must(await admin.client.from("questions").insert(
    Object.keys(flags).map((name, i) => ({
      test_id: testRow.id, position: i + 1, type: "ctf", prompt: name, points: 20,
      repo_url: `https://github.com/HasmanIT/intern-ctf/tree/main/${name}`,
    })),
  ).select());
});

after(async () => {
  await service.from("tests").delete().eq("id", testRow.id);
  await cleanupUsers(admin, taker);
});

test("admin sets each flag; only a salted hash is stored", async () => {
  for (const q of questions) {
    const r = await fn(admin.client, "set_question_key", { question_id: q.id, flag: flags[q.prompt] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const keys = must(await service.from("question_keys").select("*").in("question_id", questions.map((q) => q.id)));
  assert.equal(keys.length, 4);
  const salts = new Set();
  for (const k of keys) {
    assert.match(k.flag_hash, /^[0-9a-f]{64}$/);
    assert.match(k.flag_salt, /^[0-9a-f]{32}$/);
    salts.add(k.flag_salt);
    assert.ok(!JSON.stringify(k).includes("FLAG{"), "plain flag stored");
  }
  assert.equal(salts.size, 4, "each flag gets its own random salt");
  const notCtf = await fn(admin.client, "set_question_key", { question_id: questions[0].id, correct: ["a"] });
  assert.equal(notCtf.status, 200);
});

test("each reference flag is accepted, and a near-miss is not", async () => {
  const start = await fn(taker.client, "start_attempt", { test_id: testRow.id });
  assert.equal(start.status, 200);
  for (const q of questions) {
    const flag = flags[q.prompt];
    const near = flag.slice(0, -2) + (flag.at(-2) === "0" ? "1" : "0") + "}";
    const miss = await fn(taker.client, "check_flag", { question_id: q.id, flag: near });
    assert.equal(miss.body.correct, false, `${q.prompt} accepted a wrong flag`);
    const hit = await fn(taker.client, "check_flag", { question_id: q.id, flag });
    assert.equal(hit.status, 200);
    assert.equal(hit.body.correct, true, `${q.prompt} rejected its reference flag`);
    const again = await fn(taker.client, "check_flag", { question_id: q.id, flag });
    assert.equal(again.body.already_captured, true);
  }
  const caps = must(await taker.client.rpc("my_captures", { p_attempt_id: start.body.attempt.id }));
  assert.equal(caps.filter((c) => c.captured).length, 4);
});

test("10 wrong guesses trigger a 60-second cooldown; guesses are logged without the guess", async () => {
  const t2 = await makeUser("taker", "Guesser");
  try {
    const s = await fn(t2.client, "start_attempt", { test_id: testRow.id });
    const q = questions[0];
    for (let i = 0; i < 10; i++) {
      const r = await fn(t2.client, "check_flag", { question_id: q.id, flag: `FLAG{nope${i}}` });
      assert.equal(r.status, 200);
      assert.equal(r.body.guesses_before_cooldown, 9 - i === 0 ? 0 : 9 - i);
    }
    const blocked = await fn(t2.client, "check_flag", { question_id: q.id, flag: flags[q.prompt] });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.body.retry_after_seconds >= 55);
    // Other questions are not affected.
    const other = await fn(t2.client, "check_flag", { question_id: questions[1].id, flag: flags[questions[1].prompt] });
    assert.equal(other.body.correct, true);
    // Once the cooldown passes, guessing works again (simulate by ageing the log).
    must(await service.from("flag_attempts").update({ created_at: new Date(Date.now() - 61_000).toISOString() }).eq("attempt_id", s.body.attempt.id).eq("question_id", q.id).select());
    const after = await fn(t2.client, "check_flag", { question_id: q.id, flag: flags[q.prompt] });
    assert.equal(after.body.correct, true);
    const log = must(await service.from("flag_attempts").select("*").eq("attempt_id", s.body.attempt.id));
    assert.equal(log.filter((l) => l.result === "wrong").length, 10);
    assert.equal(log.filter((l) => l.result === "rate_limited").length, 1);
    assert.ok(log.every((l) => !("guess" in l) && !("flag" in l)));
  } finally {
    await cleanupUsers(t2);
  }
});
