# dev-test: Intern Test Platform

A small test platform for the intern program. Interns take timed tests made of quick-fire questions, short written answers (graded by AI), bug hunts and capture-the-flag challenges.

- **Web:** Vite + React + TypeScript, hosted on GitHub Pages (`HashRouter`). Lives in `web/`.
- **Backend:** Supabase. Auth (email + password), Postgres with row-level security on every table, and 9 Edge Functions in TypeScript. Lives in `supabase/`.
- **AI grading:** OpenAI Responses API, model set by `GRADER_MODEL` (default `gpt-5.4-mini`).
- **CTF challenges:** the public repo [`intern-ctf`](../intern-ctf). Reference solutions and flag tools are in the private repo `intern-ctf-solutions`.

```
web/                     React app (GitHub Pages)
supabase/migrations/     schema, RLS policies, helper functions
supabase/functions/      Edge Functions (+ _shared/ for auth, CORS, grading)
supabase/seed.sql        demo test with all four question types (created as a draft)
tests/                   acceptance tests (Node, run against a live Supabase)
.github/workflows/       build web/ and deploy to Pages
```

---

## 1. Deploy from nothing

You need: Node 20+ (24 recommended), git, a [Supabase](https://supabase.com) account, an OpenAI API key, and admin rights on this GitHub repo. Every `supabase` command below runs through `npx`, so nothing needs a global install.

### 1.1 Create the Supabase project

1. In the Supabase dashboard, click **New project**. Note the **project ref** (the `abcd…` part of `https://abcd….supabase.co`).
2. **Authentication → Sign In / Providers → Email:** keep the **Email** provider **enabled** and turn **Confirm email** **off**. The platform sends no email, so confirmation links would never arrive. If the provider itself is off, sign-in fails with "Email logins are disabled". Optionally set the minimum password length to 8 to match the sign-up form.
3. **Project Settings → API Keys:** copy the **Project URL** and the **anon / publishable** key. You'll need both in step 1.4.

### 1.2 Push the database and functions

From the repo root:

```bash
npx supabase login                                   # non-interactive shell: npx supabase login --token sbp_...
npx supabase link --project-ref <your-project-ref>
npx supabase db push --remote --include-seed         # schema + grants + RLS + demo test
npx supabase functions deploy --use-api              # all 9 functions; --use-api bundles without Docker
npx supabase secrets set GRADER_MODEL=gpt-5.4-mini ALLOWED_ORIGINS=https://<your-org>.github.io
```

Add `OPENAI_API_KEY` in the dashboard (**Edge Functions → Secrets**) rather than on the command line, so it never lands in your shell history.

The access token must allow writing to the database, Edge Functions and secrets. A read-only token fails with `Missing required permission(s): database_write`. Database commands target the local stack unless you pass `--remote`.

`ALLOWED_ORIGINS` is the Pages **origin** only (scheme + host, no path), for example `https://hasmanit.github.io`. Functions reject browser calls from any other origin.

### 1.3 Make yourself admin

1. Open the deployed site (step 1.4) and create an account, or create one in **Authentication → Users → Add user** with "Auto confirm" ticked.
2. In the dashboard's **SQL Editor**, run:

```sql
update public.profiles set role = 'admin' where email = 'you@company.com';
```

Every new account starts as a `taker`, and takers can't change their own role.

### 1.4 Deploy the web app to GitHub Pages

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables** tab: add two repository variables:
   - `VITE_SUPABASE_URL` = the Project URL
   - `VITE_SUPABASE_ANON_KEY` = the anon / publishable key (public by design, and protected by RLS)
3. Push to `main` (or run the workflow from the **Actions** tab). The site appears at `https://<your-org>.github.io/<repo>/`.

> This repo is currently **private**. GitHub Pages for a private repo needs a paid plan (Pro, Team or Enterprise). Even then, the published site itself is public.

### 1.5 Publish the CTF challenges

1. Create **`intern-ctf`** as a **public** repo and push the `intern-ctf` folder to it.
2. Create **`intern-ctf-solutions`** as a **private** repo and push that folder. **The shared intern GitHub account must not have access to it.**
3. Compute the flags (needs Python 3.11+ with `pytest`, `fastapi` and `uvicorn`):

   ```bash
   cd intern-ctf-solutions
   python -m pip install pytest fastapi uvicorn
   python tools/make_flag.py
   ```

4. In the platform, open each CTF question, paste its flag into **Flag** and click **Save question**. Re-paste the two demo-test flags too: the seed's salted hashes are public, and re-pasting stores a fresh salt that exists only in your database.

If your GitHub org isn't `HasmanIT`, update the `repo_url`s in the demo test (they're editable in the admin screen) and the clone URL in `intern-ctf/README.md`.

