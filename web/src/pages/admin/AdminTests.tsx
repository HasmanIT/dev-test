import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { errorMessage, must } from "../../lib/api";
import { fmtDateTime } from "../../lib/format";
import type { Test } from "../../lib/types";
import { ErrorBox, Spinner } from "../../components/Layout";

interface Summary {
  test_id: string;
  question_count: number;
  total_points: number;
}

export function AdminTests() {
  const navigate = useNavigate();
  const [tests, setTests] = useState<Test[] | null>(null);
  const [summaries, setSummaries] = useState<Map<string, Summary>>(new Map());
  const [attemptCounts, setAttemptCounts] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = must(await supabase.from("tests").select("*").order("created_at", { ascending: false })) as Test[];
        const sums = must(await supabase.rpc("test_summaries")) as Summary[];
        const atts = must(await supabase.from("attempts").select("test_id")) as { test_id: string }[];
        const counts = new Map<string, number>();
        atts.forEach((a) => counts.set(a.test_id, (counts.get(a.test_id) ?? 0) + 1));
        setSummaries(new Map(sums.map((s) => [s.test_id, s])));
        setAttemptCounts(counts);
        setTests(list);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, []);

  async function createTest() {
    try {
      const t = must(
        await supabase
          .from("tests")
          .insert({ title: "Untitled test", description: "", duration_minutes: 40, status: "draft" })
          .select()
          .single(),
      ) as Test;
      navigate(`/admin/tests/${t.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!tests) return error ? <ErrorBox error={error} /> : <Spinner />;

  return (
    <section>
      <div className="row-between">
        <h1>Tests</h1>
        <button className="btn btn-primary" onClick={createTest}>
          + New test
        </button>
      </div>
      <ErrorBox error={error} />
      <table className="table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Status</th>
            <th>Questions</th>
            <th>Points</th>
            <th>Attempts</th>
            <th>Results</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tests.map((t) => {
            const s = summaries.get(t.id);
            return (
              <tr key={t.id}>
                <td>
                  <Link to={`/admin/tests/${t.id}`}>{t.title}</Link>
                </td>
                <td>
                  <span className={`pill pill-${t.status}`}>{t.status}</span>
                </td>
                <td>{s?.question_count ?? 0}</td>
                <td>{s?.total_points ?? 0}</td>
                <td>{attemptCounts.get(t.id) ?? 0}</td>
                <td>{t.results_visible ? "released" : "hidden"}</td>
                <td>{fmtDateTime(t.updated_at)}</td>
                <td className="actions">
                  <Link to={`/admin/tests/${t.id}`}>Edit</Link>
                  <Link to={`/admin/tests/${t.id}/preview`}>Preview</Link>
                  <Link to={`/admin/tests/${t.id}/attempts`}>Attempts</Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {tests.length === 0 && <p className="muted">No tests yet.</p>}
    </section>
  );
}
