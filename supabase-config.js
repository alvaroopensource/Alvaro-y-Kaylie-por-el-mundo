import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://xlzcgqtszfanwswlwdgv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhsemNncXRzemZhbndzd2x3ZGd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyODEwNDQsImV4cCI6MjA4ODg1NzA0NH0.tIEcvyjw1N21uSPGHhmBP4P_aXrJKTMcGzyrcRr-0Xc';

const isSupabaseEnabled =
    Boolean(SUPABASE_URL) &&
    Boolean(SUPABASE_ANON_KEY) &&
    !SUPABASE_URL.includes('TU-PROYECTO') &&
    !SUPABASE_ANON_KEY.includes('TU_SUPABASE_ANON_KEY');

const supabase = isSupabaseEnabled
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        }
    })
    : null;

if (!isSupabaseEnabled) {
    console.warn('[Supabase] Configuracion pendiente: actualiza SUPABASE_URL y SUPABASE_ANON_KEY en supabase-config.js');
}

export { supabase, isSupabaseEnabled };
