import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { errorMessage, must } from "../lib/api";
import { fmtDuration, fmtScore } from "../lib/format";
import { TYPE_LABELS, type Attempt, type Grade, type Question, type Test } from "../lib/types";
import { ErrorBox, Spinner } from "../components/Layout";
import { Markdown } from "../components/Markdown";

export function Results() {
  const { attemptId } = useParams();
  const [data, setData] = useState<{ attempt: Attempt; test: Test; questions: Question[]; grades: Grade[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const attempt = must(await supabase.from("attempts").select("*").eq("id", attemptId!).single()) as Attempt;
        const test = must(await supabase.from("tests").select("*").eq("id", attempt.test_id).single()) as Test;
        const questions = must(await supabase.from("questions").select("*").eq("test_id", test.id).order("position")) as Question[];
        const grades = must(await supabase.from("grades").select("*").eq("attempt_id", attempt.id)) as Grade[];
        setData({ attempt, test, questions, grades });
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [attemptId]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Spinner />;
  const { attempt, test, questions, grades } = data;
  const byQ = new Map(grades.map((g) => [g.question_id, g]));
  const total = grades.reduce((s, g) => s + Number(g.score), 0);
  const max = questions.reduce((s, q) => s + q.points, 0);
  const taken = attempt.submitted_at ? new Date(attempt.submitted_at).getTime() - new Date(attempt.started_at).getTime() : null;

  return (
    <section>
      <p>
        <Link to="/">← My tests</Link>
      </p>
      <h1>{test.title}: results</h1>
      {attempt.status === "in_progress" ? (
        <div className="alert alert-info">
          This attempt is still in progress. <Link to={`/test/${test.id}`}>Go back to the test.</Link>
        </div>
      ) : !test.results_visible ? (
        <div className="card center">
          <p className="big">Submitted ✓</p>
          <p className="muted">Your answers are in. Results appear here once your program lead releases them.</p>
          {taken !== null && <p className="muted">Time taken: {fmtDuration(taken)}</p>}
        </div>
      ) : (
        <>
          <div className="card score-hero">
            <div className="big">
              {fmtScore(total)} <span className="muted">/ {max}</span>
            </div>
            {taken !== null && <div className="muted">Time taken: {fmtDuration(taken)}</div>}
          </div>
          {questions.map((q, i) => {
            const g = byQ.get(q.id);
            return (
              <article key={q.id} className="card result-item">
                <header className="row-between">
                  <strong>
                    Q{i + 1} · {TYPE_LABELS[q.type]}
                  </strong>
                  <span className={`pill ${g && Number(g.score) >= Number(g.max_score) ? "pill-good" : ""}`}>
                    {g ? `${fmtScore(g.score)} / ${fmtScore(g.max_score)}` : `– / ${q.points}`}
                  </span>
                </header>
                <Markdown>{q.prompt}</Markdown>
                {g?.feedback && <p>{g.feedback}</p>}
                {g?.ai_rationale && (
                  <div className="rationale">
                    <strong>Grader:</strong> {g.ai_rationale}
                    {!!g.ai_met?.length && <p className="good">✓ {g.ai_met.join(" · ")}</p>}
                    {!!g.ai_missed?.length && <p className="bad">✗ {g.ai_missed.join(" · ")}</p>}
                  </div>
                )}
                {g && Number(g.hint_penalty) > 0 && <p className="muted">Hint cost: −{fmtScore(g.hint_penalty)}</p>}
              </article>
            );
          })}
        </>
      )}
    </section>
  );
}
