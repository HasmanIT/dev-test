// Acceptance 3 (the admin rebuilds the demo test from scratch in the UI), plus a UI run of
// acceptance 4 (a taker signs up, takes it, captures a flag, submits, and sees released results).
//
// Drives the real web app in your installed Chrome (headless) with playwright-core.
//   1. run the web app:  cd web && npm run dev      (http://localhost:5173, pointed at the test project)
//   2. cd tests && npm run test:ui
// Env: WEB_URL (default http://localhost:5173), CHROME_PATH, HEADED=1 to watch.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DEMO_FLAGS, DEMO_TEST_ID, cleanupUsers, makeUser, must, service } from "./helpers.mjs";

const WEB = (process.env.WEB_URL ?? "http://localhost:5173").replace(/\/$/, "");
const CHROME = process.env.CHROME_PATH ?? [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find(existsSync);
const TYPE_BUTTON = { mcq: "+ Quick-fire", short: "+ Short answer", bughunt: "+ Bug hunt", ctf: "+ Capture the flag" };
const flagFor = (repoUrl) => (repoUrl?.includes("01-missing-paisa") ? DEMO_FLAGS["01"] : DEMO_FLAGS["02"]);

let browser, admin, takerEmail, takerId, rebuiltId;
let demo; // { test, questions, keys, hints } from the seed

async function newPage() {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("[page error]", e.message));
  return page;
}

async function signInUi(page, email, password) {
  await page.goto(`${WEB}/#/`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Sign out" }).waitFor();
}

before(async () => {
  assert.ok(CHROME, "Chrome not found; set CHROME_PATH");
  browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED });
  admin = await makeUser("admin", "UI Admin");
  const t = must(await service.from("tests").select("*").eq("id", DEMO_TEST_ID).single());
  const questions = must(await service.from("questions").select("*").eq("test_id", DEMO_TEST_ID).order("position"));
  const ids = questions.map((q) => q.id);
  const keys = must(await service.from("question_keys").select("*").in("question_id", ids));
  const hints = must(await service.from("hints").select("*").in("question_id", ids).order("position"));
  demo = { test: t, questions, keys: new Map(keys.map((k) => [k.question_id, k])), hints };
});

after(async () => {
  await browser?.close();
  if (rebuiltId) await service.from("tests").delete().eq("id", rebuiltId);
  await cleanupUsers(admin, takerId ? { id: takerId } : null);
});

