import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { configOk, supabase } from './lib/supabase.ts';
import Login from './pages/Login.tsx';
import Upload from './pages/Upload.tsx';
import Review from './pages/Review.tsx';

type Tab = 'upload' | 'review';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('upload');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!configOk) {
    return <div className="center-msg">חסרים VITE_SUPABASE_URL ו-VITE_SUPABASE_ANON_KEY בקובץ ‎.env</div>;
  }
  if (!ready) return null;
  if (!session) return <Login />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-in">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6" /><path d="M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" /><path d="M7.5 15h9" /></svg>
            </div>
            <div className="brand-text">
              <strong>חילוץ התחייבויות</strong>
              <span>המעבדה המרכזית לנגיפים</span>
            </div>
          </div>
          <nav className="tabs" aria-label="ניווט ראשי">
            <button type="button" className={tab === 'upload' ? 'tab active' : 'tab'} onClick={() => setTab('upload')}>העלאה</button>
            <button type="button" className={tab === 'review' ? 'tab active' : 'tab'} onClick={() => setTab('review')}>בדיקה ואישור</button>
          </nav>
          <button type="button" className="btn ghost" onClick={() => supabase.auth.signOut()}>יציאה</button>
        </div>
      </header>
      {/* Upload stays mounted so a running batch keeps its progress while reviewing */}
      <div hidden={tab !== 'upload'}><Upload onGoReview={() => setTab('review')} /></div>
      {tab === 'review' && <Review />}
    </div>
  );
}
