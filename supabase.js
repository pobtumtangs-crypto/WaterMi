import { createClient } from '@supabase/supabase-js';

export function createSupabaseFactory(url, key, fetch = globalThis.fetch) {
  if (!url || !key) return null;

  return ({ token, storage } = {}) => createClient(url, key, {
    global: { fetch, ...(token && { headers: { Authorization: `Bearer ${token}` } }) },
    auth: {
      autoRefreshToken: false,
      persistSession: Boolean(storage),
      detectSessionInUrl: false,
      ...(storage && { flowType: 'pkce', storage }),
    },
  });
}