---

## 2. Run a test day

1. **Wake the project.** Free-tier Supabase projects pause after a week without activity. Open the dashboard and restore the project if it's paused, then load the site once.
2. **Admin → Tests → your test → Open test.** Interns now see it under "My tests".
3. Interns sign up (or you **Invite** them from **People** with a starting password), clone `intern-ctf`, and start. Each attempt's deadline is set by the server to *start + duration*.
4. After the deadline, go to **Attempts** and click **Submit overdue**. This grades attempts whose browser was closed when time ran out.
5. Review rows highlighted **needs review** (AI grading failed or a key was missing). Override any grade, or click **Re-run AI grading**.
6. Click **Release results**, then **Export CSV**.

**The AI rule:** interns **may** use AI tools during tests. The demo test says so in its description, so keep that line in new tests.

---

## 3. Local development

Local Supabase runs in Docker. **On Windows, Docker Desktop needs WSL 2.** Run `wsl --install` in an admin PowerShell, then reboot.

```bash
npx supabase start                         # Postgres, Auth, Edge Functions on 127.0.0.1:54321
npx supabase db reset                      # apply migrations + seed
cp supabase/functions/.env.example supabase/functions/.env     # then add OPENAI_API_KEY
npx supabase functions serve --env-file supabase/functions/.env   # in its own terminal

cd web
cp .env.example .env.local                 # fill in from `npx supabase status`
npm install
npm run dev                                # http://localhost:5173
```

`ALLOW_LOCALHOST=true` in `supabase/functions/.env` lets the dev server call the functions. Never set it on the hosted project.

---

## 4. Acceptance tests

The tests run against a live Supabase (local or a disposable hosted project) using the service-role key. They create and delete their own users and tests. Never point them at production.

```bash
cd tests
npm install
# tests/.env.test (gitignored) needs SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY:
#   local stack: npx supabase status -o env > .env.test
#   hosted:      values from npx supabase projects api-keys --project-ref <ref>
npm run test:rls                           # 1     RLS as a taker
npm run test:flow                          # 2, 4  invite → login; complete the demo test; late saves rejected
PYTHON=python npm run test:ctf             # 5     reference flags accepted (runs make_flag.py from ../../intern-ctf-solutions); cooldown
AI_MODE=live npm run test:ai               # 6     scores + rationales; prompt injection doesn't get full marks
AI_MODE=fail npm run test:ai               # 6     with GRADER_MODEL set to a model that doesn't exist: failures show as needs_review
npm run test:ui                            # 3, 4  drives the web app in your installed Chrome (run `npm run dev` in web/ first)
```

`flow.test.mjs` and `ui.e2e.mjs` need the seeded demo test. `test:ui` uses `playwright-core` with your own Chrome. Set `CHROME_PATH` if Chrome isn't in the default location, and `HEADED=1` to watch it run. Point `web/.env.local` at the same project, using the **publishable / anon** key, never the secret key.

---

## 5. How it fits together

| Function | Who | What |
| --- | --- | --- |
| `invite_user` | admin | Creates a confirmed login. The `on_auth_user_created` trigger makes the taker profile |
| `set_question_key` | admin | Sets answer keys. For CTF, stores only `sha256(salt + flag)` with a random salt |
| `start_attempt` | taker | Open test, no existing attempt. Sets `deadline_at = now + duration` |
| `reveal_hint` | taker | Records the reveal once and returns the text |
| `check_flag` | taker | Compares with the salted hash and logs each guess (never the guess itself). After 10 wrong guesses, a 60 s cooldown |
| `submit_attempt` | taker / admin | Locks and grades: mcq / bughunt / ctf automatically, short answers by AI. Admin form `{test_id, overdue_only: true}` sweeps overdue attempts |
| `grade_written` | admin | Re-runs AI grading. `submit_attempt` uses the same grader in-process |
| `override_grade` | admin | Sets the score, `graded_by = admin`, and keeps the AI rationale |
| `reset_attempt` | admin | Deletes an attempt and everything under it |

**Scoring:** every question type subtracts the costs of revealed hints, and no score goes below 0. MCQ is all-or-nothing. A short answer scores 0 to max (AI), with empty answers scoring 0 without an API call. If AI grading fails, the answer scores 0 with `needs_review`.

**Security:** the browser only ever has the Supabase URL and anon key. The service-role key and `OPENAI_API_KEY` exist only as Supabase secrets. Takers can't read keys, hints, flag guesses or other takers' data. Answer writes are checked in SQL against the attempt status and `deadline_at` (+10 s grace), whatever the browser clock says.
