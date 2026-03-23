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
  limits: { fileSize: 20 * 1024 * 1024 } 
});

r.use(requireAuth);

// 1. LISTAR PEDIDOS
r.get('/', requireMembership, asyncHandler(PedidosController.listar));

// 2. CREAR PEDIDO
r.post('/', requireMembership, validateRequest(PedidoSchema), asyncHandler(PedidosController.crear));

// 3. ACTUALIZAR ESTADO O INFORMACIÓN
r.put('/:id', requireMembership, validateRequest(PedidoUpdateSchema), asyncHandler(PedidosController.actualizar));

// 4. SUBIR EVIDENCIA (FOTO)
r.post('/:id/evidencia', requireMembership, upload.single('foto'), asyncHandler(PedidosController.subirEvidencia));

// 5. OBTENER EVIDENCIAS DE UN PEDIDO
r.get('/:id/evidencia', requireMembership, asyncHandler(PedidosController.listarEvidencias));

// 6. ELIMINAR PEDIDO
r.delete('/:id', requireMembership, asyncHandler(PedidosController.eliminar));

// 7. ELIMINAR EVIDENCIA
r.delete('/:id/evidencia/:evidenciaId', requireMembership, asyncHandler(PedidosController.eliminarEvidencia));

export default r;