test("acceptance 3: the admin rebuilds the demo test from scratch in the UI", async () => {
  const page = await newPage();
  // makeUser signed in through the API; sign in again through the UI with the same credentials.
  await signInUi(page, admin.email, admin.password);
  await page.getByRole("link", { name: "Admin" }).click();
  await page.getByRole("button", { name: "+ New test" }).click();
  await page.getByRole("heading", { name: "Untitled test" }).waitFor();
  rebuiltId = page.url().split("/admin/tests/")[1];

  const title = `${demo.test.title} · UI rebuild ${randomUUID().slice(0, 4)}`;
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Duration (minutes)").fill(String(demo.test.duration_minutes));
  await page.getByLabel(/^Description/).fill(demo.test.description);
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Settings saved.").waitFor();

  for (const q of demo.questions) {
    await page.getByRole("button", { name: TYPE_BUTTON[q.type], exact: true }).click();
    const card = page.locator(".qedit.is-open", { hasText: `Q${q.position}` });
    await card.getByLabel("Prompt (markdown)").waitFor();
    await card.getByLabel("Prompt (markdown)").fill(q.prompt);
    await card.getByLabel("Points", { exact: true }).fill(String(q.points));
    const key = demo.keys.get(q.id);

    if (q.type === "mcq") {
      const choices = q.options.choices;
      for (let i = 2; i < choices.length; i++) await card.getByRole("button", { name: "+ Option" }).click();
      for (let i = 0; i < choices.length; i++) {
        await card.getByPlaceholder(`Option ${i + 1}`, { exact: true }).fill(choices[i].text);
        if (key.correct.includes(choices[i].id)) await card.getByLabel(`Option ${choices[i].id} is correct`).check();
      }
      if (q.options.multiple) await card.getByLabel("Allow several answers").check();
    }
    if (q.type === "short") {
      await card.getByLabel(/^Rubric/).fill(key.rubric);
      await card.getByLabel(/^Model answer/).fill(key.model_answer);
    }
    if (q.type === "bughunt") {
      await card.getByLabel(/^Code snippet/).fill(q.options.code);
      await card.getByRole("listbox", { name: "Click the buggy line to set the key" }).getByRole("option").nth(Number(key.correct) - 1).click();
    }
    if (q.type === "ctf") {
      await card.getByLabel("Challenge folder URL").fill(q.repo_url);
      await card.getByLabel(/^Flag/).fill(flagFor(q.repo_url));
    }
    const qHints = demo.hints.filter((h) => h.question_id === q.id);
    for (let i = 0; i < qHints.length; i++) {
      await card.getByRole("button", { name: "+ Hint" }).click();
      await card.getByPlaceholder("Hint text (markdown)").nth(i).fill(qHints[i].text);
      await card.getByLabel("Cost", { exact: true }).nth(i).fill(String(qHints[i].cost_points));
    }
    await card.getByRole("button", { name: "Save question" }).click();
    await card.getByText("Saved ✓").or(card.locator(".alert-error")).first().waitFor();
    const err = card.locator(".alert-error");
    if (await err.count()) throw new Error(`Saving Q${q.position} (${q.type}) failed: ${await err.innerText()}`);
  }

  await page.getByRole("button", { name: "Open test" }).click();
  await page.getByText("Test is now open.").waitFor();

  // Compare the rebuilt test with the seeded demo, field by field.
  const t = must(await service.from("tests").select("*").eq("id", rebuiltId).single());
  assert.equal(t.status, "open");
  assert.equal(t.duration_minutes, demo.test.duration_minutes);
  assert.equal(t.description, demo.test.description);
  const qs = must(await service.from("questions").select("*").eq("test_id", rebuiltId).order("position"));
  assert.equal(qs.length, demo.questions.length);
  const keys = new Map(must(await service.from("question_keys").select("*").in("question_id", qs.map((q) => q.id))).map((k) => [k.question_id, k]));
  const hints = must(await service.from("hints").select("*").in("question_id", qs.map((q) => q.id)).order("position"));
  qs.forEach((q, i) => {
    const d = demo.questions[i];
    const label = `Q${i + 1} (${d.type})`;
    assert.equal(q.type, d.type, label);
    assert.equal(q.prompt, d.prompt, label);
    assert.equal(q.points, d.points, label);
    assert.equal(q.repo_url, d.repo_url, label);
    assert.deepEqual(q.options, d.type === "bughunt" ? { ...d.options, language: "python" } : d.options, label);
    const k = keys.get(q.id);
    const dk = demo.keys.get(d.id);
    if (d.type === "mcq" || d.type === "bughunt") assert.deepEqual(k.correct, dk.correct, label);
    if (d.type === "short") {
      assert.equal(k.rubric, dk.rubric, label);
      assert.equal(k.model_answer, dk.model_answer, label);
    }
    if (d.type === "ctf") {
      assert.match(k.flag_hash, /^[0-9a-f]{64}$/, label);
      assert.notEqual(k.flag_salt, dk.flag_salt, `${label}: fresh salt`);
    }
    const qh = hints.filter((h) => h.question_id === q.id).map((h) => [h.text, h.cost_points]);
    const dh = demo.hints.filter((h) => h.question_id === d.id).map((h) => [h.text, h.cost_points]);
    assert.deepEqual(qh, dh, `${label} hints`);
  });

  // Preview as taker shows the same questions without saving anything.
  await page.getByRole("link", { name: "Preview as taker" }).click();
  await page.getByRole("button", { name: "Start preview" }).click();
  await page.getByText(`Question 1 of ${demo.questions.length}`).waitFor();
  assert.equal(must(await service.from("attempts").select("id").eq("test_id", rebuiltId)).length, 0, "preview created an attempt");
  await page.context().close();
});

