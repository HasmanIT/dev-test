-- Demo test with all four question types: 5 quick-fire, 2 short written, 1 bug hunt, 2 CTF.
-- Loaded by `supabase db reset` (local) or `supabase db push --include-seed` (hosted).
-- It is created as a DRAFT: open it from the admin screen when you want takers to see it.
--
-- This file is public. CTF keys below are salted hashes only (never plain flags), but because the
-- salt and hash are public, re-paste each flag in the admin screen before a real test: that stores
-- a fresh salt that exists only in the database. Answer keys for the demo questions are public too,
-- so build real tests in the UI, not in seed files.

insert into public.tests (id, title, description, duration_minutes, status, results_visible)
values (
  'd0000000-0000-4000-8000-000000000001',
  'Intern Warm-up (demo)',
  $md$Welcome! This warm-up takes **40 minutes**: 5 quick-fire questions, 2 short written answers, 1 bug hunt and 2 capture-the-flag challenges.

**AI tools are allowed** (ChatGPT, Copilot, Claude, …). Use them like a colleague: you still need to understand and check what they tell you.

- Answers save automatically. When the timer hits zero, your test is submitted for you.
- Hints cost points. You'll see the cost first.
- CTF challenges live in the `intern-ctf` repo. Clone it before you start: `git clone https://github.com/HasmanIT/intern-ctf.git`

Good luck, and have fun! 🚩$md$,
  40,
  'draft',
  false
)
on conflict (id) do nothing;

insert into public.questions (id, test_id, position, type, prompt, points, options, repo_url) values
('d0000000-0000-4000-8000-000000000101', 'd0000000-0000-4000-8000-000000000001', 1, 'mcq',
 'Which command shows commits from **all** branches, not just the one you are on?', 2,
 '{"choices":[{"id":"a","text":"git log"},{"id":"b","text":"git log --all"},{"id":"c","text":"git show --all"},{"id":"d","text":"git branch -v"}],"multiple":false}', null),
('d0000000-0000-4000-8000-000000000102', 'd0000000-0000-4000-8000-000000000001', 2, 'mcq',
 'An API request arrives **without a valid login token**. Which HTTP status code fits best?', 2,
 '{"choices":[{"id":"a","text":"400 Bad Request"},{"id":"b","text":"401 Unauthorized"},{"id":"c","text":"403 Forbidden"},{"id":"d","text":"404 Not Found"}],"multiple":false}', null),
('d0000000-0000-4000-8000-000000000103', 'd0000000-0000-4000-8000-000000000001', 3, 'mcq',
 'What does `0.1 + 0.2 == 0.3` evaluate to in Python?', 2,
 '{"choices":[{"id":"a","text":"True"},{"id":"b","text":"False"},{"id":"c","text":"It raises a TypeError"},{"id":"d","text":"None"}],"multiple":false}', null),
('d0000000-0000-4000-8000-000000000104', 'd0000000-0000-4000-8000-000000000001', 4, 'mcq',
 'Which of these belong in a Python project''s `.gitignore`? Select all that apply.', 2,
 '{"choices":[{"id":"a","text":"__pycache__/"},{"id":"b","text":".env"},{"id":"c","text":"requirements.txt"},{"id":"d","text":".venv/"}],"multiple":true}', null),
('d0000000-0000-4000-8000-000000000105', 'd0000000-0000-4000-8000-000000000001', 5, 'mcq',
 'Which SQL clause filters rows **after** `GROUP BY` has aggregated them?', 2,
 '{"choices":[{"id":"a","text":"WHERE"},{"id":"b","text":"HAVING"},{"id":"c","text":"ORDER BY"},{"id":"d","text":"LIMIT"}],"multiple":false}', null),
('d0000000-0000-4000-8000-000000000106', 'd0000000-0000-4000-8000-000000000001', 6, 'short',
 'In two or three sentences: why should an app store money as integers (for example paise) or decimals, rather than floats?', 5,
 '{}', null),
('d0000000-0000-4000-8000-000000000107', 'd0000000-0000-4000-8000-000000000001', 7, 'short',
 'A teammate pushes a commit containing an API key to a **public** repo, then deletes the file in the next commit. Is the key safe now? What should they do?', 5,
 '{}', null),
('d0000000-0000-4000-8000-000000000108', 'd0000000-0000-4000-8000-000000000001', 8, 'bughunt',
 'This function should return the average star rating, skipping reviews that have no rating. It returns the wrong number. **Click the buggy line.**', 4,
 jsonb_build_object('language', 'python', 'code', $code$def average_rating(reviews):
    """Return the mean star rating, ignoring reviews without a rating."""
    total = 0
    count = 0
    for review in reviews:
        stars = review.get("stars")
        if stars is None:
            continue
        if not 1 <= stars <= 5:
            raise ValueError(f"bad rating: {stars}")
        total += stars
    count += 1
    if count == 0:
        return 0.0
    return round(total / count, 2)$code$), null),
