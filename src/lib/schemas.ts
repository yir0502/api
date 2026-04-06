import { z } from 'zod';

export const MovimientoSchema = z.object({
  body: z.object({
    tipo: z.enum(['ingreso', 'egreso']),
    monto: z.number().positive(),
    sucursal_id: z.string().uuid().optional().nullable(),
    categoria_id: z.string().uuid().optional().nullable(),
    pedido_id: z.string().uuid().optional().nullable(),
    fecha: z.string().optional(),
    metodo_pago: z.string().optional().nullable(),
    nota: z.string().optional().nullable(),
  })
});

export const MovimientoUpdateSchema = z.object({
  body: MovimientoSchema.shape.body.partial()
});

export const PedidoSchema = z.object({
  body: z.object({
    cliente_id: z.string().uuid().optional().nullable(),
    sucursal_id: z.string().uuid().optional().nullable(),
    descripcion: z.string().optional().nullable(),
    fecha_entrega_estimada: z.string().optional().nullable(),
    monto_total: z.number().min(0),
    saldo_pendiente: z.number().min(0),
  })
});

export const PedidoUpdateSchema = z.object({
  body: z.object({
    estado: z.enum(['pendiente', 'recibido', 'lavando', 'secando', 'doblando', 'listo', 'entregado', 'cancelado', 'en_proceso']).optional(),
    descripcion: z.string().optional().nullable(),
    monto_total: z.number().min(0).optional(),
    saldo_pendiente: z.number().min(0).optional(),
    fecha_entrega_estimada: z.string().optional().nullable(),
    sucursal_id: z.string().uuid().optional().nullable(),
  })
});

export const ClienteSchema = z.object({
  body: z.object({
    nombre: z.string().min(2),
    telefono: z.string().min(10),
    email: z.string().email().optional().nullable().or(z.literal('')),
    direccion: z.string().optional().nullable(),
    permite_whatsapp: z.boolean().optional(),
    frecuencia_recordatorio: z.number().int().min(0).optional(),
    fecha_ultima_promo: z.string().optional().nullable(),
    invitaciones_enviadas: z.number().int().min(0).optional(),
  })
});

export const ClienteUpdateSchema = z.object({
  body: ClienteSchema.shape.body.partial()
});
