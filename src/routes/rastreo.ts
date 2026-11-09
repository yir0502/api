import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { LealtadService } from '../services/lealtad.service';

const r = Router();

const ORG_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// ─── GET /rastreo/:orgId/:folio ───────────────────────────────────────────────
// Ruta pública. Devuelve estado del pedido + datos de lealtad del cliente.
r.get(`/:orgId(${ORG_ID_PATTERN})/:folio`, async (req, res) => {
  try {
    const { orgId, folio } = req.params;

    const { data: pedido, error } = await supabaseAdmin
      .from('pedidos')
      .select(`
        id, folio, estado, descripcion, monto_total, saldo_pendiente,
        fecha_entrega_estimada, descuento_aplicado, promo_canjeada,
        clientes(id, nombre, apto_promociones, monedero, contador_servicios)
      `)
      .eq('org_id', orgId)
      .eq('folio', folio)
      .maybeSingle();

    if (error) throw error;
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

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

    const { data: evidencias } = await supabaseAdmin
      .from('pedido_evidencias')
      .select('url, tipo, nota')
      .eq('pedido_id', pedido.id);

    const primerNombre = clienteData.nombre.split(' ')[0];
    const tieneDescuentoActivo = Boolean(pedido.promo_canjeada && Number(pedido.descuento_aplicado) > 0);

    const respuesta = {
      folio: pedido.folio,
      cliente: primerNombre,
      descripcion: pedido.descripcion,
      estado: pedido.estado,
      total: pedido.monto_total,
      pendiente: pedido.saldo_pendiente,
      fecha_entrega: pedido.fecha_entrega_estimada,
      descuento_aplicado: pedido.descuento_aplicado,
      promo_canjeada: tieneDescuentoActivo,
      fotos: evidencias || [],
      lealtad: LealtadService.construirInfoLealtadPublica(clienteData, pedido),
    };

    res.json(respuesta);
  } catch (e: any) {
    console.error('[rastreo] GET /rastreo/:orgId/:folio', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── POST /rastreo/:orgId/:folio/canjear ──────────────────────────────────────
// Ruta pública. El cliente canjea su saldo acumulado en un pedido activo.
r.post(`/:orgId(${ORG_ID_PATTERN})/:folio/canjear`, async (req, res) => {
  try {
    const { orgId, folio } = req.params;
    const result = await LealtadService.canjearMonederoEnPedido(orgId, folio);
    res.json(result);
  } catch (e: any) {
    if (e?.status) {
      return res.status(e.status).json({ error: e.message });
    }
    console.error('[rastreo] POST /rastreo/:orgId/:folio/canjear', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── Rutas legadas (sin org) ──────────────────────────────────────────────────
r.get('/:folio', (_req, res) => {
  res.status(410).json({ error: 'Ruta obsoleta. Usa /rastreo/:orgId/:folio' });
});

r.post('/:folio/canjear', (_req, res) => {
  res.status(410).json({ error: 'Ruta obsoleta. Usa /rastreo/:orgId/:folio/canjear' });
});

export default r;