('d0000000-0000-4000-8000-000000000109', 'd0000000-0000-4000-8000-000000000001', 9, 'ctf',
 $md$**The Missing Paisa.** Our bill-splitter loses a paisa. Fix `splitter.py`, then run `python check.py` to get your flag.

Folder: `01-missing-paisa` in the `intern-ctf` repo.$md$, 20,
 '{}', 'https://github.com/HasmanIT/intern-ctf/tree/main/01-missing-paisa'),
('d0000000-0000-4000-8000-000000000110', 'd0000000-0000-4000-8000-000000000001', 10, 'ctf',
 $md$**Time Traveler.** Someone deleted `vault.txt` from git. Bring it back exactly, then run `python check.py` to get your flag.

Folder: `02-time-traveler` in the `intern-ctf` repo.$md$, 20,
 '{}', 'https://github.com/HasmanIT/intern-ctf/tree/main/02-time-traveler')
on conflict (id) do nothing;

insert into public.question_keys (question_id, correct, rubric, model_answer, flag_hash, flag_salt) values
('d0000000-0000-4000-8000-000000000101', '["b"]', null, null, null, null),
('d0000000-0000-4000-8000-000000000102', '["b"]', null, null, null, null),
('d0000000-0000-4000-8000-000000000103', '["b"]', null, null, null, null),
('d0000000-0000-4000-8000-000000000104', '["a","b","d"]', null, null, null, null),
('d0000000-0000-4000-8000-000000000105', '["b"]', null, null, null, null),
('d0000000-0000-4000-8000-000000000106', null,
 $r$Floats are binary and cannot represent many decimal amounts (such as 0.1) exactly.
Small rounding errors add up across calculations, so totals can drift and lose or gain paise.
Integers in the smallest unit (paise) or Decimal give exact arithmetic and predictable rounding.$r$,
 $m$Floats store numbers in binary, so amounts like 0.10 can't be represented exactly and tiny errors creep in. Those errors add up over many calculations, so totals can be off by a paisa. Storing paise as integers, or using Decimal, keeps money exact and lets you choose how to round.$m$,
 null, null),
('d0000000-0000-4000-8000-000000000107', null,
 $r$No: the key is still in the git history (and anyone may already have copied it).
Revoke or rotate the key immediately; that is the only real fix.
Prevent a repeat: keep secrets in environment variables or a secret store and ignore .env files; optionally purge the history (e.g. git filter-repo).$r$,
 $m$No. Deleting the file only removes it from the latest commit; the key is still in the history, and bots scan public repos within minutes. They must revoke or rotate the key right away, then keep secrets out of git (environment variables, a secret manager, .gitignore for .env) and optionally rewrite history to remove it.$m$,
 null, null),
('d0000000-0000-4000-8000-000000000108', '12', null, null, null, null),
('d0000000-0000-4000-8000-000000000109', null, null, null,
 '4219d3630cfee30e7f81d8eb5ea04b1570401b2697f44ac747141f48afefac10', '23d815c75279bca3da324afcba3f719e'),
('d0000000-0000-4000-8000-000000000110', null, null, null,
 '9ad3c3d20c961f81261779faa1721f8f97e30cf327c29960e9c3edd9d6cf71ee', '2e4e50c83b26a476b1661cee9bf0ed8d')
on conflict (question_id) do nothing;

insert into public.hints (id, question_id, position, text, cost_points) values
('d0000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000108', 1,
 'Follow `count` through one pass of the loop. When does it change?', 1),
('d0000000-0000-4000-8000-000000000211', 'd0000000-0000-4000-8000-000000000109', 1,
 'Floats can''t represent 0.01 exactly. Count money in whole paise (integers) or use `decimal.Decimal`.', 2),
('d0000000-0000-4000-8000-000000000212', 'd0000000-0000-4000-8000-000000000109', 2,
 '`divmod(total_paise, people)` gives each person''s base share and how many paise are left over.', 3),
('d0000000-0000-4000-8000-000000000213', 'd0000000-0000-4000-8000-000000000109', 3,
 'Give one extra paisa to the first `leftover` people, then format each share as `f"{p // 100}.{p % 100:02d}"`.', 5),
('d0000000-0000-4000-8000-000000000221', 'd0000000-0000-4000-8000-000000000110', 1,
 'Plain `git log` shows only the current branch. Try `git log --all --oneline -- vault.txt`.', 2),
('d0000000-0000-4000-8000-000000000222', 'd0000000-0000-4000-8000-000000000110', 2,
 'Find the commit that *deleted* `vault.txt`. The version you want is in that commit''s parent: `<commit>^`.', 3),
('d0000000-0000-4000-8000-000000000223', 'd0000000-0000-4000-8000-000000000110', 3,
 '`git checkout <deleting-commit>^ -- vault.txt`, then run `python check.py` from the challenge folder.', 5)
on conflict (id) do nothing;
