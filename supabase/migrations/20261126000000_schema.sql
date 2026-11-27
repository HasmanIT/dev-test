-- Intern Test Platform: schema, row-level security and helper functions.
-- Default deny: RLS is enabled on every table and only the policies below grant access.
-- Every score is written by an Edge Function using the service role (which bypasses RLS).

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null default '' check (char_length(display_name) <= 80),
  email         text not null default '',
  role          text not null default 'taker' check (role in ('admin', 'taker')),
  created_at    timestamptz not null default now()
);

create table public.tests (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (char_length(title) between 1 and 200),
  description       text not null default '' check (char_length(description) <= 20000),
  duration_minutes  integer not null default 40 check (duration_minutes between 1 and 240),
  status            text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  results_visible   boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.questions (
  id          uuid primary key default gen_random_uuid(),
  test_id     uuid not null references public.tests (id) on delete cascade,
  position    integer not null default 0,
  type        text not null check (type in ('mcq', 'short', 'bughunt', 'ctf')),
  prompt      text not null default '' check (char_length(prompt) <= 20000),
  points      integer not null default 1 check (points between 0 and 1000),
  -- mcq:     {"choices": [{"id": "a", "text": "..."}], "multiple": false}
  -- bughunt: {"code": "...", "language": "python"}
  -- short / ctf: {}
  options     jsonb not null default '{}'::jsonb,
  repo_url    text check (repo_url is null or char_length(repo_url) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index questions_test_idx on public.questions (test_id, position);

-- Admin only. Never readable by takers.
create table public.question_keys (
  question_id   uuid primary key references public.questions (id) on delete cascade,
  -- mcq: ["a", "c"]   bughunt: 7   short / ctf: null
  correct       jsonb,
  rubric        text check (rubric is null or char_length(rubric) <= 4000),
  model_answer  text check (model_answer is null or char_length(model_answer) <= 4000),
  flag_hash     text check (flag_hash is null or flag_hash ~ '^[0-9a-f]{64}$'),
  flag_salt     text check (flag_salt is null or flag_salt ~ '^[0-9a-f]{32}$'),
  updated_at    timestamptz not null default now()
);

-- Admin only. Takers see hint metadata (never text until revealed) through my_hints().
create table public.hints (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid not null references public.questions (id) on delete cascade,
  position     integer not null default 0,
  text         text not null check (char_length(text) between 1 and 4000),
  cost_points  integer not null default 0 check (cost_points >= 0),
  created_at   timestamptz not null default now()
);
create index hints_question_idx on public.hints (question_id, position);

create table public.attempts (
  id            uuid primary key default gen_random_uuid(),
  test_id       uuid not null references public.tests (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  started_at    timestamptz not null default now(),
  deadline_at   timestamptz not null,
  submitted_at  timestamptz,
  status        text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'graded')),
  unique (test_id, user_id)
);
create index attempts_user_idx on public.attempts (user_id);

create table public.answers (
  id           uuid primary key default gen_random_uuid(),
  attempt_id   uuid not null references public.attempts (id) on delete cascade,
  question_id  uuid not null references public.questions (id) on delete cascade,
  -- mcq: {"selected": ["a"]}   short: {"text": "..."}   bughunt: {"line": 7}
  response     jsonb not null,
  updated_at   timestamptz not null default now(),
  unique (attempt_id, question_id)
);

create table public.grades (
  id            uuid primary key default gen_random_uuid(),
  attempt_id    uuid not null references public.attempts (id) on delete cascade,
  question_id   uuid not null references public.questions (id) on delete cascade,
  score         numeric(8, 2) not null default 0,
  max_score     numeric(8, 2) not null default 0,
  hint_penalty  numeric(8, 2) not null default 0,
  feedback      text,
  graded_by     text not null check (graded_by in ('auto', 'ai', 'admin')),
  ai_rationale  text,
  ai_met        jsonb,
  ai_missed     jsonb,
  needs_review  boolean not null default false,
  updated_at    timestamptz not null default now(),
  unique (attempt_id, question_id)
);

-- Admin only. Every flag guess is logged; the guess itself is never stored.
create table public.flag_attempts (
  id           uuid primary key default gen_random_uuid(),
  attempt_id   uuid not null references public.attempts (id) on delete cascade,
  question_id  uuid not null references public.questions (id) on delete cascade,
  result       text not null check (result in ('correct', 'wrong', 'rate_limited')),
  created_at   timestamptz not null default now()
);
create index flag_attempts_lookup_idx on public.flag_attempts (attempt_id, question_id, created_at);

-- Admin only.
create table public.hint_reveals (
  id           uuid primary key default gen_random_uuid(),
  attempt_id   uuid not null references public.attempts (id) on delete cascade,
  hint_id      uuid not null references public.hints (id) on delete cascade,
  revealed_at  timestamptz not null default now(),
  unique (attempt_id, hint_id)
);

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
  );
$$;

-- The browser uses this to correct its countdown for clock skew. The deadline itself is enforced in SQL.
create or replace function public.server_now()
returns timestamptz
language sql
stable
as $$ select now(); $$;

-- Hint catalogue for the caller's own attempt: id, cost and whether revealed.
-- Text is returned only for hints this attempt has already revealed.
create or replace function public.my_hints(p_attempt_id uuid)
returns table (hint_id uuid, question_id uuid, "position" integer, cost_points integer, revealed boolean, text text)
language sql
stable
security definer
set search_path = ''
as $$
  select h.id, h.question_id, h.position, h.cost_points,
         (r.id is not null) as revealed,
         case when r.id is not null then h.text end as text
  from public.attempts a
  join public.questions q on q.test_id = a.test_id
  join public.hints h on h.question_id = q.id
  left join public.hint_reveals r on r.hint_id = h.id and r.attempt_id = a.id
  where a.id = p_attempt_id and a.user_id = (select auth.uid())
  order by q.position, h.position, h.id;
$$;

-- CTF questions this attempt has captured (true/false per question). No hashes or guesses.
create or replace function public.my_captures(p_attempt_id uuid)
returns table (question_id uuid, wrong_guesses integer, captured boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select q.id,
         count(f.id) filter (where f.result = 'wrong')::integer,
         coalesce(bool_or(f.result = 'correct'), false)
  from public.attempts a
  join public.questions q on q.test_id = a.test_id and q.type = 'ctf'
  left join public.flag_attempts f on f.attempt_id = a.id and f.question_id = q.id
  where a.id = p_attempt_id and a.user_id = (select auth.uid())
  group by q.id;
$$;

-- Question counts and total points for open tests, so takers can see the size of a test before starting.
create or replace function public.test_summaries()
returns table (test_id uuid, question_count integer, total_points integer)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, count(q.id)::integer, coalesce(sum(q.points), 0)::integer
  from public.tests t
  left join public.questions q on q.test_id = t.id
  where (select auth.uid()) is not null
    and (t.status = 'open'
         or public.is_admin()
         or exists (select 1 from public.attempts a where a.test_id = t.id and a.user_id = (select auth.uid())))
  group by t.id;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Every new auth user gets a taker profile. A role sent at sign-up is ignored.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, email, role)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(coalesce(new.email, ''), '@', 1)), 80),
    coalesce(new.email, ''),
    'taker'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only an admin (or the database owner / service role) can change a role or a profile's id/email.
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'role cannot be changed' using errcode = '42501';
    end if;
    if new.id is distinct from old.id or new.email is distinct from old.email then
      raise exception 'profile id and email cannot be changed' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_profile_update
  before update on public.profiles
  for each row execute function public.guard_profile_update();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger touch_tests before update on public.tests
  for each row execute function public.touch_updated_at();
