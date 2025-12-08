// src/routes/movimientos.ts
import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';

const r = Router();
r.use(requireAuth, requireMembership);

// GET /movimientos
r.get('/', async (req: AuthedRequest, res) => {
  const org_id = (req as any).org_id as string;
  const { desde, hasta, tipo, categoria_id, metodo_pago, sucursal_id, q, limit, offset } = req.query;

  // 1. OPTIMIZACIÓN: Solicitamos los datos relacionales (categorias, sucursales) directamente en el select.
  // Asumimos que en tu BD las FK se llaman 'categoria_id' y 'sucursal_id' apuntando a sus tablas.
  let qmov = supabaseAdmin
    .from('movimientos')
    .select(`
      *,
      categorias ( id, nombre ),
      sucursales ( id, nombre )
    `)
    .eq('org_id', org_id);

  // Filtros directos a la base de datos (SQL es muy rápido filtrando esto)
  if (desde)        qmov = qmov.gte('fecha', String(desde));
  if (hasta)        qmov = qmov.lte('fecha', String(hasta));
  if (tipo)         qmov = qmov.eq('tipo', String(tipo));
  if (categoria_id) qmov = qmov.eq('categoria_id', String(categoria_id));
  if (metodo_pago)  qmov = qmov.eq('metodo_pago', String(metodo_pago));
  if (sucursal_id)  qmov = qmov.eq('sucursal_id', String(sucursal_id));

  // Ordenamiento
  qmov = qmov.order('fecha', { ascending: false }).order('created_at', { ascending: false });

  // Paginación
  const lim = limit ? Number(limit) : undefined;
  const off = offset ? Number(offset) : undefined;
  if (lim !== undefined && off !== undefined) qmov = qmov.range(off, off + lim - 1);

  // Ejecutamos la consulta ÚNICA
  const { data: movs, error } = await qmov;
  if (error) return res.status(400).json({ error: error.message });

  // 2. Transformación ligera (Flattening)
  // Supabase devuelve objetos anidados: { categorias: { nombre: 'X' } }
  // Tu frontend espera: { categoria_nombre: 'X' }
  // Convertimos el formato para no romper el frontend.
  let result = (movs || []).map((m: any) => ({
    ...m,
    categoria_nombre: m.categorias?.nombre || 'Sin categoría',
    sucursal_nombre:  m.sucursales?.nombre || 'Sin sucursal',
    // Limpiamos los objetos anidados si no los necesitas en el front
    categorias: undefined,
    sucursales: undefined
  }));

  // 3. Búsqueda por texto (Lógica en memoria)
  // Mantenemos tu lógica de búsqueda en memoria por ahora.
  // (Pasar esto a SQL full-text search es el siguiente nivel, pero requiere índices en BD).
  if (q && String(q).trim()) {
    const needle = String(q).trim().toLowerCase();
    result = result.filter((m: any) => {
      const nota = (m.nota || '').toLowerCase();
      const metodo = (m.metodo_pago || '').toLowerCase();
      const cat = (m.categoria_nombre || '').toLowerCase();
      const suc = (m.sucursal_nombre || '').toLowerCase();
      return nota.includes(needle) || metodo.includes(needle) || cat.includes(needle) || suc.includes(needle);
    });
  }

  return res.json(result);
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