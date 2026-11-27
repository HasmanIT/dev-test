-- Multiple attempts per test.
--   tests.max_attempts: how many attempts each taker gets (1 = one-shot, NULL = unlimited). Existing tests stay at 1.
--   attempts.attempt_number: 1, 2, 3 ... per taker and test.
-- A taker may have at most one attempt in progress per test. start_attempt enforces the limit and
-- only allows a retake once the test's results are released.

alter table public.tests
  add column max_attempts integer default 1
  check (max_attempts is null or max_attempts between 1 and 100);

alter table public.attempts
  add column attempt_number integer not null default 1 check (attempt_number >= 1);

-- Replace "one attempt per taker and test" with "one row per attempt number".
do $$
declare
  c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.attempts'::regclass
      and con.contype = 'u'
      and (select array_agg(att.attname::text order by att.attname)
           from unnest(con.conkey) k join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k)
          = array['test_id', 'user_id']
  loop
    execute format('alter table public.attempts drop constraint %I', c);
  end loop;
end;
$$;

alter table public.attempts
  add constraint attempts_test_user_number_key unique (test_id, user_id, attempt_number);

create unique index attempts_one_in_progress
  on public.attempts (test_id, user_id)
  where status = 'in_progress';