create trigger touch_questions before update on public.questions
  for each row execute function public.touch_updated_at();
create trigger touch_question_keys before update on public.question_keys
  for each row execute function public.touch_updated_at();
create trigger touch_grades before update on public.grades
  for each row execute function public.touch_updated_at();

-- Answers: validate shape per question type and freeze the row's identity.
create or replace function public.validate_answer()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  q_type text;
begin
  if tg_op = 'UPDATE' and (new.attempt_id <> old.attempt_id or new.question_id <> old.question_id) then
    raise exception 'answer identity cannot change' using errcode = '42501';
  end if;

  select q.type into q_type from public.questions q where q.id = new.question_id;

  if pg_column_size(new.response) > 8192 then
    raise exception 'answer too large' using errcode = '22023';
  end if;

  if q_type = 'mcq' then
    if jsonb_typeof(new.response -> 'selected') <> 'array' or jsonb_array_length(new.response -> 'selected') > 26 then
      raise exception 'mcq answer must be {"selected": [ids]}' using errcode = '22023';
    end if;
  elsif q_type = 'short' then
    if jsonb_typeof(new.response -> 'text') <> 'string' or char_length(new.response ->> 'text') > 600 then
      raise exception 'short answer must be {"text": string} of at most 600 characters' using errcode = '22023';
    end if;
  elsif q_type = 'bughunt' then
    if jsonb_typeof(new.response -> 'line') <> 'number' then
      raise exception 'bughunt answer must be {"line": number}' using errcode = '22023';
    end if;
  else
    raise exception 'answers are not stored for this question type' using errcode = '22023';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger validate_answer
  before insert or update on public.answers
  for each row execute function public.validate_answer();

