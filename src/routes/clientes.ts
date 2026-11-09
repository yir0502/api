import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';
import { validateRequest } from '../lib/validate';
import { ClienteSchema, ClienteUpdateSchema } from '../lib/schemas';
import { asyncHandler } from '../lib/error';
import { ClientesService } from '../services/clientes.service';

const r = Router();

r.use(requireAuth, requireMembership);

// --- 1. LISTAR CLIENTES (Con Filtros y Paginación) ---
r.get('/', asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = req.org_id!;
  const result = await ClientesService.listarClientes(org_id, req.query);
  res.json(result);
}));

// --- 2. ESTADÍSTICAS GLOBALES ---
r.get('/stats', asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = req.org_id!;
  const stats = await ClientesService.obtenerEstadisticas(org_id);
  res.json(stats);
}));

// --- 2.5. OBTENER CLIENTE POR ID ---
r.get('/:id', asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = req.org_id!;
  const { id } = req.params;
  const data = await ClientesService.obtenerCliente(id, org_id);
  res.json(data);
}));

// --- 3. CREAR CLIENTE ---
r.post('/', validateRequest(ClienteSchema), asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = req.org_id!;
  if (!org_id) return res.status(401).json({ error: 'La organización es obligatoria' });
  if (!req.body?.nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });

  const data = await ClientesService.crearCliente(org_id, req.body);
  res.status(201).json(data);
}));

// --- 4. ACTUALIZAR CLIENTE ---
r.put('/:id', validateRequest(ClienteUpdateSchema), asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = req.org_id!;
  const { id } = req.params;
  const data = await ClientesService.actualizarCliente(id, org_id, req.body);
  res.json(data);
}));

// --- 5. ELIMINAR CLIENTE ---
r.delete('/:id', asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = req.org_id!;
  const { id } = req.params;
  await ClientesService.eliminarCliente(id, org_id);
  res.json({ ok: true });
}));

export default r;
