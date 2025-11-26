import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';

const r = Router();
r.use(requireAuth, requireMembership);

// GET /movimientos?org_id&desde&hasta&tipo&categoria_id
// routes/movimientos.ts (fragmento GET)
r.get('/', async (req: AuthedRequest, res) => {
  const org_id = (req as any).org_id as string;

  const { desde, hasta, tipo, categoria_id, metodo_pago, sucursal_id, q, limit, offset } = req.query;

  let qmov = supabaseAdmin
    .from('movimientos')
    .select('id, tipo, monto, fecha, metodo_pago, nota, categoria_id, sucursal_id, created_at, updated_at')
    .eq('org_id', org_id);

  if (desde)        qmov = qmov.gte('fecha', String(desde));
  if (hasta)        qmov = qmov.lte('fecha', String(hasta));
  if (tipo)         qmov = qmov.eq('tipo', String(tipo));
  if (categoria_id) qmov = qmov.eq('categoria_id', String(categoria_id));
  if (metodo_pago)  qmov = qmov.eq('metodo_pago', String(metodo_pago));
  if (sucursal_id)  qmov = qmov.eq('sucursal_id', String(sucursal_id));

  qmov = qmov.order('fecha', { ascending: false }).order('created_at', { ascending: false });

  const lim = limit ? Number(limit) : undefined;
  const off = offset ? Number(offset) : undefined;
  if (lim !== undefined && off !== undefined) qmov = qmov.range(off, off + lim - 1);

  const { data: movs, error } = await qmov;
  if (error) return res.status(400).json({ error: error.message });

  // Búsqueda por texto (nota, método, nombre de categoría/sucursal) — lado servidor
  let result = movs || [];
  if (q && String(q).trim()) {
    const needle = String(q).trim().toLowerCase();
    // Hidratar nombres primero (categoría/sucursal)
    const catIds = [...new Set(result.map(m => m.categoria_id).filter(Boolean))];
    const sucIds = [...new Set(result.map(m => m.sucursal_id).filter(Boolean))];

    const [{ data: cats }, { data: sucs }] = await Promise.all([
      supabaseAdmin.from('categorias').select('id, nombre').in('id', catIds).eq('org_id', org_id),
      supabaseAdmin.from('sucursales').select('id, nombre').in('id', sucIds).eq('org_id', org_id)
    ]);

    const catMap = new Map((cats||[]).map(c => [c.id, c.nombre]));
    const sucMap = new Map((sucs||[]).map(s => [s.id, s.nombre]));

    result = result
      .map(m => ({
        ...m,
        categoria_nombre: m.categoria_id ? (catMap.get(m.categoria_id) || 'Sin categoría') : 'Sin categoría',
        sucursal_nombre:  m.sucursal_id  ? (sucMap.get(m.sucursal_id)  || 'Sin sucursal')  : 'Sin sucursal'
      }))
      .filter(m => {
        const nota = (m.nota || '').toLowerCase();
        const metodo = (m.metodo_pago || '').toLowerCase();
        const cat = (m.categoria_nombre || '').toLowerCase();
        const suc = (m.sucursal_nombre || '').toLowerCase();
        return nota.includes(needle) || metodo.includes(needle) || cat.includes(needle) || suc.includes(needle);
      });

    return res.json(result);
  }

  // Si no hay q, igual hidratamos nombres (para UI más rica)
  const catIds = [...new Set(result.map(m => m.categoria_id).filter(Boolean))];
  const sucIds = [...new Set(result.map(m => m.sucursal_id).filter(Boolean))];
  const [{ data: cats }, { data: sucs }] = await Promise.all([
    supabaseAdmin.from('categorias').select('id, nombre').in('id', catIds).eq('org_id', org_id),
    supabaseAdmin.from('sucursales').select('id, nombre').in('id', sucIds).eq('org_id', org_id)
  ]);
  const catMap = new Map((cats||[]).map(c => [c.id, c.nombre]));
  const sucMap = new Map((sucs||[]).map(s => [s.id, s.nombre]));

  return res.json(result.map(m => ({
    ...m,
    categoria_nombre: m.categoria_id ? (catMap.get(m.categoria_id) || 'Sin categoría') : 'Sin categoría',
    sucursal_nombre:  m.sucursal_id  ? (sucMap.get(m.sucursal_id)  || 'Sin sucursal')  : 'Sin sucursal'
  })));
});


// POST /movimientos
r.post('/', async (req: AuthedRequest, res) => {
  const org_id = (req.body.org_id as string) || (req as any).org_id;
  const usuario_id = req.user!.id;
  const { tipo, monto } = req.body || {};

  if (!org_id) return res.status(401).json({ error: 'No org' });
  if (!tipo || typeof monto !== 'number') return res.status(400).json({ error: 'tipo y monto requeridos' });

  const payload = req.body || {};
  payload.org_id = org_id;
  payload.usuario_id = usuario_id;

  // valida sucursal_id si viene
  if (payload.sucursal_id) {
    const { data: s } = await supabaseAdmin.from('sucursales').select('id').eq('id', payload.sucursal_id).eq('org_id', org_id).maybeSingle();
    if (!s) return res.status(400).json({ error: 'sucursal_id inválido' });
  }

  const { data, error } = await supabaseAdmin.from('movimientos').insert({ ...payload, org_id }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// r.post('/', async (req: AuthedRequest, res) => {
//   console.log('POST /movimientos', req.body);
//   const org_id = (req.body.org_id as string) || (req as any).org_id;
//   const usuario_id = req.user!.id;
//   const { tipo, monto } = req.body || {};
//   if (!tipo || typeof monto !== 'number') return res.status(400).json({ error: 'tipo y monto requeridos' });

//   const { data, error } = await supabaseAdmin
//     .from('movimientos')
//     .insert([{ ...req.body, org_id, usuario_id }])
//     .select()
//     .single();

//   if (error) return res.status(400).json({ error: error.message });
//   res.json(data);
// });

// PUT /movimientos/:id
r.put('/:id', async (req: AuthedRequest, res) => {
  const org_id = (req as any).org_id as string;

  const { id } = req.params;
  if (!org_id) return res.status(401).json({ error: 'No org' });

  const patch = req.body || {};
  if ('sucursal_id' in patch && patch.sucursal_id) {
    const { data: s } = await supabaseAdmin.from('sucursales').select('id').eq('id', patch.sucursal_id).eq('org_id', org_id).maybeSingle();
    if (!s) return res.status(400).json({ error: 'sucursal_id inválido' });
  }

  const { data, error } = await supabaseAdmin
    .from('movimientos')
    .update(patch)
    .eq('id', id).eq('org_id', org_id)
    .select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /movimientos/:id
r.delete('/:id', async (req: AuthedRequest, res) => {
  const org_id = (req as any).org_id as string;

  const { id } = req.params;
  const { error } = await supabaseAdmin.from('movimientos').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

export default r;