-- ---------------------------------------------------------------------------
-- Grants: anon gets nothing; authenticated gets table privileges gated by RLS.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon, public;
grant execute on function public.is_admin(), public.server_now(), public.my_hints(uuid),
  public.my_captures(uuid), public.test_summaries() to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles       enable row level security;
alter table public.tests          enable row level security;
alter table public.questions      enable row level security;
alter table public.question_keys  enable row level security;
alter table public.hints          enable row level security;
alter table public.attempts       enable row level security;
alter table public.answers        enable row level security;
alter table public.grades         enable row level security;
alter table public.flag_attempts  enable row level security;
alter table public.hint_reveals   enable row level security;

-- profiles: own row (display name only), admins see and edit all.
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy profiles_admin_select on public.profiles
  for select to authenticated using ((select public.is_admin()));
create policy profiles_admin_update on public.profiles
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- tests: takers see open tests and tests they have an attempt on; admins do everything.
create policy tests_taker_select on public.tests
  for select to authenticated using (
    status = 'open'
    or exists (select 1 from public.attempts a where a.test_id = tests.id and a.user_id = (select auth.uid()))
  );
create policy tests_admin_all on public.tests
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- questions: takers see questions only once they have started the test.
create policy questions_taker_select on public.questions
  for select to authenticated using (
    exists (select 1 from public.attempts a where a.test_id = questions.test_id and a.user_id = (select auth.uid()))
  );
create policy questions_admin_all on public.questions
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- question_keys, hints: admin only.
create policy question_keys_admin_all on public.question_keys
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy hints_admin_all on public.hints
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- attempts: takers read their own (created by start_attempt); admins read all. Changes go through Edge Functions.
create policy attempts_taker_select on public.attempts
  for select to authenticated using (user_id = (select auth.uid()));
create policy attempts_admin_select on public.attempts
  for select to authenticated using ((select public.is_admin()));

-- answers: takers read their own; write only while the attempt is in progress, up to 10 s after the deadline.
create policy answers_taker_select on public.answers
  for select to authenticated using (
    exists (select 1 from public.attempts a where a.id = answers.attempt_id and a.user_id = (select auth.uid()))
  );
create policy answers_taker_insert on public.answers
  for insert to authenticated with check (
    exists (
      select 1
      from public.attempts a
      join public.questions q on q.test_id = a.test_id
      where a.id = answers.attempt_id
        and q.id = answers.question_id
        and a.user_id = (select auth.uid())
        and a.status = 'in_progress'
        and now() <= a.deadline_at + interval '10 seconds'
    )
  );
create policy answers_taker_update on public.answers
  for update to authenticated
  using (
    exists (
      select 1 from public.attempts a
      where a.id = answers.attempt_id
        and a.user_id = (select auth.uid())
        and a.status = 'in_progress'
        and now() <= a.deadline_at + interval '10 seconds'
    )
  )
  with check (
    exists (
      select 1 from public.attempts a
      where a.id = answers.attempt_id
        and a.user_id = (select auth.uid())
        and a.status = 'in_progress'
        and now() <= a.deadline_at + interval '10 seconds'
    )
  );
create policy answers_admin_select on public.answers
  for select to authenticated using ((select public.is_admin()));

-- grades: takers read their own once results are released; nobody writes except the service role.
create policy grades_taker_select on public.grades
  for select to authenticated using (
    exists (
      select 1 from public.attempts a
      join public.tests t on t.id = a.test_id
      where a.id = grades.attempt_id
        and a.user_id = (select auth.uid())
        and t.results_visible
    )
  );
create policy grades_admin_select on public.grades
  for select to authenticated using ((select public.is_admin()));

-- flag_attempts, hint_reveals: admin read only; written by Edge Functions.
create policy flag_attempts_admin_select on public.flag_attempts
  for select to authenticated using ((select public.is_admin()));
create policy hint_reveals_admin_select on public.hint_reveals
  for select to authenticated using ((select public.is_admin()));

-- Belt and braces: authenticated users never write these tables directly.
revoke insert, update, delete on public.attempts, public.grades, public.flag_attempts, public.hint_reveals
  from authenticated;
revoke insert, delete on public.profiles from authenticated;
revoke delete on public.answers from authenticated;
