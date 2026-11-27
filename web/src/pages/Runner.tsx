import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import confetti from "canvas-confetti";
import { supabase } from "../lib/supabase";
import { ApiError, callFn, clockOffset, errorMessage, must } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDuration } from "../lib/format";
import { TYPE_LABELS, startState, type Attempt, type Hint, type MyHint, type Question, type Response, type Test } from "../lib/types";
import { ErrorBox, Spinner } from "../components/Layout";
import { Markdown } from "../components/Markdown";
import { CodeLines } from "../components/CodeLines";

const SAVE_DEBOUNCE_MS = 600;
const SHORT_MAX = 600;

type SaveState = "idle" | "saving" | "saved" | "error";
interface Capture {
  captured: boolean;
  wrong: number;
}

/** Route /test/:testId: an intern taking a test. */
export function TakeTest() {
  const { testId } = useParams();
  return <Runner testId={testId!} preview={false} />;
}

/** Route /admin/tests/:testId/preview: the admin sees exactly what a taker sees; nothing is saved. */
export function PreviewTest() {
  const { testId } = useParams();
  return <Runner testId={testId!} preview />;
}

function isAnswered(q: Question, r: Response | undefined, cap: Capture | undefined): boolean {
  if (q.type === "ctf") return !!cap?.captured;
  if (!r) return false;
  if (q.type === "mcq") return !!r.selected?.length;
  if (q.type === "short") return !!r.text?.trim();
  return typeof r.line === "number";
}

