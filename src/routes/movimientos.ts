import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';

const r = Router();
r.use(requireAuth, requireMembership);

// GET /movimientos?org_id&desde&hasta&tipo&categoria_id
r.get('/', async (req: AuthedRequest, res) => {
  const org_id = (req as any).org_id as string;
  const { desde, hasta, tipo, categoria_id } = req.query as Record<string, string|undefined>;

  let q = supabaseAdmin.from('movimientos').select('*').eq('org_id', org_id);
  if (desde) q = q.gte('fecha', desde);
  if (hasta) q = q.lte('fecha', hasta);
  if (tipo) q = q.eq('tipo', tipo);
  if (categoria_id) q = q.eq('categoria_id', categoria_id);

  const { data, error } = await q.order('fecha', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /movimientos { tipo, monto, fecha?, categoria_id?, metodo_pago?, nota?, org_id? }
r.post('/', async (req: AuthedRequest, res) => {
  console.log('POST /movimientos', req.body);
  const org_id = (req.body.org_id as string) || (req as any).org_id;
  const usuario_id = req.user!.id;
  const { tipo, monto } = req.body || {};
  if (!tipo || typeof monto !== 'number') return res.status(400).json({ error: 'tipo y monto requeridos' });

  const { data, error } = await supabaseAdmin
    .from('movimientos')
    .insert([{ ...req.body, org_id, usuario_id }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /movimientos/:id
r.put('/:id', async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const { data, error } = await supabaseAdmin
    .from('movimientos')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /movimientos/:id
r.delete('/:id', async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const { error } = await supabaseAdmin.from('movimientos').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

export default r;