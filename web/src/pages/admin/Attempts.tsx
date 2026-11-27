import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { callFn, errorMessage, must } from "../../lib/api";
import { fmtDateTime, fmtDuration, fmtScore } from "../../lib/format";
import type { Attempt, Grade, Question, Test } from "../../lib/types";
import { ErrorBox, Spinner } from "../../components/Layout";

interface Row extends Attempt {
  profiles: { display_name: string; email: string } | null;
}

interface Stats {
  score: number;
  needsReview: number;
  hintsUsed: number;
  hintCost: number;
  flagsCaptured: number;
  wrongGuesses: number;
  byQuestion: Map<string, Grade>;
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function Attempts() {
  const { testId } = useParams();
  const [test, setTest] = useState<Test | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState<Map<string, Stats>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = must(await supabase.from("tests").select("*").eq("id", testId!).single()) as Test;
      const qs = must(await supabase.from("questions").select("*").eq("test_id", t.id).order("position").order("id")) as Question[];
      const atts = must(
        await supabase.from("attempts").select("*, profiles(display_name, email)").eq("test_id", t.id).order("user_id").order("attempt_number"),
      ) as Row[];
      const ids = atts.map((a) => a.id);
      const [grades, reveals, flags] = ids.length
        ? await Promise.all([
            supabase.from("grades").select("*").in("attempt_id", ids),
            supabase.from("hint_reveals").select("attempt_id, hints(cost_points)").in("attempt_id", ids),
            supabase.from("flag_attempts").select("attempt_id, result").in("attempt_id", ids),
          ])
        : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];

