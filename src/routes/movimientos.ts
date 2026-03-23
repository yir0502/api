import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';
import { validateRequest } from '../lib/validate';
import { MovimientoSchema, MovimientoUpdateSchema } from '../lib/schemas';
import { asyncHandler } from '../lib/error';

const r = Router();
r.use(requireAuth, requireMembership);

// Helper para calcular saldo exacto de un pedido en base a todos sus movimientos
async function reconciliarPedido(pedido_id: string, org_id: string) {
  if (!pedido_id) return;

  const { data: movs } = await supabaseAdmin
    .from('movimientos')
    .select('monto, tipo')
    .eq('pedido_id', pedido_id)
    .eq('org_id', org_id);

  if (!movs) return;

  const totalPagado = movs.filter(m => m.tipo === 'ingreso').reduce((sum, m) => sum + Number(m.monto), 0);
  const totalDevuelto = movs.filter(m => m.tipo === 'egreso').reduce((sum, m) => sum + Number(m.monto), 0);
  const abonoNeto = totalPagado - totalDevuelto;

  const { data: ped } = await supabaseAdmin
    .from('pedidos')
    .select('monto_total')
    .eq('id', pedido_id)
    .eq('org_id', org_id)
    .maybeSingle();

  if (!ped) return;

  const nuevoSaldo = Math.max(0, Number(ped.monto_total) - abonoNeto);

  await supabaseAdmin
    .from('pedidos')
    .update({ saldo_pendiente: nuevoSaldo })
    .eq('id', pedido_id)
    .eq('org_id', org_id);
}

// GET /movimientos
r.get('/', asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = (req as any).org_id as string;
  const { desde, hasta, tipo, categoria_id, metodo_pago, sucursal_id, q, limit, offset, pedido_id } = req.query;

  let qmov = supabaseAdmin
    .from('movimientos')
    .select('*, categorias ( id, nombre ), sucursales ( id, nombre )')
    .eq('org_id', org_id);

  if (desde)        qmov = qmov.gte('fecha', String(desde));
  if (hasta)        qmov = qmov.lte('fecha', String(hasta));
  if (tipo)         qmov = qmov.eq('tipo', String(tipo));
  if (categoria_id) qmov = qmov.eq('categoria_id', String(categoria_id));
  if (metodo_pago)  qmov = qmov.eq('metodo_pago', String(metodo_pago));
  if (sucursal_id)  qmov = qmov.eq('sucursal_id', String(sucursal_id));
  if (pedido_id)    qmov = qmov.eq('pedido_id', String(pedido_id));

  qmov = qmov.order('fecha', { ascending: false }).order('created_at', { ascending: false });

  const lim = limit ? Number(limit) : undefined;
  const off = offset ? Number(offset) : undefined;
  if (lim !== undefined && off !== undefined) qmov = qmov.range(off, off + lim - 1);

  const { data: movs, error } = await qmov;
  if (error) throw error;

  let result = (movs || []).map((m: any) => ({
    ...m,
    categoria_nombre: m.categorias?.nombre || 'Sin categoría',
    sucursal_nombre:  m.sucursales?.nombre || 'Sin sucursal',
    categorias: undefined,
    sucursales: undefined
  }));

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
}));

// POST /movimientos
r.post('/', validateRequest(MovimientoSchema), asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = (req.body.org_id as string) || (req as any).org_id;
  const usuario_id = req.user!.id;
  const { tipo, monto } = req.body || {};

  if (!org_id) return res.status(401).json({ error: 'No org' });
  if (!tipo || typeof monto !== 'number') return res.status(400).json({ error: 'tipo y monto requeridos' });

  const payload = req.body || {};
  payload.org_id = org_id;
  payload.usuario_id = usuario_id;

  if (payload.sucursal_id) {
    const { data: s } = await supabaseAdmin.from('sucursales').select('id').eq('id', payload.sucursal_id).eq('org_id', org_id).maybeSingle();
    if (!s) return res.status(400).json({ error: 'sucursal_id inválido' });
  }

  const { data, error } = await supabaseAdmin.from('movimientos').insert({ ...payload, org_id }).select().single();
  if (error) throw error;

  if (payload.pedido_id) {
    await reconciliarPedido(payload.pedido_id, org_id);
  }

  res.json(data);
}));

// PUT /movimientos/:id
r.put('/:id', validateRequest(MovimientoUpdateSchema), asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = (req as any).org_id as string;
  const { id } = req.params;
  if (!org_id) return res.status(401).json({ error: 'No org' });

  const patch = req.body || {};
  if ('sucursal_id' in patch && patch.sucursal_id) {
    const { data: s } = await supabaseAdmin.from('sucursales').select('id').eq('id', patch.sucursal_id).eq('org_id', org_id).maybeSingle();
    if (!s) return res.status(400).json({ error: 'sucursal_id inválido' });
  }

  // Prevenimos pérdida de datos en el balance: verificamos a qué pedido pertenecía antes de actualizar
  const { data: oldMov } = await supabaseAdmin.from('movimientos').select('pedido_id').eq('id', id).eq('org_id', org_id).maybeSingle();

  const { data, error } = await supabaseAdmin.from('movimientos').update(patch).eq('id', id).eq('org_id', org_id).select().single();
  if (error) throw error;

  // Si se cambió físicamente de pedido (poco probable en UI, pero por seguridad)
  if (oldMov?.pedido_id && patch.pedido_id !== undefined && oldMov.pedido_id !== patch.pedido_id) {
    await reconciliarPedido(oldMov.pedido_id, org_id);
  }
  
  // Reconciliamos el pedido al que pertenece ahora
  const finalPedidoId = patch.pedido_id !== undefined ? patch.pedido_id : oldMov?.pedido_id;
  if (finalPedidoId) {
    await reconciliarPedido(finalPedidoId, org_id);
  }

  res.json(data);
}));

// DELETE /movimientos/:id
r.delete('/:id', asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = (req as any).org_id as string;
  const { id } = req.params;

  const { data: oldMov } = await supabaseAdmin.from('movimientos').select('pedido_id').eq('id', id).eq('org_id', org_id).maybeSingle();

  const { error } = await supabaseAdmin.from('movimientos').delete().eq('id', id);
  if (error) throw error;

  if (oldMov?.pedido_id) {
    await reconciliarPedido(oldMov.pedido_id, org_id);
  }

  res.json({ ok: true });
}));

export default r;