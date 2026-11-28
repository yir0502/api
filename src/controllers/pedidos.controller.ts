import { Response } from 'express';
import { AuthedRequest } from '../lib/auth';
import { PedidosService, PedidosValidationError } from '../services/pedidos.service';
import { WhatsappService } from '../services/whatsapp.service';

function esListadoPaginado(valor: unknown): boolean {
  const candidato = Array.isArray(valor) ? valor[0] : valor;
  if (typeof candidato !== 'string') return false;
  const normalizado = candidato.trim().toLowerCase();
  return normalizado === '1' || normalizado === 'true';
}

export class PedidosController {
  static async estadoIntegraciones(_req: AuthedRequest, res: Response) {
    res.json({
      whatsapp_automatico: WhatsappService.isConfigured(),
    });
  }

  static async listar(req: AuthedRequest, res: Response) {
    const org_id = req.org_id!;
    const {
      paginated,
      activo,
      q,
      limit,
      offset,
      deuda,
      sucursal_id,
      estado,
      solo_por_cobrar,
      desde,
      hasta,
    } = req.query;

    if (esListadoPaginado(paginated)) {
      try {
        const result = await PedidosService.listarPedidosPaginados(org_id, {
          activo,
          q,
          sucursal_id,
          estado,
          solo_por_cobrar,
          desde,
          hasta,
          limit,
          offset,
        });
        res.json(result);
        return;
      } catch (err: unknown) {
        if (err instanceof PedidosValidationError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    }

    const result = await PedidosService.listarPedidos(
      org_id,
      activo as string,
      q as string,
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
      deuda as string
    );
    res.json(result);
  }

  static async obtener(req: AuthedRequest, res: Response) {
    const org_id = req.org_id!;
    const { id } = req.params;
    const data = await PedidosService.obtenerPedido(id, org_id);
    res.json(data);
  }

  static async crear(req: AuthedRequest, res: Response) {
    const org_id = req.org_id!;
    const usuario_id = req.user?.id;
    const {
      cliente_id,
      descripcion,
      fecha_entrega_estimada,
      saldo_pendiente,
      monto_total,
      sucursal_id,
      descuento_aplicado,
      registrar_pago,
      metodo_pago,
      categoria_ingreso_id,
      omitir_whatsapp,
    } = req.body;

    const data = await PedidosService.crearPedido(
      org_id,
      {
        cliente_id,
        descripcion,
        fecha_entrega_estimada,
        saldo_pendiente,
        monto_total,
        sucursal_id,
        descuento_aplicado,
        registrar_pago,
        metodo_pago,
        categoria_ingreso_id,
        omitir_whatsapp,
      },
      usuario_id
    );
    res.status(201).json(data);
  }

  static async actualizar(req: AuthedRequest, res: Response) {
    const org_id = req.org_id!;
    const usuario_id = req.user?.id;
    const { id } = req.params;
    const {
      estado,
      descripcion,
      monto_total,
      saldo_pendiente,
      fecha_entrega_estimada,
      sucursal_id,
      descuento_aplicado,
      monto_cobrado,
      metodo_pago,
      categoria_ingreso_id,
      omitir_whatsapp,
    } = req.body;

    const data = await PedidosService.actualizarPedido(
      id,
      org_id,
      {
        estado,
        descripcion,
        monto_total,
        saldo_pendiente,
        fecha_entrega_estimada,
        sucursal_id,
        descuento_aplicado,
        monto_cobrado,
        metodo_pago,
        categoria_ingreso_id,
        omitir_whatsapp,
      },
      usuario_id
    );
    res.json(data);
  }

  static async notificar(req: AuthedRequest, res: Response) {
    const org_id = req.org_id!;
    const { id } = req.params;
    const result = await PedidosService.enviarNotificacionManual(id, org_id);
    res.json(result);
  }

  static async subirEvidencia(req: AuthedRequest & { file?: Express.Multer.File }, res: Response) {
    const org_id = req.org_id!;
    const { id } = req.params;
    const file = req.file;
    const { tipo, nota } = req.body;

    if (!file) return res.status(400).json({ error: 'No se subió ningún archivo' });

    const dbData = await PedidosService.subirEvidencia(id, org_id, file.buffer, tipo, nota);
    res.status(201).json(dbData);
  }

  static async listarEvidencias(req: AuthedRequest, res: Response) {
    const org_id = req.org_id!;
    const { id } = req.params;
    const data = await PedidosService.obtenerEvidencias(id, org_id);
    res.json(data);
  }

  static async eliminar(req: AuthedRequest, res: Response) {
    const org_id = req.org_id!;
    const { id } = req.params;
    await PedidosService.eliminarPedido(id, org_id);
    res.json({ ok: true });
  }

  static async eliminarEvidencia(req: AuthedRequest, res: Response) {
    const org_id = req.org_id!;
    const { id, evidenciaId } = req.params;
    await PedidosService.eliminarEvidencia(id, org_id, evidenciaId);
    res.json({ ok: true });
  }
}
