import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../lib/auth';
import { requireMembership } from '../lib/guard';
import { validateRequest } from '../lib/validate';
import { PedidoSchema, PedidoUpdateSchema } from '../lib/schemas';
import { asyncHandler } from '../lib/error';
import { PedidosController } from '../controllers/pedidos.controller';

const r = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

r.use(requireAuth);

r.get('/integraciones/estado', requireMembership, asyncHandler(PedidosController.estadoIntegraciones));

r.get('/', requireMembership, asyncHandler(PedidosController.listar));

r.get('/:id', requireMembership, asyncHandler(PedidosController.obtener));

r.post('/', requireMembership, validateRequest(PedidoSchema), asyncHandler(PedidosController.crear));

r.put('/:id', requireMembership, validateRequest(PedidoUpdateSchema), asyncHandler(PedidosController.actualizar));

r.post('/:id/notificar', requireMembership, asyncHandler(PedidosController.notificar));

r.post('/:id/evidencia', requireMembership, upload.single('foto'), asyncHandler(PedidosController.subirEvidencia));

r.get('/:id/evidencia', requireMembership, asyncHandler(PedidosController.listarEvidencias));

r.delete('/:id', requireMembership, asyncHandler(PedidosController.eliminar));

r.delete('/:id/evidencia/:evidenciaId', requireMembership, asyncHandler(PedidosController.eliminarEvidencia));

export default r;