test("acceptance 4 in the UI: a taker signs up, takes the rebuilt test and sees released results", async () => {
  assert.ok(rebuiltId, "needs the rebuilt test from the previous step");
  const page = await newPage();
  takerEmail = `ui-taker-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto(`${WEB}/#/`);
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByLabel("Your name").fill("UI Intern");
  await page.getByLabel("Email").fill(takerEmail);
  await page.getByLabel("Password").fill(`Pw-${randomUUID()}`);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Hi UI Intern").waitFor();
  takerId = must(await service.from("profiles").select("id, role").eq("email", takerEmail).single()).id;

  const card = page.locator(".test-card", { hasText: "UI rebuild" });
  await card.getByRole("link", { name: "View & start" }).click();
  await page.getByRole("button", { name: "Start test" }).click();
  await page.getByText(/Question 1 of 10/).waitFor();
  await page.locator(".countdown").filter({ hasText: /\d+:\d\d/ }).waitFor();

  const next = () => page.getByRole("button", { name: "Next →" }).click();
  // Q1–Q5 quick-fire: pick the right options.
  await page.getByText("git log --all", { exact: true }).click(); await next();
  await page.getByText("401 Unauthorized").click(); await next();
  await page.getByText("False", { exact: true }).click(); await next();
  for (const o of ["__pycache__/", ".env", ".venv/"]) await page.getByText(o, { exact: true }).click();
  await next();
  await page.getByText("HAVING", { exact: true }).click(); await next();
  // Q6–Q7 short answers.
  await page.getByPlaceholder("Type your answer…").fill("Floats are binary, so 0.1 isn't exact and rounding errors add up; store integer paise or use Decimal.");
  await next();
  await page.getByPlaceholder("Type your answer…").fill("No. It's still in the git history. Revoke and rotate the key now, and keep secrets in env vars.");
  await next();
  // Q8 bug hunt: click line 12.
  await page.getByRole("listbox", { name: "Click the line with the bug" }).getByRole("option").nth(11).click();
  await page.getByText("You picked line 12.").waitFor();
  await next();
  // Q9 CTF: reveal one hint, then capture the flag (confetti fires).
  await page.getByRole("button", { name: /Hint 1 \(−2 pts\)/ }).click();
  await page.getByRole("button", { name: "Reveal", exact: true }).click();
  await page.getByText("Floats can't represent 0.01 exactly", { exact: false }).waitFor();
  await page.getByLabel("Flag").fill(DEMO_FLAGS["01"]);
  await page.getByRole("button", { name: "Submit flag" }).click();
  await page.getByText("🚩 Flag captured!").waitFor();
  assert.ok(await page.locator("canvas").count() >= 1, "confetti canvas should appear");
  await page.getByText("All changes saved").waitFor();

  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page.getByRole("button", { name: "Yes, submit" }).click();
  await page.getByText("Submitted ✓").waitFor({ timeout: 90_000 });

  // Admin releases results and exports CSV.
  const adminPage = await newPage();
  await signInUi(adminPage, admin.email, admin.password);
  await adminPage.goto(`${WEB}/#/admin/tests/${rebuiltId}/attempts`);
  await adminPage.getByRole("link", { name: "UI Intern" }).waitFor();
  await adminPage.getByRole("button", { name: "Release results" }).click();
  await adminPage.getByText("Results released to takers.").waitFor();
  const [download] = await Promise.all([adminPage.waitForEvent("download"), adminPage.getByRole("button", { name: "Export CSV" }).click()]);
  const csv = readFileSync(await download.path(), "utf8");
  assert.match(csv, /UI Intern/);
  assert.match(csv, /flags_captured/);
  console.log("CSV:\n" + csv.trim());

  // Taker sees their score: 8 (mcq) + 4 (bug) + 18 (flag minus hint) + AI scores.
  await page.goto(`${WEB}/#/`);
  await page.locator(".test-card", { hasText: "UI rebuild" }).getByRole("link", { name: "See results" }).click();
  const hero = await page.locator(".score-hero .big").innerText();
  console.log("taker score:", hero.replace(/\s+/g, " "));
  const score = Number(hero.split("/")[0]);
  assert.ok(score >= 30, `expected at least 30 points, got ${hero}`);
  await page.getByText("Grader:").first().waitFor();
});
