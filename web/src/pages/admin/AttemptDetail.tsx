import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { callFn, errorMessage, must } from "../../lib/api";
import { fmtDateTime, fmtDuration, fmtScore } from "../../lib/format";
import { TYPE_LABELS, type Attempt, type Grade, type Question, type QuestionKey, type Response, type Test } from "../../lib/types";
import { ErrorBox, Spinner } from "../../components/Layout";
import { Markdown } from "../../components/Markdown";
import { CodeLines } from "../../components/CodeLines";

interface Data {
  attempt: Attempt & { profiles: { display_name: string; email: string } | null };
  test: Test;
  questions: Question[];
  keys: Map<string, QuestionKey>;
  answers: Map<string, Response>;
  grades: Map<string, Grade>;
  hintCost: Map<string, { count: number; cost: number }>;
  flags: Map<string, { correct: boolean; wrong: number }>;
}

export function AttemptDetail() {
  const { attemptId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const attempt = must(await supabase.from("attempts").select("*, profiles(display_name, email)").eq("id", attemptId!).single()) as Data["attempt"];
      const test = must(await supabase.from("tests").select("*").eq("id", attempt.test_id).single()) as Test;
      const questions = must(await supabase.from("questions").select("*").eq("test_id", test.id).order("position").order("id")) as Question[];
      const qids = questions.map((q) => q.id);
      const [keys, answers, grades, reveals, flags] = await Promise.all([
        qids.length ? supabase.from("question_keys").select("question_id, correct, rubric, model_answer, flag_hash").in("question_id", qids) : Promise.resolve({ data: [], error: null }),
        supabase.from("answers").select("question_id, response").eq("attempt_id", attempt.id),
        supabase.from("grades").select("*").eq("attempt_id", attempt.id),
        supabase.from("hint_reveals").select("hints(question_id, cost_points)").eq("attempt_id", attempt.id),
        supabase.from("flag_attempts").select("question_id, result").eq("attempt_id", attempt.id),
      ]);
      const hintCost = new Map<string, { count: number; cost: number }>();
      for (const r of must(reveals) as unknown as { hints: { question_id: string; cost_points: number } | null }[]) {
        if (!r.hints) continue;
        const cur = hintCost.get(r.hints.question_id) ?? { count: 0, cost: 0 };
        hintCost.set(r.hints.question_id, { count: cur.count + 1, cost: cur.cost + r.hints.cost_points });
      }
      const flagMap = new Map<string, { correct: boolean; wrong: number }>();
      for (const f of must(flags) as { question_id: string; result: string }[]) {
        const cur = flagMap.get(f.question_id) ?? { correct: false, wrong: 0 };
        flagMap.set(f.question_id, { correct: cur.correct || f.result === "correct", wrong: cur.wrong + (f.result === "wrong" ? 1 : 0) });
      }
      setData({
        attempt,
        test,
        questions,
        keys: new Map((must(keys) as QuestionKey[]).map((k) => [k.question_id, k])),
        answers: new Map((must(answers) as { question_id: string; response: Response }[]).map((a) => [a.question_id, a.response])),
        grades: new Map((must(grades) as Grade[]).map((g) => [g.question_id, g])),
        hintCost,
        flags: flagMap,
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!data) return;
    if (!window.confirm(`Reset ${data.attempt.profiles?.display_name}'s attempt? Their answers, grades, hints and flag guesses are deleted and they can start again.`)) return;
    setBusy(true);
    try {
      await callFn("reset_attempt", { attempt_id: data.attempt.id });
      navigate(`/admin/tests/${data.test.id}/attempts`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (!data) return error ? <ErrorBox error={error} /> : <Spinner />;
  const { attempt, test, questions } = data;
  const total = [...data.grades.values()].reduce((s, g) => s + Number(g.score), 0);
  const max = questions.reduce((s, q) => s + q.points, 0);
  const taken = attempt.submitted_at ? new Date(attempt.submitted_at).getTime() - new Date(attempt.started_at).getTime() : null;

  return (
    <section>
      <p>
        <Link to={`/admin/tests/${test.id}/attempts`}>← Attempts for {test.title}</Link>
      </p>
      <div className="row-between">
        <div>
          <h1>{attempt.profiles?.display_name}</h1>
          <p className="muted">
            {attempt.profiles?.email} · <span className={`pill pill-${attempt.status}`}>{attempt.status.replace("_", " ")}</span> · started{" "}
            {fmtDateTime(attempt.started_at)} · {taken !== null ? `took ${fmtDuration(taken)}` : `deadline ${fmtDateTime(attempt.deadline_at)}`}
          </p>
        </div>
        <div className="row">
          {attempt.status === "in_progress" && (
            <button className="btn" disabled={busy} onClick={() => act(async () => { await callFn("submit_attempt", { attempt_id: attempt.id }); return "Attempt submitted and graded."; })}>
              Submit now
            </button>
          )}
          <button className="btn btn-danger" disabled={busy} onClick={reset}>
            Reset attempt
          </button>
        </div>
      </div>
      <div className="card score-hero">
        <div className="big">
          {fmtScore(total)} <span className="muted">/ {max}</span>
        </div>
        <div className="muted">{test.results_visible ? "Results are released to the taker." : "Results are hidden from the taker."}</div>
      </div>
      <ErrorBox error={error} />
      {notice && <div className="alert alert-info">{notice}</div>}

      {questions.map((q, i) => (
        <QuestionReview
          key={q.id}
          index={i}
          q={q}
          k={data.keys.get(q.id)}
          answer={data.answers.get(q.id)}
          grade={data.grades.get(q.id)}
          hints={data.hintCost.get(q.id)}
          flag={data.flags.get(q.id)}
          submitted={attempt.status !== "in_progress"}
          busy={busy}
          onOverride={(score, feedback) =>
            act(async () => {
              await callFn("override_grade", { attempt_id: attempt.id, question_id: q.id, score, feedback });
              return `Q${i + 1} overridden to ${score}.`;
            })
          }
          onRegrade={() =>
            act(async () => {
              const r = await callFn<{ needs_review: number }>("grade_written", { attempt_id: attempt.id, question_id: q.id });
              return r.needs_review ? `Q${i + 1}: AI grading failed again and is marked for review.` : `Q${i + 1} re-graded by AI.`;
            })
          }
        />
      ))}
    </section>
  );
}

interface ReviewProps {
  index: number;
  q: Question;
  k: QuestionKey | undefined;
  answer: Response | undefined;
  grade: Grade | undefined;
  hints: { count: number; cost: number } | undefined;
  flag: { correct: boolean; wrong: number } | undefined;
  submitted: boolean;
  busy: boolean;
  onOverride: (score: number, feedback: string | null) => void;
  onRegrade: () => void;
}

function QuestionReview({ index, q, k, answer, grade, hints, flag, submitted, busy, onOverride, onRegrade }: ReviewProps) {
  const [score, setScore] = useState(grade ? String(grade.score) : "");
  const [feedback, setFeedback] = useState(grade?.feedback ?? "");
  const [showOverride, setShowOverride] = useState(false);

  return (
    <article className={`card result-item ${grade?.needs_review ? "needs-review" : ""}`}>
      <header className="row-between">
        <strong>
          Q{index + 1} · {TYPE_LABELS[q.type]}
        </strong>
        <span className="row">
          {grade?.needs_review && <span className="pill pill-warn">needs review</span>}
          {grade && <span className="pill">by {grade.graded_by}</span>}
          <span className="pill">{grade ? `${fmtScore(grade.score)} / ${fmtScore(grade.max_score)}` : `– / ${q.points}`}</span>
        </span>
      </header>
      <details>
        <summary>Prompt</summary>
        <Markdown>{q.prompt}</Markdown>
      </details>

      <div className="review-grid">
        <div>
          <h4>Answer</h4>
          {q.type === "mcq" && (
            <ul className="plain">
              {(q.options.choices ?? []).map((c) => {
                const picked = answer?.selected?.includes(c.id);
                const right = Array.isArray(k?.correct) && k!.correct.includes(c.id);
                return (
                  <li key={c.id} className={right ? "good" : picked ? "bad" : ""}>
                    {picked ? "☑" : "☐"} {c.text} {right && "✓"}
                  </li>
                );
              })}
            </ul>
          )}
          {q.type === "short" && <blockquote className="answer-text">{answer?.text || <em className="muted">No answer</em>}</blockquote>}
          {q.type === "bughunt" && (
            <>
              <p>
                Picked line {answer?.line ?? "—"} · key line {typeof k?.correct === "number" ? k.correct : "—"}
              </p>
              <CodeLines code={q.options.code ?? ""} selected={answer?.line ?? null} correct={typeof k?.correct === "number" ? k.correct : null} />
            </>
          )}
          {q.type === "ctf" && (
            <p>
              {flag?.correct ? "🚩 Captured" : "Not captured"} · {flag?.wrong ?? 0} wrong guess(es)
            </p>
          )}
          {hints && (
            <p className="muted">
              Hints revealed: {hints.count} (−{hints.cost} pts)
            </p>
          )}
        </div>
        <div>
          <h4>Grading</h4>
          {q.type === "short" && k && (
            <details>
              <summary>Rubric & model answer</summary>
              <pre className="pre-wrap">{k.rubric}</pre>
              <p className="muted">Model answer:</p>
              <pre className="pre-wrap">{k.model_answer}</pre>
            </details>
          )}
          {grade?.feedback && <p>{grade.feedback}</p>}
          {grade?.ai_rationale && (
            <div className="rationale">
              <strong>AI rationale:</strong> {grade.ai_rationale}
              {!!grade.ai_met?.length && <p className="good">✓ {grade.ai_met.join(" · ")}</p>}
              {!!grade.ai_missed?.length && <p className="bad">✗ {grade.ai_missed.join(" · ")}</p>}
            </div>
          )}
          {submitted && (
            <div className="row">
              <button className="btn" onClick={() => setShowOverride(!showOverride)}>
                Override score
              </button>
              {q.type === "short" && (
                <button className="btn" disabled={busy} onClick={onRegrade}>
                  Re-run AI grading
                </button>
              )}
            </div>
          )}
          {showOverride && (
            <form
              className="override"
              onSubmit={(e) => {
                e.preventDefault();
                onOverride(Number(score), feedback.trim() || null);
                setShowOverride(false);
              }}
            >
              <label className="narrow">
                Score (0–{q.points})
                <input type="number" step="0.5" min={0} max={q.points} value={score} onChange={(e) => setScore(e.target.value)} required />
              </label>
              <label>
                Feedback to the taker
                <textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
              </label>
              <button className="btn btn-primary" disabled={busy}>
                Save override
              </button>
            </form>
          )}
        </div>
      </div>
    </article>
  );
}
