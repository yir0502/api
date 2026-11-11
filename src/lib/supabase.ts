import { createClient } from '@supabase/supabase-js';

// Extraemos y validamos las variables de entorno una sola vez para mejorar el tipado y la robustez.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Al realizar esta validación, TypeScript infiere automáticamente que las variables son de tipo 'string'
// y no 'string | undefined' en el resto del archivo, eliminando la necesidad de aserciones '!'.
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('Faltan variables de entorno esenciales para la configuración de Supabase.');
}

const validatedSupabaseUrl: string = SUPABASE_URL;
const validatedAnonKey: string = SUPABASE_ANON_KEY;

export const supabaseAdmin = createClient(
  validatedSupabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export const supabaseAnon = createClient(
  validatedSupabaseUrl,
  validatedAnonKey,
  { auth: { persistSession: false } }
);

export function createEphemeralAnonClient() {
  return createClient(validatedSupabaseUrl, validatedAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}