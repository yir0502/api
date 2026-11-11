import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { escapeLike } from '../lib/validate';
import { LealtadService } from '../services/lealtad.service';

const r = Router();

const ORG_ID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

interface ClienteRastreoRow {
  id: string;
  nombre: string | null;
  apto_promociones: boolean | null;
  monedero: number | string | null;
  contador_servicios: number | string | null;
}

interface PedidoRastreoRow {
  id: string;
  org_id: string;
  folio: string;
  estado: string;
  descripcion: string | null;
  monto_total: number;
  saldo_pendiente: number;
  fecha_entrega_estimada: string | null;
  descuento_aplicado: number | null;
  promo_canjeada: boolean | null;
  clientes: ClienteRastreoRow | ClienteRastreoRow[] | null;
}

class HttpStatusError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function resolverOrgPorFolioUnico(folioRaw: string): Promise<string> {
  const folioNorm = folioRaw.trim();
  if (!folioNorm) {
    throw new HttpStatusError(400, 'Folio inválido');
  }

  const { data, error } = await supabaseAdmin
    .from('pedidos')
    .select('org_id')
    .ilike('folio', escapeLike(folioNorm))
    .limit(2);

  if (error) throw error;
  if (!data || data.length === 0) {
    throw new HttpStatusError(404, 'Pedido no encontrado');
  }

  const orgIdsUnicos = Array.from(
    new Set(data.map((row: { org_id: string }) => row.org_id).filter(Boolean))
  );

  if (orgIdsUnicos.length > 1) {
    throw new HttpStatusError(409, 'Enlace ambiguo. Solicita en sucursal el enlace actualizado de tu pedido.');
  }

  return orgIdsUnicos[0];
}

async function obtenerDetalleRastreo(orgId: string, folioRaw: string) {
  const folioNorm = folioRaw.trim();
  if (!folioNorm) {
    throw new HttpStatusError(400, 'Folio inválido');
  }

  const { data: pedidoData, error } = await supabaseAdmin
    .from('pedidos')
    .select(`
      id, org_id, folio, estado, descripcion, monto_total, saldo_pendiente,
      fecha_entrega_estimada, descuento_aplicado, promo_canjeada,
      clientes(id, nombre, apto_promociones, monedero, contador_servicios)
    `)
    .eq('org_id', orgId.toLowerCase())
    .ilike('folio', escapeLike(folioNorm))
    .maybeSingle();

  if (error) throw error;
  const pedido = pedidoData as PedidoRastreoRow | null;
  if (!pedido) {
    throw new HttpStatusError(404, 'Pedido no encontrado');
  }

  let clienteData = {
    nombre: 'Cliente',
    apto_promociones: false,
    monedero: 0,
    contador_servicios: 0,
  };

  if (pedido.clientes) {
    const raw = Array.isArray(pedido.clientes) ? pedido.clientes[0] : pedido.clientes;
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

  return {
    org_id: pedido.org_id,
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
    lealtad: LealtadService.construirInfoLealtadPublica(clienteData, {
      estado: pedido.estado,
      promo_canjeada: pedido.promo_canjeada ?? false,
      descuento_aplicado: pedido.descuento_aplicado ?? 0,
      monto_total: pedido.monto_total,
      saldo_pendiente: pedido.saldo_pendiente,
    }),
  };
}

function responderErrorRastreo(etiqueta: string, err: unknown, res: import('express').Response) {
  if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
    const msg = 'message' in err && typeof err.message === 'string' ? err.message : 'Error en solicitud';
    return res.status(err.status).json({ error: msg });
  }
  console.error(etiqueta, err);
  return res.status(500).json({ error: 'Error interno del servidor' });
}

r.get(`/:orgId(${ORG_ID_PATTERN})/:folio`, async (req, res) => {
  try {
    const { orgId, folio } = req.params;
    const respuesta = await obtenerDetalleRastreo(orgId, folio);
    res.json(respuesta);
  } catch (e: unknown) {
    responderErrorRastreo('[rastreo] GET /rastreo/:orgId/:folio', e, res);
  }
});

r.post(`/:orgId(${ORG_ID_PATTERN})/:folio/canjear`, async (req, res) => {
  try {
    const { orgId, folio } = req.params;
    const result = await LealtadService.canjearMonederoEnPedido(orgId.toLowerCase(), folio);
    res.json(result);
  } catch (e: unknown) {
    responderErrorRastreo('[rastreo] POST /rastreo/:orgId/:folio/canjear', e, res);
  }
});

// Compatibilidad con enlaces previos de 1 segmento cuando el folio no presenta colision entre organizaciones
r.get('/:folio', async (req, res) => {
  try {
    const { folio } = req.params;
    const orgId = await resolverOrgPorFolioUnico(folio);
    const respuesta = await obtenerDetalleRastreo(orgId, folio);
    res.json(respuesta);
  } catch (e: unknown) {
    responderErrorRastreo('[rastreo] GET /rastreo/:folio', e, res);
  }
});

r.post('/:folio/canjear', async (req, res) => {
  try {
    const { folio } = req.params;
    const orgId = await resolverOrgPorFolioUnico(folio);
    const result = await LealtadService.canjearMonederoEnPedido(orgId, folio);
    res.json(result);
  } catch (e: unknown) {
    responderErrorRastreo('[rastreo] POST /rastreo/:folio/canjear', e, res);
  }
});

export default r;
