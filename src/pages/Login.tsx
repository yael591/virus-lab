import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase.ts';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError('הכניסה נכשלה. בדקי את הפרטים.');
    setBusy(false);
  }

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>חילוץ התחייבויות</h1>
        <p className="muted">כניסה לצוות המעבדה</p>
        <label htmlFor="email">אימייל</label>
        <input id="email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="pw">סיסמה</label>
        <input id="pw" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div className="error">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'נכנסת…' : 'כניסה'}</button>
      </form>
    </main>
  );
}