      const m = new Map<string, Stats>();
      for (const a of atts) m.set(a.id, { score: 0, needsReview: 0, hintsUsed: 0, hintCost: 0, flagsCaptured: 0, wrongGuesses: 0, byQuestion: new Map() });
      for (const g of must(grades) as Grade[]) {
        const s = m.get(g.attempt_id)!;
        s.score += Number(g.score);
        if (g.needs_review) s.needsReview += 1;
        s.byQuestion.set(g.question_id, g);
      }
      for (const r of must(reveals) as unknown as { attempt_id: string; hints: { cost_points: number } | null }[]) {
        const s = m.get(r.attempt_id)!;
        s.hintsUsed += 1;
        s.hintCost += r.hints?.cost_points ?? 0;
      }
      for (const f of must(flags) as { attempt_id: string; result: string }[]) {
        const s = m.get(f.attempt_id)!;
        if (f.result === "correct") s.flagsCaptured += 1;
        if (f.result === "wrong") s.wrongGuesses += 1;
      }
      setTest(t);
      setQuestions(qs);
      setRows(atts);
      setStats(m);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [testId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      await load();
    } catch (err) {
      setError(`${label}: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // Each intern's best submitted attempt (ties go to the earliest attempt).
  function bestByUser(): Map<string, { attemptId: string; score: number }> {
    const best = new Map<string, { attemptId: string; score: number }>();
    for (const a of rows) {
      if (a.status === "in_progress") continue;
      const score = stats.get(a.id)?.score ?? 0;
      const cur = best.get(a.user_id);
      if (!cur || score > cur.score) best.set(a.user_id, { attemptId: a.id, score });
    }
    return best;
  }

  function exportCsv() {
    const best = bestByUser();
    const maxPoints = questions.reduce((s, q) => s + q.points, 0);
    const header = [
      "name", "email", "attempt", "is_best_attempt", "best_score", "status", "started_at", "submitted_at", "time_taken_seconds", "score", "max_score",
      "needs_review", "hints_used", "hint_cost", "flags_captured", "wrong_flag_guesses",
      ...questions.map((q, i) => `Q${i + 1}_${q.type}`),
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const a of rows) {
      const s = stats.get(a.id)!;
      const taken = a.submitted_at ? Math.round((new Date(a.submitted_at).getTime() - new Date(a.started_at).getTime()) / 1000) : "";
      lines.push(
        [
          a.profiles?.display_name, a.profiles?.email, a.attempt_number,
          best.get(a.user_id)?.attemptId === a.id ? "yes" : "no",
          best.has(a.user_id) ? fmtScore(best.get(a.user_id)!.score) : "", a.status, a.started_at, a.submitted_at ?? "", taken,
          fmtScore(s.score), maxPoints, s.needsReview, s.hintsUsed, s.hintCost, s.flagsCaptured, s.wrongGuesses,
          ...questions.map((q) => {
            const g = s.byQuestion.get(q.id);
            return g ? fmtScore(g.score) : "";
          }),
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${test!.title.replace(/[^\w-]+/g, "_")}_attempts.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (!test) return error ? <ErrorBox error={error} /> : <Spinner />;
  const maxPoints = questions.reduce((s, q) => s + q.points, 0);
  const best = bestByUser();
  const attemptsPerUser = new Map<string, number>();
  rows.forEach((a) => attemptsPerUser.set(a.user_id, (attemptsPerUser.get(a.user_id) ?? 0) + 1));
  const interns = attemptsPerUser.size;
  const overdue = rows.filter((a) => a.status === "in_progress" && new Date(a.deadline_at).getTime() + 10_000 < Date.now()).length;

  return (
    <section>
      <p>
        <Link to={`/admin/tests/${test.id}`}>← {test.title}</Link>
      </p>
      <div className="row-between">
        <h1>
          Attempts <span className="muted">({rows.length} from {interns} intern{interns === 1 ? "" : "s"})</span>
        </h1>
        <div className="row">
          <button
            className="btn"
            disabled={busy || overdue === 0}
            title="Submit and grade attempts whose time ran out while the browser was closed"
            onClick={() =>
              run("Submit overdue", async () => {
                const r = await callFn<{ submitted: number }>("submit_attempt", { test_id: test.id, overdue_only: true });
                return `Submitted ${r.submitted} overdue attempt(s).`;
              })
            }
          >
            Submit overdue ({overdue})
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              run("Release results", async () => {
                must(await supabase.from("tests").update({ results_visible: !test.results_visible }).eq("id", test.id).select("id"));
                return test.results_visible ? "Results hidden from takers." : "Results released to takers.";
              })
            }
          >
            {test.results_visible ? "Hide results" : "Release results"}
          </button>
          <button className="btn" disabled={!rows.length} onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>
      <ErrorBox error={error} />
      {notice && <div className="alert alert-info">{notice}</div>}

      <table className="table">
        <thead>
          <tr>
            <th>Taker</th>
            <th>Attempt</th>
            <th>Status</th>
            <th>Started</th>
            <th>Time taken</th>
            <th>Score</th>
            <th>Hints</th>
            <th>Flags</th>
            <th>Review</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const s = stats.get(a.id)!;
            const isBest = best.get(a.user_id)?.attemptId === a.id && (attemptsPerUser.get(a.user_id) ?? 0) > 1;
            const taken = a.submitted_at ? new Date(a.submitted_at).getTime() - new Date(a.started_at).getTime() : null;
            return (
              <tr key={a.id} className={s.needsReview ? "needs-review" : ""}>
                <td>
                  <Link to={`/admin/attempts/${a.id}`}>{a.profiles?.display_name || "(no name)"}</Link>
                  <div className="muted small">{a.profiles?.email}</div>
                </td>
                <td>
                  #{a.attempt_number}
                  {isBest && (
                    <span className="best-mark" title="Best attempt">
                      {" "}
                      ★ best
                    </span>
                  )}
                </td>
                <td>
                  <span className={`pill pill-${a.status}`}>{a.status.replace("_", " ")}</span>
                </td>
                <td>{fmtDateTime(a.started_at)}</td>
                <td>{taken !== null ? fmtDuration(taken) : "—"}</td>
                <td>
                  {a.status === "in_progress" ? "—" : `${fmtScore(s.score)} / ${maxPoints}`}
                </td>
                <td>{s.hintsUsed ? `${s.hintsUsed} (−${s.hintCost})` : "0"}</td>
                <td>
                  {s.flagsCaptured} 🚩{s.wrongGuesses ? <span className="muted"> · {s.wrongGuesses} wrong</span> : null}
                </td>
                <td>{s.needsReview ? <span className="pill pill-warn">{s.needsReview} to review</span> : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <p className="muted">No attempts yet.</p>}
    </section>
  );
}
