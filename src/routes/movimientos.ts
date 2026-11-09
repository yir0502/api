import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';
import { validateRequest } from '../lib/validate';
import { MovimientoSchema, MovimientoUpdateSchema } from '../lib/schemas';
import { asyncHandler } from '../lib/error';
import { MovimientosService } from '../services/movimientos.service';

const r = Router();
r.use(requireAuth, requireMembership);

// GET /movimientos
r.get('/', asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = req.org_id!;
  const result = await MovimientosService.listarMovimientos(org_id, req.query);
  return res.json(result);
}));

// GET /movimientos/:id
r.get('/:id', asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = req.org_id!;
  const { id } = req.params;
  const result = await MovimientosService.obtenerMovimiento(id, org_id);
  return res.json(result);
}));

// POST /movimientos
r.post('/', validateRequest(MovimientoSchema), asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = req.org_id!;
  const usuario_id = req.user!.id;
  const { tipo, monto } = req.body || {};

  if (!org_id) return res.status(401).json({ error: 'No org' });
  if (!tipo || typeof monto !== 'number') return res.status(400).json({ error: 'tipo y monto requeridos' });

  const data = await MovimientosService.crearMovimiento(org_id, usuario_id, req.body);
  res.json(data);
}));

// PUT /movimientos/:id
r.put('/:id', validateRequest(MovimientoUpdateSchema), asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = req.org_id!;
  const { id } = req.params;
  if (!org_id) return res.status(401).json({ error: 'No org' });

  const data = await MovimientosService.actualizarMovimiento(id, org_id, req.body || {});
  res.json(data);
}));

// DELETE /movimientos/:id
r.delete('/:id', asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = req.org_id!;
  const { id } = req.params;

  await MovimientosService.eliminarMovimiento(id, org_id);
  res.json({ ok: true });
}));

export default r;
