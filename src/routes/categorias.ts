import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';

const r = Router();
r.use(requireAuth, requireMembership);

// GET /categorias?org_id&tipo
r.get('/', async (req: AuthedRequest, res) => {
  const org_id = (req as any).org_id as string;
  const tipo = (req.query.tipo as string | undefined) || undefined;
  let q = supabaseAdmin.from('categorias').select('*').eq('org_id', org_id);
  if (tipo) q = q.eq('tipo', tipo);
  const { data, error } = await q.order('nombre', { ascending: true });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /categorias { nombre, tipo, org_id? }
r.post('/', async (req: AuthedRequest, res) => {
  const org_id = (req.body.org_id as string) || (req as any).org_id;
  const { nombre, tipo } = req.body || {};
  if (!nombre || !tipo) return res.status(400).json({ error: 'nombre y tipo requeridos' });

  const { data, error } = await supabaseAdmin
    .from('categorias')
    .insert([{ ...req.body, org_id }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /categorias/:id
r.put('/:id', async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const { data, error } = await supabaseAdmin
    .from('categorias')
    .update(req.body)
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /categorias/:id
r.delete('/:id', async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from('categorias')
    .delete()
    .eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

export default r;