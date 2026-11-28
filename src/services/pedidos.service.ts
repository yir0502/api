import sharp from 'sharp';
import { supabaseAdmin } from '../lib/supabase';
import { escapeLike } from '../lib/validate';
import { LealtadService } from './lealtad.service';
import { MovimientosService } from './movimientos.service';
import { EventoWhatsappPedido, WhatsappService } from './whatsapp.service';

export type MetodoPagoPedido = 'efectivo' | 'transferencia' | 'tarjeta' | 'mercado_pago' | 'otro';

export interface CrearPedidoInput {
  cliente_id?: string | null;
  sucursal_id?: string | null;
  descripcion?: string | null;
  fecha_entrega_estimada?: string | null;
  monto_total: number;
  saldo_pendiente: number;
  descuento_aplicado?: number;
  promo_canjeada?: boolean;
  registrar_pago?: boolean;
  metodo_pago?: MetodoPagoPedido | null;
  categoria_ingreso_id?: string | null;
  omitir_whatsapp?: boolean;
}

export interface ActualizarPedidoInput {
  estado?: string;
  descripcion?: string | null;
  monto_total?: number;
  saldo_pendiente?: number;
  descuento_aplicado?: number;
  fecha_entrega_estimada?: string | null;
  sucursal_id?: string | null;
  puntos_generados?: boolean;
  promo_canjeada?: boolean;
  fecha_entregado?: string;
  monto_cobrado?: number;
  metodo_pago?: MetodoPagoPedido | null;
  categoria_ingreso_id?: string | null;
  omitir_whatsapp?: boolean;
}

export const SUPABASE_BATCH_SIZE = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTERO_NO_NEGATIVO_RE = /^\d+$/;
const POR_COBRAR_UMBRAL = 0.005;
const DEFAULT_LIMIT_PAGINADO = 20;
const MIN_LIMIT_PAGINADO = 1;
const MAX_LIMIT_PAGINADO = 100;
const DEFAULT_OFFSET_PAGINADO = 0;
const SELECT_PEDIDOS_LISTADO = '*, clientes(nombre, telefono), sucursales(nombre)';

export type EstadoPedidoFiltro =
  | 'recibido'
  | 'lavando'
  | 'secando'
  | 'doblando'
  | 'listo'
  | 'entregado'
  | 'cancelado';

export const ESTADOS_PEDIDO_VALIDOS: readonly EstadoPedidoFiltro[] = [
  'recibido',
  'lavando',
  'secando',
  'doblando',
  'listo',
  'entregado',
  'cancelado',
];

const ESTADOS_PEDIDO_SET: ReadonlySet<string> = new Set<string>(ESTADOS_PEDIDO_VALIDOS);
const ESTADOS_ACTIVOS_LISTADO: readonly string[] = [
  'recibido',
  'lavando',
  'secando',
  'doblando',
  'listo',
  'en_proceso',
];
const ESTADOS_EN_PROCESO_SET: ReadonlySet<string> = new Set([
  'recibido',
  'lavando',
  'secando',
  'doblando',
  'en_proceso',
]);
const ESTADOS_HISTORIAL_LISTADO: readonly string[] = ['entregado', 'cancelado'];
const ESTADOS_HISTORIAL_SET: ReadonlySet<string> = new Set(ESTADOS_HISTORIAL_LISTADO);

export class PedidosValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'PedidosValidationError';
  }
}

export interface ClienteRelacion {
  id?: string;
  nombre: string;
  telefono: string;
  permite_whatsapp?: boolean;
}

export interface SucursalRelacion {
  id?: string;
  nombre?: string | null;
}

export interface PedidoDbRow {
  id: string;
  org_id: string;
  folio: string;
  cliente_id?: string | null;
  sucursal_id?: string | null;
  estado: string;
  descripcion?: string | null;
  monto_total?: number | null;
  saldo_pendiente?: number | null;
  descuento_aplicado?: number | null;
  promo_canjeada?: boolean | null;
  puntos_generados?: boolean | null;
  fecha_entrega_estimada?: string | null;
  fecha_entregado?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  clientes?: ClienteRelacion | ClienteRelacion[] | null;
  sucursales?: SucursalRelacion | SucursalRelacion[] | null;
}

export interface PedidoRecord extends PedidoDbRow {
  cliente_nombre: string;
  cliente_telefono: string;
  sucursal_nombre: string;
  whatsapp_automatico: boolean;
}

export interface PedidosPorEstadoCount {
  recibido: number;
  lavando: number;
  secando: number;
  doblando: number;
  listo: number;
  entregado: number;
  cancelado: number;
}

export interface PedidosResumen {
  total: number;
  en_proceso: number;
  listos: number;
  por_cobrar_count: number;
  por_cobrar_monto: number;
  por_estado: PedidosPorEstadoCount;
}

export interface PedidosPaginadosResponse {
  data: PedidoRecord[];
  count: number;
  resumen: PedidosResumen;
}

