-- Explicit privileges for the Data API roles.
-- Newer Supabase projects do not grant anon / authenticated / service_role access to new tables
-- automatically, so every privilege the platform relies on is spelled out here. Row-level security
-- still decides which rows each role can see or change; anon gets nothing.

grant usage on schema public to authenticated, service_role;

-- The service role (Edge Functions) works on every table and writes all scores.
grant select, insert, update, delete on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Signed-in users: reads gated by RLS.
grant select on public.profiles, public.tests, public.questions, public.question_keys, public.hints,
  public.attempts, public.answers, public.grades, public.flag_attempts, public.hint_reveals
  to authenticated;

-- Writes gated by RLS (admin-only policies on test content; answer policies enforce the deadline).
grant insert, update, delete on public.tests, public.questions, public.question_keys, public.hints to authenticated;
grant insert, update on public.answers to authenticated;
grant update (display_name, role) on public.profiles to authenticated;  -- role changes blocked by guard_profile_update unless admin

-- Never granted to authenticated: writes on attempts, grades, flag_attempts, hint_reveals;
-- insert/delete on profiles; delete on answers.
