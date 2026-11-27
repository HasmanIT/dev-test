import { useCallback, useEffect, useState, type FormEvent } from "react";
import { supabase } from "../../lib/supabase";
import { callFn, errorMessage, must } from "../../lib/api";
import { fmtDateTime } from "../../lib/format";
import type { Profile } from "../../lib/types";
import { ErrorBox, Spinner } from "../../components/Layout";

function randomPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function Users() {
  const [people, setPeople] = useState<Profile[] | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState(randomPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setPeople(must(await supabase.from("profiles").select("*").order("created_at", { ascending: false })) as Profile[]);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      await callFn("invite_user", { email: email.trim(), password, display_name: name.trim() });
      setCreated({ email: email.trim(), password });
      setEmail("");
      setName("");
      setPassword(randomPassword());
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>People</h1>
      <div className="card">
        <h2>Invite a taker</h2>
        <p className="muted">
          Creates a login straight away. No email is sent, so give the intern their email and password yourself. Interns can also sign up on their own.
        </p>
        <form className="row wrap" onSubmit={invite}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          </label>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Starting password
            <input className="mono" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </label>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Creating…" : "Create login"}
          </button>
        </form>
        <ErrorBox error={error} />
        {created && (
          <div className="alert alert-info">
            Created. Send these to the intern privately: <span className="mono">{created.email}</span> /{" "}
            <span className="mono">{created.password}</span>
          </div>
        )}
      </div>

      {!people ? (
        <Spinner />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <td>{p.display_name}</td>
                <td>{p.email}</td>
                <td>
                  <span className={`pill ${p.role === "admin" ? "pill-admin" : ""}`}>{p.role}</span>
                </td>
                <td>{fmtDateTime(p.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
