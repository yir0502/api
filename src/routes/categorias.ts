import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';

const r = Router();
r.use(requireAuth, requireMembership);

// GET /categorias?org_id&tipo
r.get('/', async (req: AuthedRequest, res) => {
  const org_id = req.org_id!;

  const tipo = (req.query.tipo as string | undefined) || undefined;
  let q = supabaseAdmin.from('categorias').select('*').eq('org_id', org_id);
  if (tipo) q = q.eq('tipo', tipo);
  const { data, error } = await q.order('nombre', { ascending: true });
  if (error) return res.status(400).json({ error: 'No se pudo completar la operación' });
  res.json(data);
});

// POST /categorias { nombre, tipo, activo, org_id? }
r.post('/', async (req: AuthedRequest, res) => {
  const org_id = req.org_id!;
  const { nombre, tipo, activo } = req.body || {};
  if (!nombre || !tipo) return res.status(400).json({ error: 'nombre y tipo requeridos' });

  const activoValue = typeof activo === 'boolean' ? activo : true;

  const { data, error } = await supabaseAdmin
    .from('categorias')
    .insert([{ nombre, tipo, activo: activoValue, org_id }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: 'No se pudo completar la operación' });
  res.json(data);
});

// PUT /categorias/:id
r.put('/:id', async (req: AuthedRequest, res) => {
  const org_id = req.org_id!;
  const { id } = req.params;
  const patch: { nombre?: string; tipo?: string; activo?: boolean } = {};
  if ('nombre' in req.body) patch.nombre = req.body.nombre;
  if ('tipo' in req.body) patch.tipo = req.body.tipo;
  if ('activo' in req.body) patch.activo = req.body.activo;
  const { data, error } = await supabaseAdmin
    .from('categorias')
    .update(patch)
    .eq('id', id)
    .eq('org_id', org_id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: 'No se pudo completar la operación' });
  res.json(data);
});

// DELETE /categorias/:id
r.delete('/:id', async (req: AuthedRequest, res) => {
  const org_id = req.org_id!;
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from('categorias')
    .delete()
    .eq('id', id)
    .eq('org_id', org_id);
  if (error) return res.status(400).json({ error: 'No se pudo completar la operación' });
  res.json({ ok: true });
});

export default r;