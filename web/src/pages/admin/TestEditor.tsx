import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { errorMessage, must } from "../../lib/api";
import { TYPE_LABELS, type Hint, type Question, type QuestionKey, type QuestionType, type Test, type TestStatus } from "../../lib/types";
import { ErrorBox, Spinner } from "../../components/Layout";
import { Markdown } from "../../components/Markdown";
import { QuestionEditor } from "./QuestionEditor";

const NEW_QUESTION: Record<QuestionType, Pick<Question, "points" | "options" | "prompt">> = {
  mcq: { points: 2, prompt: "", options: { choices: [{ id: "a", text: "" }, { id: "b", text: "" }], multiple: false } },
  short: { points: 5, prompt: "", options: {} },
  bughunt: { points: 4, prompt: "Find the line with the bug.", options: { code: "", language: "python" } },
  ctf: { points: 20, prompt: "", options: {} },
};

export function TestEditor() {
  const { testId } = useParams();
  const navigate = useNavigate();
  const [test, setTest] = useState<Test | null>(null);
  const [draft, setDraft] = useState<Pick<Test, "title" | "description" | "duration_minutes"> | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [keys, setKeys] = useState<Map<string, QuestionKey>>(new Map());
  const [hints, setHints] = useState<Hint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDescPreview, setShowDescPreview] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // Each load or local change bumps this; a load only applies its results if nothing newer happened.
  const version = useRef(0);

  const load = useCallback(async () => {
    const mine = ++version.current;
    try {
      const t = must(await supabase.from("tests").select("*").eq("id", testId!).single()) as Test;
      const qs = must(await supabase.from("questions").select("*").eq("test_id", t.id).order("position").order("id")) as Question[];
      const ids = qs.map((q) => q.id);
      const ks = ids.length ? (must(await supabase.from("question_keys").select("question_id, correct, rubric, model_answer, flag_hash").in("question_id", ids)) as QuestionKey[]) : [];
      const hs = ids.length ? (must(await supabase.from("hints").select("*").in("question_id", ids).order("position")) as Hint[]) : [];
      if (mine !== version.current) return; // a newer load or local edit superseded this one
      setTest(t);
      // Keep unsaved edits: reloads (after saving a question, or StrictMode's double effect) must not clobber the draft.
      setDraft((prev) => prev ?? { title: t.title, description: t.description, duration_minutes: t.duration_minutes });
      setQuestions(qs);
      setKeys(new Map(ks.map((k) => [k.question_id, k])));
      setHints(hs);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [testId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function updateTest(patch: Partial<Test>, message: string) {
    setError(null);
    try {
      const t = must(await supabase.from("tests").update(patch).eq("id", testId!).select().single()) as Test;
      setTest(t);
      setNotice(message);
      window.setTimeout(() => setNotice(null), 2500);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function addQuestion(type: QuestionType) {
    setError(null);
    try {
      const position = questions.length ? Math.max(...questions.map((q) => q.position)) + 1 : 1;
      const q = must(
        await supabase
          .from("questions")
          .insert({ test_id: testId, type, position, ...NEW_QUESTION[type] })
          .select()
          .single(),
      ) as Question;
      setOpenId(q.id);
      await load(); // supersedes any older in-flight load that doesn't know about this question
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function move(index: number, dir: -1 | 1) {
    const other = index + dir;
    if (other < 0 || other >= questions.length) return;
    const a = questions[index];
    const b = questions[other];
    try {
      // Renumber everything 1..n so positions stay unique and gap-free.
      const reordered = [...questions];
      reordered[index] = b;
      reordered[other] = a;
      await Promise.all(reordered.map((q, i) => supabase.from("questions").update({ position: i + 1 }).eq("id", q.id)));
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeQuestion(q: Question) {
    if (!window.confirm(`Delete this ${TYPE_LABELS[q.type]} question? Answers and grades for it are deleted too.`)) return;
    try {
      must(await supabase.from("questions").delete().eq("id", q.id).select("id"));
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function deleteTest() {
    if (!window.confirm("Delete this test, its questions and every attempt? This can't be undone.")) return;
    try {
      must(await supabase.from("tests").delete().eq("id", testId!).select("id"));
      navigate("/admin");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!test || !draft) return error ? <ErrorBox error={error} /> : <Spinner />;
  const totalPoints = questions.reduce((s, q) => s + q.points, 0);
  const dirty = draft.title !== test.title || draft.description !== test.description || draft.duration_minutes !== test.duration_minutes;
  const counts = questions.reduce<Record<string, number>>((m, q) => ({ ...m, [q.type]: (m[q.type] ?? 0) + 1 }), {});

  return (
    <section>
      <p>
        <Link to="/admin">← Tests</Link>
      </p>
      <div className="row-between">
        <h1>{test.title}</h1>
        <div className="row">
          <Link className="btn" to={`/admin/tests/${test.id}/preview`}>
            Preview as taker
          </Link>
          <Link className="btn" to={`/admin/tests/${test.id}/attempts`}>
            Attempts
          </Link>
        </div>
      </div>
      <ErrorBox error={error} />
      {notice && <div className="alert alert-info">{notice}</div>}

      <div className="card">
        <div className="row-between">
          <h2>Settings</h2>
          <div className="row">
            <span className={`pill pill-${test.status}`}>{test.status}</span>
            {(["draft", "open", "closed"] as TestStatus[])
              .filter((s) => s !== test.status)
              .map((s) => (
                <button key={s} className="btn" onClick={() => updateTest({ status: s }, `Test is now ${s}.`)}>
                  {s === "open" ? "Open test" : s === "closed" ? "Close test" : "Back to draft"}
                </button>
              ))}
            <label className="toggle">
              <input
                type="checkbox"
                checked={test.results_visible}
                onChange={(e) => updateTest({ results_visible: e.target.checked }, e.target.checked ? "Results released to takers." : "Results hidden from takers.")}
              />
              Results released
            </label>
          </div>
        </div>
        <label>
          Title
          <input value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </label>
        <label>
          Duration (minutes)
          <input
            type="number"
            min={1}
            max={240}
            value={draft.duration_minutes}
            onChange={(e) => setDraft({ ...draft, duration_minutes: Number(e.target.value) })}
          />
        </label>
        <label>
          Description (markdown; state the rule on AI use here)
          <textarea rows={6} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </label>
        <button type="button" className="btn btn-link" onClick={() => setShowDescPreview(!showDescPreview)}>
          {showDescPreview ? "Hide preview" : "Show preview"}
        </button>
        {showDescPreview && (
          <div className="card inset">
            <Markdown>{draft.description}</Markdown>
          </div>
        )}
        <div className="row">
          <button className="btn btn-primary" disabled={!dirty} onClick={() => updateTest(draft, "Settings saved.")}>
            Save settings
          </button>
          <button className="btn btn-danger" onClick={deleteTest}>
            Delete test
          </button>
        </div>
      </div>

      <div className="row-between">
        <h2>
          Questions <span className="muted">({questions.length} · {totalPoints} pts)</span>
        </h2>
        <span className="muted">
          Aim for about 5 quick-fire · 2 short · 1 bug hunt · 2–3 CTF. Now: {counts.mcq ?? 0} · {counts.short ?? 0} · {counts.bughunt ?? 0} · {counts.ctf ?? 0}
        </span>
      </div>

      {questions.map((q, i) => (
        <QuestionEditor
          key={q.id}
          index={i}
          question={q}
          questionKey={keys.get(q.id) ?? null}
          hints={hints.filter((h) => h.question_id === q.id)}
          open={openId === q.id}
          onToggle={() => setOpenId(openId === q.id ? null : q.id)}
          onMoveUp={i > 0 ? () => move(i, -1) : undefined}
          onMoveDown={i < questions.length - 1 ? () => move(i, 1) : undefined}
          onDelete={() => removeQuestion(q)}
          onSaved={load}
        />
      ))}

      <div className="card add-question">
        <span>Add a question:</span>
        {(Object.keys(TYPE_LABELS) as QuestionType[]).map((t) => (
          <button key={t} className="btn" onClick={() => addQuestion(t)}>
            + {TYPE_LABELS[t]}
          </button>
        ))}
      </div>
    </section>
  );
}
