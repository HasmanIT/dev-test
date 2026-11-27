import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { errorMessage, must } from "../lib/api";
import { useAuth } from "../lib/auth";
import { attemptsLabel, startState, type Attempt, type Test } from "../lib/types";
import { ErrorBox, Spinner } from "../components/Layout";

interface Summary {
  test_id: string;
  question_count: number;
  total_points: number;
}

export function Home() {
  const { profile } = useAuth();
  const [tests, setTests] = useState<Test[] | null>(null);
  const [attempts, setAttempts] = useState<Map<string, Attempt[]>>(new Map());
  const [summaries, setSummaries] = useState<Map<string, Summary>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const myAttempts = must(
          await supabase.from("attempts").select("*").eq("user_id", profile!.id).order("attempt_number"),
        ) as Attempt[];
        const attemptTestIds = [...new Set(myAttempts.map((a) => a.test_id))];
        let query = supabase.from("tests").select("*").order("created_at", { ascending: false });
        query = attemptTestIds.length
          ? query.or(`status.eq.open,id.in.(${attemptTestIds.join(",")})`)
          : query.eq("status", "open");
        const list = must(await query) as Test[];
        const sums = must(await supabase.rpc("test_summaries")) as Summary[];
        const byTest = new Map<string, Attempt[]>();
        for (const a of myAttempts) byTest.set(a.test_id, [...(byTest.get(a.test_id) ?? []), a]);
        setAttempts(byTest);
        setSummaries(new Map(sums.map((s) => [s.test_id, s])));
        setTests(list);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [profile]);

  if (error) return <ErrorBox error={error} />;
  if (!tests) return <Spinner />;
  const isTaker = profile?.role === "taker";

  return (
    <section>
      <h1>Hi {profile?.display_name || "there"} 👋</h1>
      {profile?.role === "admin" && (
        <div className="alert alert-info">
          You're an admin. Admins can't take tests, but you can <Link to="/admin">manage tests</Link> and preview them.
        </div>
      )}
      {tests.length === 0 && <p className="muted">No tests are open right now. Check back when your program lead opens one.</p>}
      <div className="grid">
        {tests.map((t) => {
          const mine = attempts.get(t.id) ?? [];
          const s = summaries.get(t.id);
          const state = startState(t, mine, isTaker);
          const done = mine.filter((a) => a.status !== "in_progress");
          return (
            <article key={t.id} className="card test-card">
              <h2>{t.title}</h2>
              <p className="muted">
                {t.duration_minutes} minutes
                {s ? ` · ${s.question_count} questions · ${s.total_points} points` : ""} · {attemptsLabel(t)}
              </p>

              {done.length > 0 && (
                <ul className="attempt-list">
                  {done.map((a) => (
                    <li key={a.id}>
                      <Link to={`/results/${a.id}`}>
                        Attempt {a.attempt_number}: {t.results_visible ? "see results" : "submitted ✓"}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {state === "start" && (
                <Link className="btn btn-primary" to={`/test/${t.id}`}>
                  View & start
                </Link>
              )}
              {state === "continue" && (
                <Link className="btn btn-primary" to={`/test/${t.id}`}>
                  Continue attempt {mine.find((a) => a.status === "in_progress")?.attempt_number}
                </Link>
              )}
              {state === "retake" && (
                <Link className="btn btn-primary" to={`/test/${t.id}`}>
                  Start attempt {mine.length + 1}
                </Link>
              )}
              {state === "wait_for_results" && t.max_attempts !== 1 && (
                <p className="muted small">You can retake this test once your results are released.</p>
              )}
              {state === "no_attempts_left" && t.max_attempts !== 1 && <p className="muted small">You've used all your attempts.</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
