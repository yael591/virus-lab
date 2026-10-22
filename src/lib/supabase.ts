import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !key) {
  // Surfaced on screen by App when missing
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env');
}

export const supabase = createClient(url ?? 'http://localhost', key ?? 'missing');
export const configOk = Boolean(url && key);
