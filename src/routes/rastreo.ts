import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';

const r = Router();

// Estados que permiten canjear (pedido activo)
const ESTADOS_ACTIVOS = ['recibido', 'lavando', 'secando', 'doblando', 'listo'];

// ─── GET /rastreo/:folio ──────────────────────────────────────────────────────
// Ruta pública. Devuelve estado del pedido + datos de lealtad del cliente.
r.get('/:folio', async (req, res) => {
  try {
    const { folio } = req.params;

    const { data: pedido, error } = await supabaseAdmin
      .from('pedidos')
      .select(`
        id, folio, estado, descripcion, monto_total, saldo_pendiente,
        fecha_entrega_estimada, descuento_aplicado, promo_canjeada,
        clientes(id, nombre, apto_promociones, monedero, contador_servicios)
      `)
      .ilike('folio', folio)
      .maybeSingle();

    if (error) throw error;
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    // Extraer datos del cliente (puede ser objeto o array según Supabase)
    const c = (pedido as any).clientes;
    let clienteData = { nombre: 'Cliente', apto_promociones: false, monedero: 0, contador_servicios: 0 };

    if (c) {
      const raw = Array.isArray(c) ? c[0] : c;
      if (raw) {
        clienteData = {
          nombre: raw.nombre || 'Cliente',
          apto_promociones: raw.apto_promociones ?? false,
          monedero: Number(raw.monedero) || 0,
          contador_servicios: Number(raw.contador_servicios) || 0,
        };
      }
    }

    // Buscar evidencias (fotos)
    const { data: evidencias } = await supabaseAdmin
      .from('pedido_evidencias')
      .select('url, tipo, nota')
      .eq('pedido_id', pedido.id);

    // Calcular progreso en el ciclo de lealtad (ciclo de 4 servicios)
    const serviciosEnCiclo = clienteData.contador_servicios % 4;
    const serviciosParaProxima = 4 - serviciosEnCiclo;
    const proximaGanancia = serviciosEnCiclo === 3 ? 30 : 10;

    // Solo exponer primer nombre por privacidad
    const primerNombre = clienteData.nombre.split(' ')[0];

    const respuesta = {
      folio: pedido.folio,
      cliente: primerNombre,
      descripcion: pedido.descripcion,
      estado: pedido.estado,
      total: pedido.monto_total,
      pendiente: pedido.saldo_pendiente,
      fecha_entrega: pedido.fecha_entrega_estimada,
      descuento_aplicado: pedido.descuento_aplicado,
      promo_canjeada: pedido.promo_canjeada,
      fotos: evidencias || [],
      // Datos de lealtad (solo si aplica)
      lealtad: clienteData.apto_promociones
        ? {
            apto: true,
            monedero: clienteData.monedero,
            contador_servicios: clienteData.contador_servicios,
            servicios_en_ciclo: serviciosEnCiclo,
            servicios_para_proxima: serviciosParaProxima,
            proxima_ganancia: proximaGanancia,
            puede_canjear: clienteData.monedero > 0 && ESTADOS_ACTIVOS.includes(pedido.estado) && !pedido.promo_canjeada,
          }
        : { apto: false },
    };

    res.json(respuesta);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /rastreo/:folio/canjear ─────────────────────────────────────────────
// Ruta pública. El cliente canjea su saldo acumulado en un pedido activo.
r.post('/:folio/canjear', async (req, res) => {
  try {
    const { folio } = req.params;

    // 1. Obtener el pedido con datos del cliente
    const { data: pedido, error: pedidoError } = await supabaseAdmin
      .from('pedidos')
      .select('id, estado, saldo_pendiente, promo_canjeada, cliente_id')
      .ilike('folio', folio)
      .maybeSingle();

    if (pedidoError) throw pedidoError;
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    // 2. Validar que el pedido esté activo
    if (!ESTADOS_ACTIVOS.includes(pedido.estado)) {
      return res.status(409).json({
        error: 'No se puede canjear en un pedido entregado o cancelado. Tu saldo sigue disponible para el próximo pedido.'
      });
    }

    // 3. Validar idempotencia: que no se haya canjeado ya
    if (pedido.promo_canjeada) {
      return res.status(409).json({ error: 'Ya se aplicó una promoción a este pedido.' });
    }

    // 4. Validar que tiene cliente asociado
    if (!pedido.cliente_id) {
      return res.status(400).json({ error: 'Este pedido no tiene un cliente registrado.' });
    }

    // 5. Obtener datos del cliente
    const { data: cliente, error: clienteError } = await supabaseAdmin
      .from('clientes')
      .select('monedero, apto_promociones')
      .eq('id', pedido.cliente_id)
      .single();

    if (clienteError) throw clienteError;
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

    // 6. Validar aptitud y saldo
    if (!cliente.apto_promociones) {
      return res.status(403).json({ error: 'Este cliente no está inscrito en el programa de lealtad.' });
    }

    const monedero = Number(cliente.monedero) || 0;
    if (monedero <= 0) {
      return res.status(400).json({ error: 'No tienes saldo acumulado disponible.' });
    }

    // 7. Calcular descuento (solo lo necesario, no más del saldo pendiente)
    const saldoPendiente = Number(pedido.saldo_pendiente) || 0;
    const descuento = Math.min(monedero, saldoPendiente);
    const nuevoSaldo = Math.max(0, saldoPendiente - descuento);
    const monederoRestante = monedero - descuento;

    // 8. Actualizar pedido: aplicar descuento y marcar como canjeado
    const { error: updatePedidoError } = await supabaseAdmin
      .from('pedidos')
      .update({
        descuento_aplicado: descuento,
        saldo_pendiente: nuevoSaldo,
        promo_canjeada: true,
      })
      .eq('id', pedido.id);

    if (updatePedidoError) throw updatePedidoError;

    // 9. Actualizar monedero del cliente
    const { error: updateClienteError } = await supabaseAdmin
      .from('clientes')
      .update({ monedero: monederoRestante })
      .eq('id', pedido.cliente_id);

    if (updateClienteError) throw updateClienteError;

    res.json({
      ok: true,
      descuento_aplicado: descuento,
      saldo_pendiente: nuevoSaldo,
      monedero_restante: monederoRestante,
      mensaje: `¡Listo! Se aplicó un descuento de $${descuento.toFixed(2)} a tu pedido.`,
    });

  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default r;