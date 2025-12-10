import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';

const r = Router();

// GET /rastreo/:folio
// Esta ruta es PÚBLICA. No usa requireAuth.
r.get('/:folio', async (req, res) => {
  try {
    const { folio } = req.params;

    // 1. Buscar el pedido por Folio (case insensitive)
    const { data: pedido, error } = await supabaseAdmin
      .from('pedidos')
      .select('id, folio, estado, descripcion, monto_total, saldo_pendiente, fecha_entrega_estimada, clientes(nombre)')
      .ilike('folio', folio)
      .maybeSingle();

    let nombreCliente = 'Cliente';
    
    const c = (pedido as any).clientes; // Acceso crudo
    
    if (c) {
      if (Array.isArray(c) && c.length > 0) {
        // Caso: Es un Arreglo (Array)
        nombreCliente = c[0].nombre || 'Cliente';
      } else if (typeof c === 'object' && !Array.isArray(c)) {
        // Caso: Es un Objeto (Object) - TU CASO ACTUAL
        nombreCliente = c.nombre || 'Cliente';
      }
    }

    if (error) throw error;
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    // 2. Buscar las evidencias (fotos) de este pedido
    const { data: evidencias } = await supabaseAdmin
      .from('pedido_evidencias')
      .select('url, tipo, nota')
      .eq('pedido_id', pedido.id);

    // 3. Limpiar datos para respuesta pública (Privacidad)
    const respuesta = {
      folio: pedido.folio,
      cliente: nombreCliente.split(' ')[0],
      descripcion: pedido.descripcion,
      estado: pedido.estado,
      total: pedido.monto_total,
      pendiente: pedido.saldo_pendiente,
      fecha_entrega: pedido.fecha_entrega_estimada,
      fotos: evidencias || []
    };

    res.json(respuesta);

  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default r;