export interface ListarPedidosPaginadosParams {
  activo?: unknown;
  q?: unknown;
  sucursal_id?: unknown;
  estado?: unknown;
  solo_por_cobrar?: unknown;
  desde?: unknown;
  hasta?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export interface PedidosPaginadosOptions {
  activo: boolean;
  q?: string;
  sucursalId?: string;
  estado?: EstadoPedidoFiltro;
  soloPorCobrar: boolean;
  desde?: string;
  hasta?: string;
  limit: number;
  offset: number;
}

interface CategoriaIngresoRow {
  id: string;
  nombre?: string | null;
  activo?: boolean | null;
}

const CATEGORIA_DEFAULT_TTL_MS = 5 * 60 * 1000;
const categoriaDefaultCache = new Map<string, { id: string | null; expiresAt: number }>();

function normalizarRelacionCliente(rel: ClienteRelacion | ClienteRelacion[] | null | undefined): ClienteRelacion | null {
  if (!rel) return null;
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

function normalizarRelacionSucursal(
  rel: SucursalRelacion | SucursalRelacion[] | null | undefined
): SucursalRelacion | null {
  if (!rel) return null;
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

function mapearPedidoListado(row: PedidoDbRow, waAuto: boolean): PedidoRecord {
  const cli = normalizarRelacionCliente(row.clientes);
  const suc = normalizarRelacionSucursal(row.sucursales);
  return {
    ...row,
    cliente_nombre: cli?.nombre || 'Cliente Manual',
    cliente_telefono: cli?.telefono || '',
    sucursal_nombre: suc?.nombre || 'Sin sucursal',
    whatsapp_automatico: waAuto,
  };
}

function redondearDosDecimales(valor: number): number {
  const redondeado = Math.round(valor * 100) / 100;
  return redondeado === 0 ? 0 : redondeado;
}

function esFechaISOValida(valor: string): boolean {
  if (!FECHA_ISO_RE.test(valor)) return false;
  const [anio, mes, dia] = valor.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  return (
    fecha.getUTCFullYear() === anio &&
    fecha.getUTCMonth() === mes - 1 &&
    fecha.getUTCDate() === dia
  );
}

function esEstadoPedidoValido(valor: string): valor is EstadoPedidoFiltro {
  return ESTADOS_PEDIDO_SET.has(valor);
}

function extraerValorQuery(valor: unknown): unknown {
  if (Array.isArray(valor)) {
    return valor.length > 0 ? valor[0] : undefined;
  }
  return valor;
}

function parsearActivo(raw: unknown): boolean {
  const candidato = extraerValorQuery(raw);
  if (candidato === undefined || candidato === null) return true;
  if (typeof candidato === 'boolean') return candidato;
  if (typeof candidato === 'string') {
    const limpio = candidato.trim().toLowerCase();
    if (limpio === '') return true;
    if (limpio === 'true') return true;
    if (limpio === 'false') return false;
  }
  throw new PedidosValidationError('El parámetro activo debe ser "true" o "false"');
}

function parsearBusqueda(raw: unknown): string | undefined {
  const candidato = extraerValorQuery(raw);
  if (candidato === undefined || candidato === null) return undefined;
  if (typeof candidato !== 'string') {
    throw new PedidosValidationError('El parámetro q debe ser una cadena de texto');
  }
  const limpio = candidato.trim();
  return limpio.length > 0 ? limpio : undefined;
}

function parsearSucursalId(raw: unknown): string | undefined {
  const candidato = extraerValorQuery(raw);
  if (candidato === undefined || candidato === null) return undefined;
  if (typeof candidato !== 'string') {
    throw new PedidosValidationError('El parámetro sucursal_id debe ser un UUID válido');
  }
  const limpio = candidato.trim();
  if (limpio === '') return undefined;
  if (!UUID_RE.test(limpio)) {
    throw new PedidosValidationError('El parámetro sucursal_id debe ser un UUID válido');
  }
  return limpio;
}

function parsearEstado(raw: unknown): EstadoPedidoFiltro | undefined {
  const candidato = extraerValorQuery(raw);
  if (candidato === undefined || candidato === null) return undefined;
  if (typeof candidato !== 'string') {
    throw new PedidosValidationError(
      'El parámetro estado es inválido. Valores permitidos: recibido, lavando, secando, doblando, listo, entregado, cancelado'
    );
  }
  const limpio = candidato.trim().toLowerCase();
  if (limpio === '') return undefined;
  if (!esEstadoPedidoValido(limpio)) {
    throw new PedidosValidationError(
      'El parámetro estado es inválido. Valores permitidos: recibido, lavando, secando, doblando, listo, entregado, cancelado'
    );
  }
  return limpio;
}

function parsearSoloPorCobrar(raw: unknown): boolean {
  const candidato = extraerValorQuery(raw);
  if (candidato === undefined || candidato === null) return false;
  if (typeof candidato === 'boolean') return candidato;
  if (typeof candidato === 'string') {
    const limpio = candidato.trim().toLowerCase();
    if (limpio === '') return false;
    if (limpio === 'true' || limpio === '1') return true;
    if (limpio === 'false' || limpio === '0') return false;
  }
  throw new PedidosValidationError('El parámetro solo_por_cobrar debe ser "true", "false", "1" o "0"');
}

function parsearFechaFiltro(raw: unknown, campo: 'desde' | 'hasta'): string | undefined {
  const candidato = extraerValorQuery(raw);
  if (candidato === undefined || candidato === null) return undefined;
  if (typeof candidato !== 'string') {
    throw new PedidosValidationError(`La fecha ${campo} es inválida; use el formato YYYY-MM-DD`);
  }
  const limpio = candidato.trim();
  if (limpio === '') return undefined;
  if (!esFechaISOValida(limpio)) {
    throw new PedidosValidationError(`La fecha ${campo} es inválida; use el formato YYYY-MM-DD`);
  }
  return limpio;
}

function parsearLimit(raw: unknown): number {
  const candidato = extraerValorQuery(raw);
  if (candidato === undefined || candidato === null) return DEFAULT_LIMIT_PAGINADO;

  let valor: number;
  if (typeof candidato === 'number') {
    if (!Number.isInteger(candidato)) {
      throw new PedidosValidationError('El parámetro limit debe ser un número entero entre 1 y 100');
    }
    valor = candidato;
  } else if (typeof candidato === 'string') {
    const limpio = candidato.trim();
    if (limpio === '') return DEFAULT_LIMIT_PAGINADO;
    if (!ENTERO_NO_NEGATIVO_RE.test(limpio)) {
      throw new PedidosValidationError('El parámetro limit debe ser un número entero entre 1 y 100');
    }
    valor = Number(limpio);
  } else {
    throw new PedidosValidationError('El parámetro limit debe ser un número entero entre 1 y 100');
  }

  if (!Number.isSafeInteger(valor) || valor < MIN_LIMIT_PAGINADO || valor > MAX_LIMIT_PAGINADO) {
    throw new PedidosValidationError('El parámetro limit debe ser un número entero entre 1 y 100');
  }

  return valor;
}

function parsearOffset(raw: unknown): number {
  const candidato = extraerValorQuery(raw);
  if (candidato === undefined || candidato === null) return DEFAULT_OFFSET_PAGINADO;

  let valor: number;
  if (typeof candidato === 'number') {
    if (!Number.isInteger(candidato) || candidato < 0) {
      throw new PedidosValidationError('El parámetro offset debe ser un número entero mayor o igual a 0');
    }
    valor = candidato;
  } else if (typeof candidato === 'string') {
    const limpio = candidato.trim();
    if (limpio === '') return DEFAULT_OFFSET_PAGINADO;
    if (!ENTERO_NO_NEGATIVO_RE.test(limpio)) {
      throw new PedidosValidationError('El parámetro offset debe ser un número entero mayor o igual a 0');
    }
    valor = Number(limpio);
  } else {
    throw new PedidosValidationError('El parámetro offset debe ser un número entero mayor o igual a 0');
  }

  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new PedidosValidationError('El parámetro offset debe ser un número entero mayor o igual a 0');
  }

  return valor;
}

export function normalizarParamsPedidosPaginados(
  params: ListarPedidosPaginadosParams = {}
): PedidosPaginadosOptions {
  const activo = parsearActivo(params.activo);
  const q = parsearBusqueda(params.q);
  const sucursalId = parsearSucursalId(params.sucursal_id);
  const estado = parsearEstado(params.estado);
  const soloPorCobrar = parsearSoloPorCobrar(params.solo_por_cobrar);
  const desde = parsearFechaFiltro(params.desde, 'desde');
  const hasta = parsearFechaFiltro(params.hasta, 'hasta');
  const limit = parsearLimit(params.limit);
  const offset = parsearOffset(params.offset);

  if (desde !== undefined && hasta !== undefined && desde > hasta) {
    throw new PedidosValidationError('Rango de fechas inválido: desde no puede ser mayor que hasta');
  }

  return {
    activo,
    q,
    sucursalId,
    estado,
    soloPorCobrar,
    desde,
    hasta,
    limit,
    offset,
  };
}

function obtenerSaldoPendiente(pedido: {
  estado?: string | null;
  saldo_pendiente?: number | string | null;
}): number {
  if (pedido.estado === 'cancelado') return 0;
  const saldo = Number(pedido.saldo_pendiente);
  if (!Number.isFinite(saldo) || saldo <= POR_COBRAR_UMBRAL) return 0;
  return saldo;
}

function estaPorCobrar(pedido: {
  estado?: string | null;
  saldo_pendiente?: number | string | null;
}): boolean {
  return obtenerSaldoPendiente(pedido) > POR_COBRAR_UMBRAL;
}

function crearResumenVacio(): PedidosResumen {
  return {
    total: 0,
    en_proceso: 0,
    listos: 0,
    por_cobrar_count: 0,
    por_cobrar_monto: 0,
    por_estado: {
      recibido: 0,
      lavando: 0,
      secando: 0,
      doblando: 0,
      listo: 0,
      entregado: 0,
      cancelado: 0,
    },
  };
}

export function calcularResumenPedidos(pedidos: ReadonlyArray<PedidoRecord>): PedidosResumen {
  const resumen = crearResumenVacio();
  let montoPorCobrar = 0;

  for (const pedido of pedidos) {
    resumen.total += 1;

    const estado = pedido.estado;
    // Las filas legacy con estado en_proceso cuentan en total y en_proceso sin alterar las 7 claves exactas de por_estado.
    if (esEstadoPedidoValido(estado)) {
      resumen.por_estado[estado] += 1;
    }

    if (ESTADOS_EN_PROCESO_SET.has(estado)) {
      resumen.en_proceso += 1;
    } else if (estado === 'listo') {
      resumen.listos += 1;
    }

    const saldo = obtenerSaldoPendiente(pedido);
    if (saldo > POR_COBRAR_UMBRAL) {
      resumen.por_cobrar_count += 1;
      montoPorCobrar += saldo;
    }
  }

  resumen.por_cobrar_monto = redondearDosDecimales(montoPorCobrar);
  return resumen;
}

function extraerFechaISODia(valor: string | null | undefined): string | null {
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  if (limpio.length < 10) return null;
  const prefijo = limpio.slice(0, 10);
  return FECHA_ISO_RE.test(prefijo) ? prefijo : null;
}

function obtenerFechaEfectivaHistorial(pedido: {
  fecha_entregado?: string | null;
  created_at?: string | null;
}): string | null {
  return extraerFechaISODia(pedido.fecha_entregado) ?? extraerFechaISODia(pedido.created_at);
}

function parsearTimestamp(valor: string | null | undefined): number | null {
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  if (!limpio) return null;
  const ms = Date.parse(limpio);
  return Number.isFinite(ms) ? ms : null;
}

function compararTextoAsc(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compararTimestampsDescNullsLast(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const tsA = parsearTimestamp(a);
  const tsB = parsearTimestamp(b);
  if (tsA !== null && tsB !== null) {
    if (tsA !== tsB) return tsB - tsA;
    return 0;
  }
  if (tsA !== null) return -1;
  if (tsB !== null) return 1;
  return 0;
}

function compararTimestampsAscNullsLast(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const tsA = parsearTimestamp(a);
  const tsB = parsearTimestamp(b);
  if (tsA !== null && tsB !== null) {
    if (tsA !== tsB) return tsA - tsB;
    return 0;
  }
  if (tsA !== null) return -1;
  if (tsB !== null) return 1;
  return 0;
}

function compararPedidosActivos(a: PedidoRecord, b: PedidoRecord): number {
  const cmpEstimada = compararTimestampsAscNullsLast(
    a.fecha_entrega_estimada,
    b.fecha_entrega_estimada
  );
  if (cmpEstimada !== 0) return cmpEstimada;

  const cmpCreated = compararTimestampsDescNullsLast(a.created_at, b.created_at);
  if (cmpCreated !== 0) return cmpCreated;

  return compararTextoAsc(a.id, b.id);
}

function compararPedidosHistorial(a: PedidoRecord, b: PedidoRecord): number {
  const cmpEntregado = compararTimestampsDescNullsLast(a.fecha_entregado, b.fecha_entregado);
  if (cmpEntregado !== 0) return cmpEntregado;

  const cmpCreated = compararTimestampsDescNullsLast(a.created_at, b.created_at);
  if (cmpCreated !== 0) return cmpCreated;

  return compararTextoAsc(a.id, b.id);
}

function coincideBusquedaPedido(pedido: PedidoRecord, needleLower: string): boolean {
  const folio = (pedido.folio || '').toLowerCase();
  if (folio.includes(needleLower)) return true;

  const descripcion = (pedido.descripcion || '').toLowerCase();
  if (descripcion.includes(needleLower)) return true;

  const cli = normalizarRelacionCliente(pedido.clientes);
  const clienteNombre = (cli?.nombre || '').toLowerCase();
  if (clienteNombre.includes(needleLower)) return true;

  const clienteTelefono = (cli?.telefono || '').toLowerCase();
  return clienteTelefono.includes(needleLower);
}

export class PedidosService {
  static invalidarCacheCategoriaDefault(org_id?: string): void {
    if (org_id) {
      categoriaDefaultCache.delete(org_id);
      return;
    }
    categoriaDefaultCache.clear();
  }

  static generarFolio() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 4; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `LAV-${result}`;
  }

  static extraerTerminoBusqueda(raw: string): string {
    const trimmed = raw.trim();
    // Si proviene de escaneo QR con URL publica de rastreo, extraer directamente el folio
    const folioMatch = /\b(LAV-[A-Z0-9]{4,8})\b/i.exec(trimmed);
    if (folioMatch) {
      return folioMatch[1].toUpperCase();
    }
    return trimmed;
  }

  private static async resolverCategoriaIngresoDefault(
    org_id: string,
    categoriaSolicitada?: string | null,
    categoriaHeredada?: string | null
  ): Promise<string | null> {
    if (categoriaSolicitada) return categoriaSolicitada;
    if (categoriaHeredada) return categoriaHeredada;

    const cached = categoriaDefaultCache.get(org_id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.id;
    }

    let lista: CategoriaIngresoRow[] | null = null;
    const { data: cats, error } = await supabaseAdmin
      .from('categorias')
      .select('id, nombre, activo')
      .eq('org_id', org_id)
      .eq('tipo', 'ingreso')
      .order('nombre', { ascending: true });

    if (error) {
      console.error('Error consultando categorias de ingreso:', error.message);
      const { data: fallbackCats, error: fallbackError } = await supabaseAdmin
        .from('categorias')
        .select('id, nombre')
        .eq('org_id', org_id)
        .eq('tipo', 'ingreso')
        .order('nombre', { ascending: true });

      if (fallbackError) {
        console.error('Error en fallback de categorias de ingreso:', fallbackError.message);
        return null;
      }
      lista = (fallbackCats || []) as CategoriaIngresoRow[];
    } else {
      lista = (cats || []) as CategoriaIngresoRow[];
    }

    if (lista.length === 0) return null;

    const activas = lista.filter((c) => c.activo !== false);
    const candidatas = activas.length > 0 ? activas : lista;
    const elegida = candidatas.length > 1 ? candidatas[1].id : (candidatas[0]?.id ?? null);

    categoriaDefaultCache.set(org_id, {
      id: elegida,
      expiresAt: Date.now() + CATEGORIA_DEFAULT_TTL_MS,
    });
    return elegida;
  }

  static async listarPedidos(
    org_id: string,
    activo?: string,
    q?: string,
    limit?: number,
    offset?: number,
    deuda?: string
  ) {
    let query = supabaseAdmin
      .from('pedidos')
      .select('*, clientes(nombre, telefono), sucursales(nombre)', { count: 'exact' })
      .eq('org_id', org_id)
      .order('created_at', { ascending: false });

    if (activo === 'true') {
      query = query.in('estado', ['recibido', 'lavando', 'secando', 'doblando', 'listo', 'en_proceso']);
    } else if (activo === 'false') {
      query = query.in('estado', ['entregado', 'cancelado']);
    }

    if (deuda === 'true') {
      query = query.eq('estado', 'entregado').gt('saldo_pendiente', 0);
    }

    if (q && String(q).trim()) {
      const termino = this.extraerTerminoBusqueda(String(q));
      const escaped = escapeLike(termino);

      const { data: clientesCoincidentes } = await supabaseAdmin
        .from('clientes')
        .select('id')
        .eq('org_id', org_id)
        .or(`nombre.ilike.%${escaped}%,telefono.ilike.%${escaped}%`)
        .limit(50);

      const filtrosOr = [`folio.ilike.%${escaped}%`, `descripcion.ilike.%${escaped}%`];
      if (clientesCoincidentes && clientesCoincidentes.length > 0) {
        const ids = clientesCoincidentes.map((c) => c.id).join(',');
        filtrosOr.push(`cliente_id.in.(${ids})`);
      }

      query = query.or(filtrosOr.join(','));
    }

    const lim =
      limit !== undefined && Number.isFinite(limit) ? Math.min(Math.max(0, Math.floor(limit)), 100) : undefined;
    const off = offset !== undefined && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : undefined;

    if (lim !== undefined && lim > 0 && off !== undefined) {
      query = query.range(off, off + lim - 1);
    } else if (lim !== undefined && lim > 0) {
      query = query.limit(lim);
    }

    const { data, error } = await query;
    if (error) throw error;

    const waAuto = WhatsappService.isConfigured();
    return ((data || []) as PedidoDbRow[]).map((p) => mapearPedidoListado(p, waAuto));
  }

  private static async obtenerPedidosEnLotes(
    orgId: string,
    estados: readonly string[],
    sucursalId?: string
  ): Promise<PedidoDbRow[]> {
    if (estados.length === 0) return [];

    const acumulado: PedidoDbRow[] = [];
    let inicio = 0;

    // PostgREST limita cada consulta individual a 1000 filas; iteramos por lotes ordenados por id.
    while (true) {
      let consulta = supabaseAdmin
        .from('pedidos')
        .select(SELECT_PEDIDOS_LISTADO)
        .eq('org_id', orgId)
        .in('estado', [...estados]);

      if (sucursalId !== undefined) {
        consulta = consulta.eq('sucursal_id', sucursalId);
      }

      const { data, error } = await consulta
        .order('id', { ascending: true })
        .range(inicio, inicio + SUPABASE_BATCH_SIZE - 1);

      if (error) throw error;

      const lote = (data ?? []) as PedidoDbRow[];
      acumulado.push(...lote);

      if (lote.length < SUPABASE_BATCH_SIZE) {
        break;
      }
      inicio += SUPABASE_BATCH_SIZE;
    }

    return acumulado;
  }

  static async listarPedidosPaginados(
    orgId: string,
    params: ListarPedidosPaginadosParams = {}
  ): Promise<PedidosPaginadosResponse> {
    if (typeof orgId !== 'string' || !orgId.trim()) {
      throw new PedidosValidationError('La organización es requerida');
    }

    const opciones = normalizarParamsPedidosPaginados(params);
    const waAuto = WhatsappService.isConfigured();
    const needleLower = opciones.q
      ? this.extraerTerminoBusqueda(opciones.q).toLowerCase()
      : '';

    if (opciones.activo) {
      const filas = await this.obtenerPedidosEnLotes(
        orgId,
        ESTADOS_ACTIVOS_LISTADO,
        opciones.sucursalId
      );
      let pedidos = filas.map((fila) => mapearPedidoListado(fila, waAuto));

      if (needleLower) {
        pedidos = pedidos.filter((p) => coincideBusquedaPedido(p, needleLower));
      }

      // El resumen de activos se calcula antes de filtrar por estado o solo_por_cobrar para mantener estables los KPIs.
      const resumen = calcularResumenPedidos(pedidos);

      if (opciones.estado) {
        pedidos = pedidos.filter((p) => p.estado === opciones.estado);
      }
      if (opciones.soloPorCobrar) {
        pedidos = pedidos.filter(estaPorCobrar);
      }

      pedidos.sort(compararPedidosActivos);

      return {
        data: pedidos,
        count: pedidos.length,
        resumen,
      };
    }

    const estadosHistorial: readonly string[] = opciones.estado
      ? ESTADOS_HISTORIAL_SET.has(opciones.estado)
        ? [opciones.estado]
        : []
      : ESTADOS_HISTORIAL_LISTADO;

    if (estadosHistorial.length === 0) {
      return {
        data: [],
        count: 0,
        resumen: crearResumenVacio(),
      };
    }

    const filas = await this.obtenerPedidosEnLotes(
      orgId,
      estadosHistorial,
      opciones.sucursalId
    );
    let pedidos = filas.map((fila) => mapearPedidoListado(fila, waAuto));

    if (opciones.estado) {
      pedidos = pedidos.filter((p) => p.estado === opciones.estado);
    }
    if (needleLower) {
      pedidos = pedidos.filter((p) => coincideBusquedaPedido(p, needleLower));
    }
    if (opciones.soloPorCobrar) {
      pedidos = pedidos.filter(estaPorCobrar);
    }
    if (opciones.desde !== undefined || opciones.hasta !== undefined) {
      pedidos = pedidos.filter((p) => {
        const fechaEfectiva = obtenerFechaEfectivaHistorial(p);
        if (!fechaEfectiva) return false;
        if (opciones.desde !== undefined && fechaEfectiva < opciones.desde) return false;
        if (opciones.hasta !== undefined && fechaEfectiva > opciones.hasta) return false;
        return true;
      });
    }

    const resumen = calcularResumenPedidos(pedidos);
    const count = pedidos.length;

    pedidos.sort(compararPedidosHistorial);
    const data = pedidos.slice(opciones.offset, opciones.offset + opciones.limit);

    return {
      data,
      count,
      resumen,
    };
  }

  static async obtenerPedido(id: string, org_id: string) {
    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .select('*, clientes(nombre, telefono), sucursales(nombre)')
      .eq('id', id)
      .eq('org_id', org_id)
      .single();
    if (error) throw error;

    const cli = normalizarRelacionCliente(data.clientes as ClienteRelacion | ClienteRelacion[] | null);
    const suc = Array.isArray(data.sucursales) ? data.sucursales[0] : data.sucursales;
    return {
      ...data,
      cliente_nombre: cli?.nombre || 'Cliente Manual',
      cliente_telefono: cli?.telefono || '',
      sucursal_nombre: (suc as { nombre?: string } | null)?.nombre || 'Sin sucursal',
      whatsapp_automatico: WhatsappService.isConfigured(),
    };
  }

  static async crearPedido(org_id: string, payload: CrearPedidoInput, usuario_id?: string) {
    const folio = this.generarFolio();
    const { registrar_pago, metodo_pago, categoria_ingreso_id, omitir_whatsapp, ...pedidoFields } = payload;

    let clienteData: ClienteRelacion | null = null;

    if (pedidoFields.cliente_id) {
      const { data: cliente } = await supabaseAdmin
        .from('clientes')
        .select('id, nombre, telefono, permite_whatsapp')
        .eq('id', pedidoFields.cliente_id)
        .eq('org_id', org_id)
        .maybeSingle();
      if (!cliente) throw new Error('cliente_id inválido');
      clienteData = cliente;
    }

    if (pedidoFields.sucursal_id) {
      const { data: sucursal } = await supabaseAdmin
        .from('sucursales')
        .select('id')
        .eq('id', pedidoFields.sucursal_id)
        .eq('org_id', org_id)
        .maybeSingle();
      if (!sucursal) throw new Error('sucursal_id inválido');
    }

    const hasDiscount = Boolean(pedidoFields.descuento_aplicado && Number(pedidoFields.descuento_aplicado) > 0);
    const dataToInsert = {
      ...pedidoFields,
      org_id,
      folio,
      estado: 'recibido',
      promo_canjeada: hasDiscount ? true : (pedidoFields.promo_canjeada ?? false),
    };

    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .insert(dataToInsert)
      .select()
      .single();

    if (error) throw error;

    if (pedidoFields.cliente_id) {
      await supabaseAdmin
        .from('clientes')
        .update({ ultima_visita: new Date().toISOString() })
        .eq('id', pedidoFields.cliente_id)
        .eq('org_id', org_id);
    }

    if (pedidoFields.descuento_aplicado && pedidoFields.descuento_aplicado > 0 && pedidoFields.cliente_id) {
      await LealtadService.descontarMonederoInicial(org_id, pedidoFields.cliente_id, pedidoFields.descuento_aplicado);
    }

    const montoTotal = Number(data.monto_total) || 0;
    const descuento = Number(data.descuento_aplicado) || 0;
    const saldoPendiente = Number(data.saldo_pendiente) || 0;
    const anticipo = Math.max(0, Number((montoTotal - descuento - saldoPendiente).toFixed(2)));

    let movimientoRegistrado = false;
    if (registrar_pago && anticipo > 0 && usuario_id) {
      const categoriaId = await this.resolverCategoriaIngresoDefault(org_id, categoria_ingreso_id);
      const now = new Date();
      const fechaISO = now.toISOString().slice(0, 10);
      const fechaCorta = now.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' });
      const etiqueta = saldoPendiente === 0 ? 'Pago total' : 'Anticipo';
      const detalle = data.descripcion ? `(${data.descripcion})` : `(Folio: ${data.folio})`;
      const nota = `Pedido ${clienteData?.nombre || 'Cliente'} ${detalle}. ${etiqueta}: $${anticipo.toFixed(2)} (${fechaCorta})`;

      await MovimientosService.crearMovimiento(org_id, usuario_id, {
        tipo: 'ingreso',
        monto: anticipo,
        categoria_id: categoriaId,
        sucursal_id: data.sucursal_id || null,
        pedido_id: data.id,
        fecha: fechaISO,
        metodo_pago: metodo_pago || 'efectivo',
        nota,
      });
      movimientoRegistrado = true;
    }

    const waConfigurado = WhatsappService.isConfigured();
    let whatsappDisparado = false;
    if (!omitir_whatsapp && waConfigurado && clienteData?.telefono && clienteData.permite_whatsapp !== false) {
      whatsappDisparado = true;
      void WhatsappService.notificarPedido({
        orgId: org_id,
        folio: data.folio,
        estado: 'recibido',
        clienteNombre: clienteData.nombre,
        clienteTelefono: clienteData.telefono,
        permiteWhatsapp: clienteData.permite_whatsapp,
        montoTotal,
        saldoPendiente,
      });
    }

    return {
      ...data,
      cliente_nombre: clienteData?.nombre || 'Cliente Manual',
      cliente_telefono: clienteData?.telefono || '',
      movimiento_registrado: movimientoRegistrado,
      whatsapp_automatico: waConfigurado,
      whatsapp_disparado: whatsappDisparado,
    };
  }

  static async actualizarPedido(id: string, org_id: string, updates: ActualizarPedidoInput, usuario_id?: string) {
    const { monto_cobrado, metodo_pago, categoria_ingreso_id, omitir_whatsapp, ...dbUpdates } = updates;

    const { data: currentPedido } = await supabaseAdmin
      .from('pedidos')
      .select(
        'folio, descripcion, sucursal_id, cliente_id, puntos_generados, estado, promo_canjeada, descuento_aplicado, monto_total, saldo_pendiente, clientes(nombre, telefono, permite_whatsapp)'
      )
      .eq('id', id)
      .eq('org_id', org_id)
      .single();

    if (!currentPedido) throw new Error('Pedido no encontrado o sin acceso');

    if (dbUpdates.sucursal_id) {
      const { data: sucursal } = await supabaseAdmin
        .from('sucursales')
        .select('id')
        .eq('id', dbUpdates.sucursal_id)
        .eq('org_id', org_id)
        .maybeSingle();
      if (!sucursal) throw new Error('sucursal_id inválido');
    }

    await LealtadService.ajustarDescuentoPorCambioDeTotal(org_id, currentPedido, dbUpdates);

    const estadoAnterior = currentPedido.estado;
    const nuevoEstado = dbUpdates.estado || estadoAnterior;

    if (
      estadoAnterior === 'entregado' &&
      nuevoEstado !== 'entregado' &&
      currentPedido.puntos_generados &&
      currentPedido.cliente_id
    ) {
      const reverted = await LealtadService.revertirCashbackEntrega(org_id, currentPedido.cliente_id);
      if (reverted) {
        dbUpdates.puntos_generados = false;
      }
    }

    const teniaPromo = currentPedido.promo_canjeada || Number(currentPedido.descuento_aplicado) > 0;
    if (
      nuevoEstado === 'cancelado' &&
      estadoAnterior !== 'cancelado' &&
      teniaPromo &&
      Number(currentPedido.descuento_aplicado) > 0 &&
      currentPedido.cliente_id
    ) {
      await LealtadService.devolverAlMonedero(org_id, currentPedido.cliente_id, Number(currentPedido.descuento_aplicado));
      dbUpdates.promo_canjeada = false;
      dbUpdates.descuento_aplicado = 0;
    }

    if (nuevoEstado === 'entregado' && estadoAnterior !== 'entregado') {
      const nowIso = new Date().toISOString();
      dbUpdates.fecha_entregado = nowIso;
      if (currentPedido.cliente_id) {
        const puntosGenerados = await LealtadService.otorgarCashbackEntrega(
          org_id,
          currentPedido.cliente_id,
          Boolean(currentPedido.puntos_generados),
          nowIso
        );
        if (puntosGenerados) {
          dbUpdates.puntos_generados = true;
        }
      }
    }

    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .update(dbUpdates)
      .eq('id', id)
      .eq('org_id', org_id)
      .select()
      .single();

    if (error) throw error;

    const clienteRel = normalizarRelacionCliente(
      currentPedido.clientes as ClienteRelacion | ClienteRelacion[] | null
    );
    const clienteNombre = clienteRel?.nombre || 'Cliente';
    const clienteTelefono = clienteRel?.telefono || '';

    let saldoFinal = Number(data.saldo_pendiente) || 0;
    let movimientoRegistrado = false;
    const montoCobradoNum = Number(monto_cobrado) || 0;

    if (montoCobradoNum > 0 && usuario_id) {
      const saldoPrevio = Number(data.saldo_pendiente) || 0;
      const saldoEsperado = Math.max(0, Number((saldoPrevio - montoCobradoNum).toFixed(2)));

      const movsPrevios = await MovimientosService.listarMovimientos(org_id, { pedido_id: id, limit: 5 });
      const now = new Date();
      const fechaISO = now.toISOString().slice(0, 10);
      const fechaCorta = now.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' });
      const detalle = data.descripcion ? `(${data.descripcion})` : `(Folio: ${data.folio})`;
      const baseNota = movsPrevios.length > 0 && movsPrevios[0].nota ? movsPrevios[0].nota : `Pedido ${clienteNombre} ${detalle}`;
      const etiqueta = saldoEsperado === 0 ? 'Liquidacion' : 'Abono';
      const notaFinal = `${baseNota} | ${etiqueta}: $${montoCobradoNum.toFixed(2)} (${fechaCorta})`;

      const categoriaPrevia =
        (movsPrevios as Array<{ categoria_id?: string | null }>).find((m) => Boolean(m.categoria_id))?.categoria_id ??
        null;
      const categoriaId = await this.resolverCategoriaIngresoDefault(org_id, categoria_ingreso_id, categoriaPrevia);
      await MovimientosService.crearMovimiento(org_id, usuario_id, {
        tipo: 'ingreso',
        monto: montoCobradoNum,
        categoria_id: categoriaId,
        sucursal_id: data.sucursal_id || null,
        pedido_id: id,
        fecha: fechaISO,
        metodo_pago: metodo_pago || 'efectivo',
        nota: notaFinal,
      });
      movimientoRegistrado = true;

      const { data: pedidoReconciliado } = await supabaseAdmin
        .from('pedidos')
        .select('saldo_pendiente')
        .eq('id', id)
        .eq('org_id', org_id)
        .maybeSingle();

      const saldoReconciliado = Number(pedidoReconciliado?.saldo_pendiente ?? saldoEsperado);
      // Preservar reduccion exacta en pedidos historicos cuyo anticipo inicial no tuvo movimiento asociado
      if (saldoReconciliado > saldoEsperado) {
        await supabaseAdmin
          .from('pedidos')
          .update({ saldo_pendiente: saldoEsperado })
          .eq('id', id)
          .eq('org_id', org_id);
        saldoFinal = saldoEsperado;
      } else {
        saldoFinal = saldoReconciliado;
      }
    }

    const waConfigurado = WhatsappService.isConfigured();
    let whatsappDisparado = false;
    const cambioAListo = nuevoEstado === 'listo' && estadoAnterior !== 'listo';
    const cambioAEntregado =
      nuevoEstado === 'entregado' && estadoAnterior !== 'entregado' && process.env.WHATSAPP_NOTIFY_DELIVERED === 'true';

    if (
      !omitir_whatsapp &&
      waConfigurado &&
      (cambioAListo || cambioAEntregado) &&
      clienteTelefono &&
      clienteRel?.permite_whatsapp !== false
    ) {
      whatsappDisparado = true;
      void WhatsappService.notificarPedido({
        orgId: org_id,
        folio: data.folio,
        estado: nuevoEstado as EventoWhatsappPedido,
        clienteNombre,
        clienteTelefono,
        permiteWhatsapp: clienteRel?.permite_whatsapp,
        montoTotal: Number(data.monto_total) || 0,
        saldoPendiente: saldoFinal,
      });
    }

    return {
      ...data,
      saldo_pendiente: saldoFinal,
      cliente_nombre: clienteRel?.nombre || 'Cliente Manual',
      cliente_telefono: clienteTelefono,
      movimiento_registrado: movimientoRegistrado,
      whatsapp_automatico: waConfigurado,
      whatsapp_disparado: whatsappDisparado,
    };
  }

  static async enviarNotificacionManual(id: string, org_id: string) {
    const { data: ped, error } = await supabaseAdmin
      .from('pedidos')
      .select('folio, estado, monto_total, saldo_pendiente, clientes(nombre, telefono, permite_whatsapp)')
      .eq('id', id)
      .eq('org_id', org_id)
      .single();

    if (error || !ped) throw new Error('Pedido no encontrado o sin acceso');

    const cli = normalizarRelacionCliente(ped.clientes as ClienteRelacion | ClienteRelacion[] | null);
    if (!cli?.telefono) {
      const err: Error & { status?: number } = new Error('El cliente no tiene un número de teléfono registrado');
      err.status = 400;
      throw err;
    }

    const evento: EventoWhatsappPedido =
      ped.estado === 'listo' ? 'listo' : ped.estado === 'entregado' ? 'entregado' : 'recibido';

    const mensaje = WhatsappService.construirMensaje({
      orgId: org_id,
      folio: ped.folio,
      estado: evento,
      clienteNombre: cli.nombre || 'Cliente',
      clienteTelefono: cli.telefono,
      permiteWhatsapp: cli.permite_whatsapp,
      montoTotal: Number(ped.monto_total) || 0,
      saldoPendiente: Number(ped.saldo_pendiente) || 0,
    });

    const resultado = await WhatsappService.enviarTexto(cli.telefono, mensaje, {
      orgId: org_id,
      folio: ped.folio,
      evento,
    });

    return {
      ok: resultado.enviado,
      proveedor: resultado.proveedor,
      motivo: resultado.motivo,
    };
  }

  static async subirEvidencia(id: string, org_id: string, fileBuffer: Buffer, tipo: string, nota: string) {
    const { data: ped } = await supabaseAdmin.from('pedidos').select('id').eq('id', id).eq('org_id', org_id).single();
    if (!ped) throw new Error('Pedido no encontrado o sin acceso');
    const compressedBuffer = await sharp(fileBuffer)
      .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    const fileName = `${id}/${Date.now()}.webp`;

    const { error: uploadError } = await supabaseAdmin.storage.from('evidencias').upload(fileName, compressedBuffer, {
      contentType: 'image/webp',
      upsert: false,
    });

    if (uploadError) throw uploadError;

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from('evidencias').getPublicUrl(fileName);

    const { data: dbData, error: dbError } = await supabaseAdmin
      .from('pedido_evidencias')
      .insert({
        pedido_id: id,
        url: publicUrl,
        tipo: tipo || 'ingreso',
        nota: nota || '',
      })
      .select()
      .single();

    if (dbError) throw dbError;
    return dbData;
  }

  static async obtenerEvidencias(id: string, org_id: string) {
    const { data: ped } = await supabaseAdmin.from('pedidos').select('id').eq('id', id).eq('org_id', org_id).single();
    if (!ped) return [];

    const { data, error } = await supabaseAdmin
      .from('pedido_evidencias')
      .select('*')
      .eq('pedido_id', id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data;
  }

  static async eliminarPedido(id: string, org_id: string) {
    const { data: currentPedido } = await supabaseAdmin
      .from('pedidos')
      .select('cliente_id, promo_canjeada, descuento_aplicado, puntos_generados, estado')
      .eq('id', id)
      .eq('org_id', org_id)
      .single();
    if (!currentPedido) throw new Error('Pedido no encontrado o sin acceso');

    if (currentPedido.puntos_generados && currentPedido.cliente_id) {
      await LealtadService.revertirCashbackEntrega(org_id, currentPedido.cliente_id);
    }

    if (currentPedido.promo_canjeada && currentPedido.descuento_aplicado > 0 && currentPedido.cliente_id) {
      await LealtadService.devolverAlMonedero(org_id, currentPedido.cliente_id, Number(currentPedido.descuento_aplicado));
    }

    await supabaseAdmin.from('movimientos').delete().eq('pedido_id', id).eq('org_id', org_id);

    const { error } = await supabaseAdmin.from('pedidos').delete().eq('id', id).eq('org_id', org_id);
    if (error) throw error;
  }

  static async eliminarEvidencia(pedidoId: string, org_id: string, evidenciaId: string) {
    const { data: ped } = await supabaseAdmin
      .from('pedidos')
      .select('id')
      .eq('id', pedidoId)
      .eq('org_id', org_id)
      .single();
    if (!ped) throw new Error('Pedido no encontrado o sin acceso');
    const { data: evidencia, error: findError } = await supabaseAdmin
      .from('pedido_evidencias')
      .select('url')
      .eq('id', evidenciaId)
      .eq('pedido_id', pedidoId)
      .single();

    if (findError || !evidencia) {
      const err: Error & { status?: number } = new Error('Evidencia no encontrada');
      err.status = 404;
      throw err;
    }

    try {
      const urlParts = evidencia.url.split('/evidencias/');
      if (urlParts.length > 1) {
        const path = urlParts[1];
        await supabaseAdmin.storage.from('evidencias').remove([path]);
      }
    } catch (err: unknown) {
      console.warn('Advertencia: No se pudo borrar el archivo fisico de Storage:', err);
    }

    const { error: deleteError } = await supabaseAdmin.from('pedido_evidencias').delete().eq('id', evidenciaId);
    if (deleteError) throw deleteError;
  }
}

export async function listarPedidosPaginados(
  orgId: string,
  params: ListarPedidosPaginadosParams = {}
): Promise<PedidosPaginadosResponse> {
  return PedidosService.listarPedidosPaginados(orgId, params);
}
