import { Router } from 'express';
import { supabaseAnon } from '../lib/supabase';

const r = Router();

// POST /auth/login { email, password }
r.post('/login', async (req, res) => {
    console.log('nuevo inicio de sesiion:', req.body);
    
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email y password requeridos' });

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  // Devuelve access_token para usarlo en Authorization: Bearer ...
  return res.json({
    access_token: data.session?.access_token,
    user: data.user
  });
});

export default r;