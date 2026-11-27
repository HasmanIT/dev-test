import { useState } from "react";
import { supabase } from "../../lib/supabase";
import { callFn, errorMessage, must } from "../../lib/api";
import { TYPE_LABELS, type Choice, type Hint, type Question, type QuestionKey } from "../../lib/types";
import { ErrorBox } from "../../components/Layout";
import { Markdown } from "../../components/Markdown";
import { CodeLines } from "../../components/CodeLines";

interface Props {
  index: number;
  question: Question;
  questionKey: QuestionKey | null;
  hints: Hint[];
  open: boolean;
  onToggle: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDelete: () => void;
  onSaved: () => Promise<void>;
}

interface DraftHint {
  id?: string;
  text: string;
  cost_points: number;
  deleted?: boolean;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function lineCount(code: string): number {
  const trimmed = code.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return trimmed ? trimmed.split("\n").length : 0;
}

export function QuestionEditor(props: Props) {
  const { index, question: q, questionKey: key, open } = props;
  const [prompt, setPrompt] = useState(q.prompt);
  const [points, setPoints] = useState(q.points);
  const [repoUrl, setRepoUrl] = useState(q.repo_url ?? "");
  const [choices, setChoices] = useState<Choice[]>(q.options.choices ?? []);
  const [multiple, setMultiple] = useState(!!q.options.multiple);
  const [code, setCode] = useState(q.options.code ?? "");
  const [correctIds, setCorrectIds] = useState<string[]>(Array.isArray(key?.correct) ? key!.correct : []);
  const [correctLine, setCorrectLine] = useState<number | null>(typeof key?.correct === "number" ? key.correct : null);
  const [rubric, setRubric] = useState(key?.rubric ?? "");
  const [modelAnswer, setModelAnswer] = useState(key?.model_answer ?? "");
  const [flag, setFlag] = useState("");
  const [hints, setHints] = useState<DraftHint[]>(props.hints.map((h) => ({ id: h.id, text: h.text, cost_points: h.cost_points })));
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const keyMissing =
    (q.type === "mcq" && !(Array.isArray(key?.correct) && key!.correct.length)) ||
    (q.type === "bughunt" && typeof key?.correct !== "number") ||
    (q.type === "short" && !key?.rubric) ||
    (q.type === "ctf" && !key?.flag_hash);

  function warnings(): string[] {
    const w: string[] = [];
    if (!prompt.trim()) w.push("The prompt is empty.");
    if (q.type === "mcq") {
      if (choices.filter((c) => c.text.trim()).length < 2) w.push("Give at least two options.");
      if (!correctIds.length) w.push("Mark at least one correct option.");
      if (!multiple && correctIds.length > 1) w.push("Single-choice questions should have exactly one correct option.");
    }
    if (q.type === "bughunt") {
      const n = lineCount(code);
      if (n < 10 || n > 25) w.push(`Bug-hunt snippets should be 10–25 lines (this one has ${n}).`);
      if (!correctLine) w.push("Click the buggy line in the preview to set the key.");
      else if (correctLine > n) w.push("The key line is past the end of the snippet.");
    }
    if (q.type === "short") {
      const rubricPoints = rubric.split("\n").filter((l) => l.trim()).length;
      if (rubricPoints < 2 || rubricPoints > 4) w.push("Rubrics should list two to four key points, one per line.");
    }
    if (q.type === "ctf") {
      if (!key?.flag_hash && !flag.trim()) w.push("No flag set yet.");
      if (!repoUrl.trim()) w.push("Add the challenge folder's URL.");
      const live = hints.filter((h) => !h.deleted);
      if (live.length < 2 || live.length > 3) w.push("CTF questions should have 2–3 hints.");
      if (live.some((h) => h.cost_points < points * 0.1 || h.cost_points > points * 0.25))
        w.push(`Each CTF hint should cost 10–25% of the points (${Math.ceil(points * 0.1)}–${Math.floor(points * 0.25)}).`);
    }
    return w;
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const options =
        q.type === "mcq"
          ? { choices: choices.filter((c) => c.text.trim()), multiple }
          : q.type === "bughunt"
            ? { code, language: q.options.language ?? "python" }
            : {};
      must(
        await supabase
          .from("questions")
          .update({ prompt, points, options, repo_url: q.type === "ctf" ? repoUrl.trim() || null : null })
          .eq("id", q.id)
          .select("id"),
      );

      const keyBody: Record<string, unknown> = { question_id: q.id };
      if (q.type === "mcq") keyBody.correct = correctIds.filter((id) => choices.some((c) => c.id === id && c.text.trim()));
      if (q.type === "bughunt") keyBody.correct = correctLine;
      if (q.type === "short") {
        keyBody.rubric = rubric;
        keyBody.model_answer = modelAnswer;
      }
      if (q.type === "ctf" && flag.trim()) keyBody.flag = flag.trim();
      await callFn("set_question_key", keyBody);
      setFlag("");

      // Sync hints: delete removed, update existing, insert new.
      let position = 0;
      const kept: DraftHint[] = [];
      for (const h of hints) {
        if (h.deleted) {
          if (h.id) must(await supabase.from("hints").delete().eq("id", h.id).select("id"));
          continue;
        }
        const row = { question_id: q.id, text: h.text.trim(), cost_points: h.cost_points, position: position + 1 };
        if (!row.text) {
          if (h.id) must(await supabase.from("hints").delete().eq("id", h.id).select("id"));
          continue;
        }
        position += 1;
        if (h.id) {
          must(await supabase.from("hints").update(row).eq("id", h.id).select("id"));
          kept.push(h);
        } else {
          const inserted = must(await supabase.from("hints").insert(row).select("id").single()) as { id: string };
          kept.push({ ...h, id: inserted.id });
        }
      }
      setHints(kept);

      setSaved(true);
      await props.onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const summary = q.prompt.split("\n")[0].replace(/[#*_`>]/g, "").slice(0, 90) || "(no prompt yet)";

  return (
    <div className={`card qedit ${open ? "is-open" : ""}`}>
      <header className="row-between">
        <button className="btn btn-link qedit-title" onClick={props.onToggle} aria-expanded={open}>
          <strong>Q{index + 1}</strong> <span className="pill">{TYPE_LABELS[q.type]}</span> {summary}{" "}
          <span className="muted">· {q.points} pts</span>
          {keyMissing && <span className="pill pill-warn">no key</span>}
        </button>
        <div className="row">
          <button className="btn btn-ghost" disabled={!props.onMoveUp} onClick={props.onMoveUp} aria-label="Move up">
            ↑
          </button>
          <button className="btn btn-ghost" disabled={!props.onMoveDown} onClick={props.onMoveDown} aria-label="Move down">
            ↓
          </button>
          <button className="btn btn-ghost btn-danger" onClick={props.onDelete}>
            Delete
          </button>
        </div>
      </header>

      {open && (
        <div className="qedit-body">
          <label>
            Prompt (markdown)
            <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <button type="button" className="btn btn-link" onClick={() => setShowPreview(!showPreview)}>
            {showPreview ? "Hide preview" : "Show preview"}
          </button>
          {showPreview && (
            <div className="card inset">
              <Markdown>{prompt}</Markdown>
            </div>
          )}
          <label className="narrow">
            Points
            <input type="number" min={0} max={1000} value={points} onChange={(e) => setPoints(Number(e.target.value))} />
          </label>

          {q.type === "mcq" && (
            <fieldset>
              <legend>Options (tick the correct ones)</legend>
              {choices.map((c, i) => (
                <div className="row" key={c.id}>
                  <input
                    type="checkbox"
                    aria-label={`Option ${c.id} is correct`}
                    checked={correctIds.includes(c.id)}
                    onChange={(e) =>
                      setCorrectIds(e.target.checked ? [...correctIds, c.id] : correctIds.filter((x) => x !== c.id))
                    }
                  />
                  <span className="mono">{c.id}</span>
                  <input
                    className="grow"
                    value={c.text}
                    placeholder={`Option ${i + 1}`}
                    onChange={(e) => setChoices(choices.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)))}
                  />
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      setChoices(choices.filter((x) => x.id !== c.id));
                      setCorrectIds(correctIds.filter((x) => x !== c.id));
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="row">
                <button
                  className="btn"
                  disabled={choices.length >= 26}
                  onClick={() => {
                    const id = [...LETTERS].find((l) => !choices.some((c) => c.id === l))!;
                    setChoices([...choices, { id, text: "" }]);
                  }}
                >
                  + Option
                </button>
                <label className="toggle">
                  <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
                  Allow several answers
                </label>
              </div>
            </fieldset>
          )}

          {q.type === "short" && (
            <>
              <label>
                Rubric: two to four key points, one per line (admin only)
                <textarea rows={4} value={rubric} onChange={(e) => setRubric(e.target.value)} />
              </label>
              <label>
                Model answer (admin only)
                <textarea rows={4} value={modelAnswer} onChange={(e) => setModelAnswer(e.target.value)} />
              </label>
              <p className="muted">Takers answer in at most 600 characters. The AI grades from 0 to {points} points.</p>
            </>
          )}

          {q.type === "bughunt" && (
            <>
              <label>
                Code snippet ({lineCount(code)} lines; aim for 10–25)
                <textarea className="mono" rows={12} value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} />
              </label>
              <p className="muted">Click the buggy line to set the key{correctLine ? ` (now line ${correctLine})` : ""}:</p>
              <CodeLines code={code} correct={correctLine} onSelect={setCorrectLine} label="Click the buggy line to set the key" />
            </>
          )}

          {q.type === "ctf" && (
            <>
              <label>
                Challenge folder URL
                <input value={repoUrl} placeholder="https://github.com/your-org/intern-ctf/tree/main/01-missing-paisa" onChange={(e) => setRepoUrl(e.target.value)} />
              </label>
              <label>
                {key?.flag_hash ? "Flag is set ✓. Paste a new one to replace it" : "Flag (from tools/make_flag.py)"}
                <input className="mono" value={flag} placeholder="FLAG{…}" autoComplete="off" onChange={(e) => setFlag(e.target.value)} />
              </label>
              <p className="muted">Only a salted hash of the flag is stored. The flag itself is never saved.</p>
            </>
          )}

          <fieldset>
            <legend>Hints (each costs points when revealed)</legend>
            {hints.map((h, i) =>
              h.deleted ? null : (
                <div className="row" key={h.id ?? `new-${i}`}>
                  <textarea
                    className="grow"
                    rows={2}
                    value={h.text}
                    placeholder="Hint text (markdown)"
                    onChange={(e) => setHints(hints.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                  />
                  <label className="narrow">
                    Cost
                    <input
                      type="number"
                      min={0}
                      value={h.cost_points}
                      onChange={(e) => setHints(hints.map((x, j) => (j === i ? { ...x, cost_points: Number(e.target.value) } : x)))}
                    />
                  </label>
                  <button className="btn btn-ghost" onClick={() => setHints(hints.map((x, j) => (j === i ? { ...x, deleted: true } : x)))}>
                    ✕
                  </button>
                </div>
              ),
            )}
            <button className="btn" onClick={() => setHints([...hints, { text: "", cost_points: Math.max(1, Math.round(points * 0.15)) }])}>
              + Hint
            </button>
          </fieldset>

          {warnings().length > 0 && (
            <ul className="warnings">
              {warnings().map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <ErrorBox error={error} />
          <div className="row">
            <button className="btn btn-primary" disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save question"}
            </button>
            {saved && <span className="good">Saved ✓</span>}
          </div>
        </div>
      )}
    </div>
  );
}
