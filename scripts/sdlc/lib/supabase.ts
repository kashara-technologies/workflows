// Supabase client.
// Service role; bypasses RLS but our RLS denies updates/deletes anyway.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from './env.js';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const env = getEnv();
  _client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
}