function Runner({ testId, preview }: { testId: string; preview: boolean }) {
  const { profile } = useAuth();
  // Depend on the id, not the profile object: a session refresh reloads the profile and must not
  // re-run the loader (which would reset a running preview to its start screen).
  const userId = profile?.id;
  const navigate = useNavigate();

  const [test, setTest] = useState<Test | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, Response>>({});
  const [hints, setHints] = useState<MyHint[]>([]);
  const [captures, setCaptures] = useState<Record<string, Capture>>({});
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [needsStart, setNeedsStart] = useState(false);
  const [priorAttempts, setPriorAttempts] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [previewDeadline, setPreviewDeadline] = useState<number | null>(null);
  const [previewEnded, setPreviewEnded] = useState(false);

  const pending = useRef<Map<string, Response>>(new Map());
  const timer = useRef<number | null>(null);
  const autoSubmitted = useRef(false);

  // ---- load ---------------------------------------------------------------
  const loadAttemptData = useCallback(async (a: Attempt) => {
    const [qs, ans, myHints, caps] = await Promise.all([
      supabase.from("questions").select("*").eq("test_id", a.test_id).order("position").order("id"),
      supabase.from("answers").select("question_id, response").eq("attempt_id", a.id),
      supabase.rpc("my_hints", { p_attempt_id: a.id }),
      supabase.rpc("my_captures", { p_attempt_id: a.id }),
    ]);
    setQuestions(must(qs) as Question[]);
    setAnswers(Object.fromEntries((must(ans) as { question_id: string; response: Response }[]).map((r) => [r.question_id, r.response])));
    setHints(must(myHints) as MyHint[]);
    setCaptures(
      Object.fromEntries(
        (must(caps) as { question_id: string; wrong_guesses: number; captured: boolean }[]).map((c) => [
          c.question_id,
          { captured: c.captured, wrong: c.wrong_guesses },
        ]),
      ),
    );
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const t = must(await supabase.from("tests").select("*").eq("id", testId).maybeSingle()) as Test | null;
        if (!t) throw new Error("Test not found, or it isn't open.");
        setTest(t);
        setOffset(await clockOffset());

        if (preview) {
          const qs = must(await supabase.from("questions").select("*").eq("test_id", testId).order("position").order("id")) as Question[];
          const ids = qs.map((q) => q.id);
          const hs = ids.length
            ? (must(await supabase.from("hints").select("*").in("question_id", ids).order("position")) as Hint[])
            : [];
          setQuestions(qs);
          // Admin preview keeps hint text locally and reveals it without any server call.
          setHints(hs.map((h) => ({ hint_id: h.id, question_id: h.question_id, position: h.position, cost_points: h.cost_points, revealed: false, text: h.text })));
          setNeedsStart(true);
        } else {
          const mine = must(
            await supabase.from("attempts").select("*").eq("test_id", testId).eq("user_id", userId!).order("attempt_number"),
          ) as Attempt[];
          const current = mine.find((a) => a.status === "in_progress");
          const state = startState(t, mine, true);
          if (current) {
            setAttempt(current);
            await loadAttemptData(current);
          } else if (state === "start" || state === "retake" || mine.length === 0) {
            setPriorAttempts(mine.length);
            setNeedsStart(true);
          } else {
            // No new attempt allowed right now: show the latest results instead.
            navigate(`/results/${mine[mine.length - 1].id}`, { replace: true });
            return;
          }
        }
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [testId, preview, userId, navigate, loadAttemptData]);

  // ---- clock --------------------------------------------------------------
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const deadline = preview ? previewDeadline : attempt ? new Date(attempt.deadline_at).getTime() : null;
  const remaining = deadline !== null ? deadline - (now + offset) : null;

  // ---- saving -------------------------------------------------------------
  const flush = useCallback(async () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (preview || !attempt || pending.current.size === 0) return true;
    const rows = [...pending.current.entries()].map(([question_id, response]) => ({ attempt_id: attempt.id, question_id, response }));
    pending.current.clear();
    setSaveState("saving");
    const { error: err } = await supabase.from("answers").upsert(rows, { onConflict: "attempt_id,question_id" });
    if (err) {
      setSaveState("error");
      setSaveError(/row-level security/i.test(err.message) ? "Not saved: the deadline has passed." : `Not saved: ${err.message}`);
      return false;
    }
    setSaveState("saved");
    setSaveError(null);
    return true;
  }, [attempt, preview]);

  function setResponse(qid: string, response: Response) {
    setAnswers((prev) => ({ ...prev, [qid]: response }));
    if (preview) return;
    pending.current.set(qid, response);
    setSaveState("saving");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
  }

  useEffect(() => {
    const onUnload = () => void flush();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [flush]);

  // ---- submit -------------------------------------------------------------
  const submit = useCallback(async () => {
    if (preview) {
      setPreviewEnded(true);
      return;
    }
    if (!attempt) return;
    setSubmitting(true);
    setConfirmSubmit(false);
    await flush();
    try {
      await callFn("submit_attempt", { attempt_id: attempt.id });
      navigate(`/results/${attempt.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }, [attempt, flush, navigate, preview]);

  useEffect(() => {
    if (remaining !== null && remaining <= 0 && !autoSubmitted.current && !previewEnded) {
      autoSubmitted.current = true;
      void submit();
    }
  }, [remaining, submit, previewEnded]);

  // ---- start --------------------------------------------------------------
  async function start() {
    setError(null);
    if (preview) {
      setPreviewDeadline(Date.now() + offset + test!.duration_minutes * 60_000);
      setNeedsStart(false);
      return;
    }
    setLoading(true);
    try {
      const res = await callFn<{ attempt: Attempt; server_now: string }>("start_attempt", { test_id: testId });
      setOffset(new Date(res.server_now).getTime() - Date.now());
      const a = { ...res.attempt, user_id: userId! };
      setAttempt(a);
      await loadAttemptData(a);
      setNeedsStart(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const hintsByQ = useMemo(() => {
    const m = new Map<string, MyHint[]>();
    for (const h of hints) m.set(h.question_id, [...(m.get(h.question_id) ?? []), h]);
    return m;
  }, [hints]);

  // ---- render -------------------------------------------------------------
  if (loading) return <Spinner />;
  if (error && !test) return <ErrorBox error={error} />;
  if (!test) return null;

  if (submitting) {
    return (
      <div className="card center">
        <p className="big">Submitting…</p>
        <p className="muted">Grading your answers. This can take a few seconds.</p>
      </div>
    );
  }

  if (previewEnded) {
    return (
      <div className="card center">
        <p className="big">Preview finished</p>
        <p className="muted">In a real attempt the taker would now be submitted and graded. Nothing was saved.</p>
        <Link className="btn" to={`/admin/tests/${testId}`}>
          Back to the editor
        </Link>
      </div>
    );
  }

  if (needsStart) {
    const pts = questions.reduce((s, q) => s + q.points, 0);
    return (
      <section className="start-screen">
        {preview && <div className="alert alert-info">Preview mode: you see what a taker sees. Nothing is saved, and flags can't be checked.</div>}
        <h1>{test.title}</h1>
        <p className="muted">
          {test.duration_minutes} minutes{preview ? ` · ${questions.length} questions · ${pts} points` : ""}
          {!preview && test.max_attempts !== 1 && ` · attempt ${priorAttempts + 1}${test.max_attempts ? ` of ${test.max_attempts}` : ""}`}
        </p>
        <div className="card">
          <Markdown>{test.description || "_No description._"}</Markdown>
        </div>
        <div className="card">
          <h3>Before you start</h3>
          <ul>
            <li>The timer starts when you click Start and keeps running if you close the page.</li>
            <li>Answers save automatically. When time is up, your test is submitted for you.</li>
            <li>Hints cost points. You'll see the cost before you reveal one.</li>
            {test.max_attempts === 1 ? (
              <li>You get one attempt.</li>
            ) : (
              <li>
                {test.max_attempts ? `You get ${test.max_attempts} attempts.` : "You can take this test as many times as you like."} Each attempt is
                graded on its own; you can retake it once your results are released.
              </li>
            )}
          </ul>
        </div>
        <ErrorBox error={error} />
        {test.status !== "open" && !preview ? (
          <p className="muted">This test isn't open.</p>
        ) : (
          <button className="btn btn-primary btn-lg" onClick={start}>
            {preview ? "Start preview" : priorAttempts > 0 ? `Start attempt ${priorAttempts + 1}` : "Start test"}
          </button>
        )}
      </section>
    );
  }

  const q = questions[index];
  const answeredCount = questions.filter((x) => isAnswered(x, answers[x.id], captures[x.id])).length;
  const low = remaining !== null && remaining < 5 * 60_000;

  return (
    <section className="runner">
      <div className="runner-bar">
        <div>
          <strong>{test.title}</strong>
          {preview && <span className="pill">preview</span>}
        </div>
        <div className={`countdown ${low ? "is-low" : ""}`} aria-live="polite" title="Time left (server time)">
          ⏱ {remaining !== null ? fmtDuration(remaining) : "--:--"}
        </div>
        <div className="save-state" aria-live="polite">
          {preview ? "Not saved (preview)" : saveState === "saving" ? "Saving…" : saveState === "saved" ? "All changes saved" : saveState === "error" ? "⚠ Not saved" : ""}
        </div>
        <button className="btn btn-primary" onClick={() => setConfirmSubmit(true)}>
          Submit
        </button>
      </div>

      {saveError && <div className="alert alert-error">{saveError}</div>}
      <ErrorBox error={error} />

      {confirmSubmit && (
        <div className="card confirm">
          <p>
            Submit now? You've answered {answeredCount} of {questions.length} questions. You can't change answers afterwards.
          </p>
          <div className="row">
            <button className="btn btn-primary" onClick={submit}>
              Yes, submit
            </button>
            <button className="btn" onClick={() => setConfirmSubmit(false)}>
              Keep working
            </button>
          </div>
        </div>
      )}

      <nav className="palette" aria-label="Questions">
        {questions.map((x, i) => (
          <button
            key={x.id}
            className={["pal", i === index ? "is-current" : "", isAnswered(x, answers[x.id], captures[x.id]) ? "is-answered" : "", x.type === "ctf" ? "is-ctf" : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={() => {
              void flush();
              setIndex(i);
            }}
            title={TYPE_LABELS[x.type]}
          >
            {x.type === "ctf" ? (captures[x.id]?.captured ? "🚩" : "⚑") : i + 1}
          </button>
        ))}
      </nav>

      {q ? (
        <article className="card question" key={q.id}>
          <header className="row-between">
            <span className="muted">
              Question {index + 1} of {questions.length} · {TYPE_LABELS[q.type]}
            </span>
            <span className="pill">{q.points} pts</span>
          </header>
          <Markdown>{q.prompt}</Markdown>

          <QuestionInput
            q={q}
            response={answers[q.id]}
            onChange={(r) => setResponse(q.id, r)}
            capture={captures[q.id]}
            onCapture={(c) => setCaptures((prev) => ({ ...prev, [q.id]: c }))}
            preview={preview}
          />

          <HintList
            hints={hintsByQ.get(q.id) ?? []}
            preview={preview}
            onRevealed={(h) => setHints((prev) => prev.map((x) => (x.hint_id === h.hint_id ? h : x)))}
          />

          <footer className="row-between">
            <button className="btn" disabled={index === 0} onClick={() => { void flush(); setIndex(index - 1); }}>
              ← Previous
            </button>
            {index < questions.length - 1 ? (
              <button className="btn btn-primary" onClick={() => { void flush(); setIndex(index + 1); }}>
                Next →
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => setConfirmSubmit(true)}>
                Finish
              </button>
            )}
          </footer>
        </article>
      ) : (
        <p className="muted">This test has no questions yet.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

interface InputProps {
  q: Question;
  response: Response | undefined;
  onChange: (r: Response) => void;
  capture: Capture | undefined;
  onCapture: (c: Capture) => void;
  preview: boolean;
}

function QuestionInput({ q, response, onChange, capture, onCapture, preview }: InputProps) {
  if (q.type === "mcq") {
    const choices = q.options.choices ?? [];
    const multiple = !!q.options.multiple;
    const selected = new Set(response?.selected ?? []);
    return (
      <fieldset className="choices">
        <legend className="muted">{multiple ? "Select all that apply" : "Pick one"}</legend>
        {choices.map((c) => (
          <label key={c.id} className={`choice ${selected.has(c.id) ? "is-selected" : ""}`}>
            <input
              type={multiple ? "checkbox" : "radio"}
              name={`q-${q.id}`}
              checked={selected.has(c.id)}
              onChange={() => {
                if (multiple) {
                  const next = new Set(selected);
                  if (next.has(c.id)) next.delete(c.id);
                  else next.add(c.id);
                  onChange({ selected: choices.map((x) => x.id).filter((id) => next.has(id)) });
                } else onChange({ selected: [c.id] });
              }}
            />
            <span>{c.text}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  if (q.type === "short") {
    const text = response?.text ?? "";
    return (
      <div className="short">
        <textarea
          value={text}
          maxLength={SHORT_MAX}
          rows={6}
          placeholder="Type your answer…"
          onChange={(e) => onChange({ text: e.target.value.slice(0, SHORT_MAX) })}
        />
        <div className={`counter ${text.length > SHORT_MAX - 50 ? "is-low" : ""}`}>
          {text.length} / {SHORT_MAX}
        </div>
      </div>
    );
  }

  if (q.type === "bughunt") {
    return (
      <div>
        <CodeLines code={q.options.code ?? ""} selected={response?.line ?? null} onSelect={(line) => onChange({ line })} />
        <p className="muted">{response?.line ? `You picked line ${response.line}.` : "Click the line that contains the bug."}</p>
      </div>
    );
  }

  return <FlagInput q={q} capture={capture} onCapture={onCapture} preview={preview} />;
}

function FlagInput({ q, capture, onCapture, preview }: { q: Question; capture: Capture | undefined; onCapture: (c: Capture) => void; preview: boolean }) {
  const [flag, setFlag] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [, force] = useState(0);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = window.setInterval(() => force((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  const coolLeft = Math.max(0, cooldownUntil - Date.now());

  async function check() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await callFn<{ correct: boolean; wrong_guesses?: number; guesses_before_cooldown?: number | null }>("check_flag", {
        question_id: q.id,
        flag: flag.trim(),
      });
      if (res.correct) {
        onCapture({ captured: true, wrong: capture?.wrong ?? 0 });
        void confetti({ particleCount: 160, spread: 80, origin: { y: 0.6 } });
        setFlag("");
      } else {
        onCapture({ captured: false, wrong: res.wrong_guesses ?? (capture?.wrong ?? 0) + 1 });
        const left = res.guesses_before_cooldown;
        setMsg({ kind: "error", text: `Not that one.${left ? ` ${left} more guess${left === 1 ? "" : "es"} before a 60-second cooldown.` : " Cooldown starts now."}` });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const secs = Number(err.details.retry_after_seconds ?? 60);
        setCooldownUntil(Date.now() + secs * 1000);
        setMsg({ kind: "info", text: "Too many wrong guesses. Take a breath and check your work." });
      } else setMsg({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ctf">
      {q.repo_url && (
        <p>
          Challenge folder:{" "}
          <a href={q.repo_url} target="_blank" rel="noopener noreferrer">
            {q.repo_url.replace(/^https?:\/\//, "")}
          </a>
        </p>
      )}
      {capture?.captured ? (
        <div className="captured">🚩 Flag captured!</div>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!preview && flag.trim() && coolLeft === 0) void check();
          }}
        >
          <input
            className="mono"
            placeholder="FLAG{…}"
            value={flag}
            onChange={(e) => setFlag(e.target.value)}
            maxLength={200}
            disabled={preview}
            aria-label="Flag"
          />
          <button className="btn btn-primary" disabled={preview || busy || !flag.trim() || coolLeft > 0}>
            {coolLeft > 0 ? `Wait ${Math.ceil(coolLeft / 1000)}s` : busy ? "Checking…" : "Submit flag"}
          </button>
        </form>
      )}
      {preview && <p className="muted">Flags can't be checked in preview.</p>}
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
    </div>
  );
}

function HintList({ hints, preview, onRevealed }: { hints: MyHint[]; preview: boolean; onRevealed: (h: MyHint) => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!hints.length) return null;

  async function reveal(h: MyHint) {
    setError(null);
    if (preview) {
      onRevealed({ ...h, revealed: true });
      setConfirming(null);
      return;
    }
    setBusy(true);
    try {
      const res = await callFn<{ text: string }>("reveal_hint", { hint_id: h.hint_id });
      onRevealed({ ...h, revealed: true, text: res.text });
      setConfirming(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hints">
      <h4>Hints</h4>
      {hints.map((h, i) => (
        <div key={h.hint_id} className="hint">
          {h.revealed ? (
            <div>
              <strong>Hint {i + 1}</strong> <span className="muted">(−{h.cost_points} pts)</span>
              <Markdown>{h.text ?? ""}</Markdown>
            </div>
          ) : confirming === h.hint_id ? (
            <div className="row">
              <span>
                Reveal hint {i + 1}? It costs <strong>{h.cost_points} points</strong>.
              </span>
              <button className="btn btn-primary" disabled={busy} onClick={() => reveal(h)}>
                Reveal
              </button>
              <button className="btn" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <button className="btn btn-ghost" onClick={() => setConfirming(h.hint_id)}>
              💡 Hint {i + 1} (−{h.cost_points} pts)
            </button>
          )}
        </div>
      ))}
      <ErrorBox error={error} />
    </div>
  );
}
