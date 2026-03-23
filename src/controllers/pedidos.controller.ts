import { Response } from 'express';
import { AuthedRequest } from '../lib/auth';
import { PedidosService } from '../services/pedidos.service';

export class PedidosController {
  
  static async listar(req: AuthedRequest, res: Response) {
    const org_id = (req as any).org_id;
    const { activo, q, limit, offset } = req.query;
    
    const result = await PedidosService.listarPedidos(
      org_id, 
      activo as string, 
      q as string, 
      limit ? Number(limit) : undefined, 
      offset ? Number(offset) : undefined
    );
    res.json(result);
  }

  static async crear(req: AuthedRequest, res: Response) {
    const org_id = (req as any).org_id;
    const { cliente_id, descripcion, fecha_entrega_estimada, saldo_pendiente, monto_total, sucursal_id } = req.body;
    
    const data = await PedidosService.crearPedido(org_id, {
      cliente_id, descripcion, fecha_entrega_estimada, saldo_pendiente, monto_total, sucursal_id
    });
    res.status(201).json(data);
  }

  static async actualizar(req: AuthedRequest, res: Response) {
    const { id } = req.params;
    const { estado, descripcion, monto_total, saldo_pendiente, fecha_entrega_estimada, sucursal_id } = req.body;

    const data = await PedidosService.actualizarPedido(id, {
      estado, descripcion, monto_total, saldo_pendiente, fecha_entrega_estimada, sucursal_id
    });
    res.json(data);
  }

  static async subirEvidencia(req: any, res: Response) {
    const { id } = req.params; 
    const file = req.file;
    const { tipo, nota } = req.body; 

    if (!file) return res.status(400).json({ error: 'No se subió ningún archivo' });

    const dbData = await PedidosService.subirEvidencia(id, file.buffer, tipo, nota);
    res.status(201).json(dbData);
  }

  static async listarEvidencias(req: AuthedRequest, res: Response) {
    const { id } = req.params;
    const data = await PedidosService.obtenerEvidencias(id);
    res.json(data);
  }

  static async eliminar(req: AuthedRequest, res: Response) {
    const { id } = req.params;
    await PedidosService.eliminarPedido(id);
    res.json({ ok: true });
  }

  static async eliminarEvidencia(req: AuthedRequest, res: Response) {
    const { id, evidenciaId } = req.params;
    await PedidosService.eliminarEvidencia(id, evidenciaId);
    res.json({ ok: true });
  }
}
