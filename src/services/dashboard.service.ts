import { supabaseAdmin } from '../lib/supabase';

export const SUPABASE_BATCH_SIZE = 1000;

const FECHA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_INCLUDE = 'mes,recientes';
const DEFAULT_LIMIT_RECIENTES = 5;
const MIN_LIMIT_RECIENTES = 1;
const MAX_LIMIT_RECIENTES = 50;
const SIN_CATEGORIA_KEY = 'sin_cat';
const SIN_SUCURSAL_KEY = 'sin_suc';

export type TipoMovimiento = 'ingreso' | 'egreso';

export interface DashboardQueryInput {
  desde?: unknown;
  hasta?: unknown;
  include?: unknown;
  limit_recientes?: unknown;
  sucursal_id?: unknown;
}

export interface DashboardOptionsNormalizadas {
  desde: string;
  hasta: string;
  incluirMes: boolean;
  incluirRecientes: boolean;
  limitRecientes: number;
  sucursalId?: string;
}

export interface CatalogoNombreRow {
  id: string;
  nombre: string;
}

export interface MovimientoRangoRow {
  tipo: TipoMovimiento;
  monto: number | string | null;
  categoria_id: string | null;
  sucursal_id: string | null;
  fecha: string;
}

export interface MovimientoMesRow {
  tipo: TipoMovimiento;
  monto: number | string | null;
  categoria_id: string | null;
  sucursal_id: string | null;
}

export interface MovimientoRecienteRow {
  id: string;
  tipo: TipoMovimiento;
  monto: number | string | null;
  categoria_id: string | null;
  sucursal_id: string | null;
  metodo_pago: string | null;
  nota: string | null;
  pedido_id: string | null;
  fecha: string;
  created_at: string | null;
}

export interface PedidoFolioRow {
  id: string;
  folio: string | null;
}

export interface DashboardRange {
  desde: string;
  hasta: string;
  dias: number;
}

export interface DashboardTotales {
  ingresos: number;
  egresos: number;
  balance: number;
}

export interface DashboardDia {
  fecha: string;
  ingresos: number;
  egresos: number;
  balance: number;
}

export interface DashboardCategoriaTotal {
  categoria_id: string | null;
  nombre: string;
  total: number;
}

export interface DashboardPorCategoria {
  ingreso: DashboardCategoriaTotal[];
  egreso: DashboardCategoriaTotal[];
}

export interface DashboardSucursalMes {
  sucursal_id: string | null;
  nombre: string;
  ingresos: number;
  egresos: number;
  balance: number;
}

export interface DashboardRecienteItem {
  id: string;
  tipo: TipoMovimiento;
  categoria: string;
  sucursal_id: string | null;
  sucursal_nombre: string;
  metodo_pago: string | null;
  nota: string | null;
  pedido_id: string | null;
  pedido_folio: string | null;
  fecha: string;
  created_at: string | null;
  monto: number;
}

export interface DashboardMeta {
  items: number;
}

export interface DashboardResponse {
  range: DashboardRange;
  totales: DashboardTotales;
  por_dia: DashboardDia[];
  por_categoria: DashboardPorCategoria;
  kpis_mes?: DashboardTotales;
  por_categoria_mes?: DashboardPorCategoria;
  por_sucursal_mes?: DashboardSucursalMes[];
  recientes?: DashboardRecienteItem[];
  meta: DashboardMeta;
}

export class DashboardValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'DashboardValidationError';
    this.status = status;
  }
}

export function redondearDosDecimales(valor: number): number {
  const redondeado = Math.round(valor * 100) / 100;
  return redondeado === 0 ? 0 : redondeado;
}

export function formatearFechaLocalISO(fecha: Date): string {
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const dia = String(fecha.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
}

export function obtenerHoyLocalISO(referencia: Date = new Date()): string {
  return formatearFechaLocalISO(referencia);
}

export function obtenerPrimerDiaMesLocalISO(referencia: Date = new Date()): string {
  const anio = referencia.getFullYear();
  const mes = String(referencia.getMonth() + 1).padStart(2, '0');
  return `${anio}-${mes}-01`;
}

export function obtenerDesdePorDefectoISO(diasAtras = 29, referencia: Date = new Date()): string {
  const fecha = new Date(
    referencia.getFullYear(),
    referencia.getMonth(),
    referencia.getDate() - diasAtras
  );
  return formatearFechaLocalISO(fecha);
}

export function esFechaISOValida(valor: string): boolean {
  if (!FECHA_ISO_RE.test(valor)) return false;
  const [anio, mes, dia] = valor.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  return (
    fecha.getUTCFullYear() === anio &&
    fecha.getUTCMonth() === mes - 1 &&
    fecha.getUTCDate() === dia
  );
}

export function listarDiasInclusivos(desdeISO: string, hastaISO: string): string[] {
  const [anioInicio, mesInicio, diaInicio] = desdeISO.split('-').map(Number);
  const [anioFin, mesFin, diaFin] = hastaISO.split('-').map(Number);

  // Uso de Date.UTC exclusivamente para avanzar dias calendario sin desfases por DST o zona local.
  const cursor = new Date(Date.UTC(anioInicio, mesInicio - 1, diaInicio));
  const limite = new Date(Date.UTC(anioFin, mesFin - 1, diaFin));
  const dias: string[] = [];

  while (cursor.getTime() <= limite.getTime()) {
    const anio = cursor.getUTCFullYear();
    const mes = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(cursor.getUTCDate()).padStart(2, '0');
    dias.push(`${anio}-${mes}-${dia}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dias;
}

function extraerTextoQuery(valor: unknown): string | undefined {
  if (typeof valor === 'string') {
    const limpio = valor.trim();
    return limpio.length > 0 ? limpio : undefined;
  }
  if (Array.isArray(valor) && typeof valor[0] === 'string') {
    const limpio = valor[0].trim();
    return limpio.length > 0 ? limpio : undefined;
  }
  return undefined;
}

function extraerIncludeRaw(valor: unknown): string | undefined {
  if (typeof valor === 'string') {
    const limpio = valor.trim();
    return limpio.length > 0 ? limpio : undefined;
  }
  if (Array.isArray(valor)) {
    const partes = valor
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    return partes.length > 0 ? partes.join(',') : undefined;
  }
  return undefined;
}

export function normalizarLimitRecientes(valor: unknown): number {
  const candidato = Array.isArray(valor) ? valor[0] : valor;
  if (candidato === undefined || candidato === null) return DEFAULT_LIMIT_RECIENTES;
  if (typeof candidato === 'string' && candidato.trim() === '') return DEFAULT_LIMIT_RECIENTES;

  const parsed = Number(candidato);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT_RECIENTES;

  return Math.max(MIN_LIMIT_RECIENTES, Math.min(MAX_LIMIT_RECIENTES, Math.floor(parsed)));
}

export function normalizarOpcionesDashboard(
  input: DashboardQueryInput = {},
  referencia: Date = new Date()
): DashboardOptionsNormalizadas {
  const desdeRaw = extraerTextoQuery(input.desde);
  const hastaRaw = extraerTextoQuery(input.hasta);
  const sucursalRaw = extraerTextoQuery(input.sucursal_id);

  if (desdeRaw !== undefined && !esFechaISOValida(desdeRaw)) {
    throw new DashboardValidationError('Fecha desde inválida: use formato YYYY-MM-DD', 400);
  }
  if (hastaRaw !== undefined && !esFechaISOValida(hastaRaw)) {
    throw new DashboardValidationError('Fecha hasta inválida: use formato YYYY-MM-DD', 400);
  }
  if (sucursalRaw !== undefined && !UUID_RE.test(sucursalRaw)) {
    throw new DashboardValidationError('El parámetro sucursal_id debe ser un UUID válido', 400);
  }

  const desde = desdeRaw ?? obtenerDesdePorDefectoISO(29, referencia);
  const hasta = hastaRaw ?? obtenerHoyLocalISO(referencia);

  if (desde > hasta) {
    throw new DashboardValidationError('rango inválido: desde > hasta', 400);
  }

  const includeRaw = extraerIncludeRaw(input.include) ?? DEFAULT_INCLUDE;
  const tokens = includeRaw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  return {
    desde,
    hasta,
    incluirMes: tokens.includes('mes'),
    incluirRecientes: tokens.includes('recientes'),
    limitRecientes: normalizarLimitRecientes(input.limit_recientes),
    sucursalId: sucursalRaw,
  };
}

function normalizarMonto(monto: number | string | null | undefined): number {
  const num = Number(monto);
  return Number.isFinite(num) ? Math.abs(num) : 0;
}

function formatearCategorias(
  acumulado: Map<string, number>,
  catMap: Map<string, string>
): DashboardCategoriaTotal[] {
  return Array.from(acumulado.entries())
    .map(([id, total]) => ({
      categoria_id: id === SIN_CATEGORIA_KEY ? null : id,
      nombre: id === SIN_CATEGORIA_KEY ? 'Sin categoría' : (catMap.get(id) || 'Sin categoría'),
      total: redondearDosDecimales(total),
    }))
    .sort((a, b) => b.total - a.total);
}

export class DashboardService {
  private static async obtenerMovimientosRangoEnLotes(
    orgId: string,
    desde: string,
    hasta: string,
    sucursalId?: string
  ): Promise<MovimientoRangoRow[]> {
    const acumulado: MovimientoRangoRow[] = [];
    let inicio = 0;

    // PostgREST limita cada consulta individual a 1000 filas; iteramos por lotes ordenados por id.
    while (true) {
      let consulta = supabaseAdmin
        .from('movimientos')
        .select('tipo, monto, categoria_id, sucursal_id, fecha')
        .eq('org_id', orgId)
        .gte('fecha', desde)
        .lte('fecha', hasta);

      if (sucursalId !== undefined) {
        consulta = consulta.eq('sucursal_id', sucursalId);
      }

      const { data, error } = await consulta
        .order('id', { ascending: true })
        .range(inicio, inicio + SUPABASE_BATCH_SIZE - 1);

      if (error) throw error;

      const lote = (data ?? []) as MovimientoRangoRow[];
      acumulado.push(...lote);

      if (lote.length < SUPABASE_BATCH_SIZE) {
        break;
      }
      inicio += SUPABASE_BATCH_SIZE;
    }

    return acumulado;
  }

  private static async obtenerMovimientosMesEnLotes(
    orgId: string,
    mesDesde: string,
    mesHasta: string,
    sucursalId?: string
  ): Promise<MovimientoMesRow[]> {
    const acumulado: MovimientoMesRow[] = [];
    let inicio = 0;

    while (true) {
      let consulta = supabaseAdmin
        .from('movimientos')
        .select('tipo, monto, categoria_id, sucursal_id')
        .eq('org_id', orgId)
        .gte('fecha', mesDesde)
        .lte('fecha', mesHasta);

      if (sucursalId !== undefined) {
        consulta = consulta.eq('sucursal_id', sucursalId);
      }

      const { data, error } = await consulta
        .order('id', { ascending: true })
        .range(inicio, inicio + SUPABASE_BATCH_SIZE - 1);

      if (error) throw error;

      const lote = (data ?? []) as MovimientoMesRow[];
      acumulado.push(...lote);

      if (lote.length < SUPABASE_BATCH_SIZE) {
        break;
      }
      inicio += SUPABASE_BATCH_SIZE;
    }

    return acumulado;
  }

  private static async obtenerRecientes(
    orgId: string,
    limitRecientes: number,
    sucursalId?: string
  ): Promise<MovimientoRecienteRow[]> {
    let consulta = supabaseAdmin
      .from('movimientos')
      .select('id, tipo, monto, categoria_id, sucursal_id, metodo_pago, nota, pedido_id, fecha, created_at')
      .eq('org_id', orgId);

    if (sucursalId !== undefined) {
      consulta = consulta.eq('sucursal_id', sucursalId);
    }

    const { data, error } = await consulta
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limitRecientes);

    if (error) throw error;

    return (data ?? []) as MovimientoRecienteRow[];
  }

  private static async obtenerFoliosPedidos(
    orgId: string,
    pedidoIds: string[]
  ): Promise<Map<string, string | null>> {
    const folioMap = new Map<string, string | null>();
    if (pedidoIds.length === 0) return folioMap;

    // Consulta batch separada para evitar joins PostgREST y consultas N+1.
    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .select('id, folio')
      .eq('org_id', orgId)
      .in('id', pedidoIds);

    if (error) throw error;

    for (const pedido of (data ?? []) as PedidoFolioRow[]) {
      folioMap.set(pedido.id, pedido.folio ?? null);
    }

    return folioMap;
  }

  static async obtenerDashboard(
    orgId: string,
    query: DashboardQueryInput = {},
    referencia: Date = new Date()
  ): Promise<DashboardResponse> {
    if (!orgId || !orgId.trim()) {
      throw new DashboardValidationError('org_id es requerido', 400);
    }

    const opciones = normalizarOpcionesDashboard(query, referencia);
    const { desde, hasta, incluirMes, incluirRecientes, limitRecientes, sucursalId } = opciones;

    const mesDesde = obtenerPrimerDiaMesLocalISO(referencia);
    const mesHasta = obtenerHoyLocalISO(referencia);

    let catsRows: CatalogoNombreRow[];
    let sucsRows: CatalogoNombreRow[];
    let movsRange: MovimientoRangoRow[];
    let movsMes: MovimientoMesRow[];
    let recientesRows: MovimientoRecienteRow[];

    if (sucursalId === undefined) {
      const pCats = supabaseAdmin
        .from('categorias')
        .select('id, nombre')
        .eq('org_id', orgId);

      const pSucs = supabaseAdmin
        .from('sucursales')
        .select('id, nombre')
        .eq('org_id', orgId);

      const pMovsRange = this.obtenerMovimientosRangoEnLotes(orgId, desde, hasta);
      const pMovsMes = incluirMes
        ? this.obtenerMovimientosMesEnLotes(orgId, mesDesde, mesHasta)
        : Promise.resolve<MovimientoMesRow[]>([]);
      const pRecientes = incluirRecientes
        ? this.obtenerRecientes(orgId, limitRecientes)
        : Promise.resolve<MovimientoRecienteRow[]>([]);

      const [resCats, resSucs, rangeRows, mesRows, recRows] = await Promise.all([
        pCats,
        pSucs,
        pMovsRange,
        pMovsMes,
        pRecientes,
      ]);

      if (resCats.error) throw resCats.error;
      if (resSucs.error) throw resSucs.error;

      catsRows = (resCats.data ?? []) as CatalogoNombreRow[];
      sucsRows = (resSucs.data ?? []) as CatalogoNombreRow[];
      movsRange = rangeRows;
      movsMes = mesRows;
      recientesRows = recRows;
    } else {
      const resSucs = await supabaseAdmin
        .from('sucursales')
        .select('id, nombre')
        .eq('org_id', orgId);

      if (resSucs.error) throw resSucs.error;

      sucsRows = (resSucs.data ?? []) as CatalogoNombreRow[];
      const sucursalEncontrada = sucsRows.find(
        (suc) => suc.id.toLowerCase() === sucursalId.toLowerCase()
      );
      if (!sucursalEncontrada) {
        throw new DashboardValidationError('Sucursal no encontrada', 404);
      }

      const sucursalCanonico = sucursalEncontrada.id;

      const pCats = supabaseAdmin
        .from('categorias')
        .select('id, nombre')
        .eq('org_id', orgId);
      const pMovsRange = this.obtenerMovimientosRangoEnLotes(orgId, desde, hasta, sucursalCanonico);
      const pMovsMes = incluirMes
        ? this.obtenerMovimientosMesEnLotes(orgId, mesDesde, mesHasta, sucursalCanonico)
        : Promise.resolve<MovimientoMesRow[]>([]);
      const pRecientes = incluirRecientes
        ? this.obtenerRecientes(orgId, limitRecientes, sucursalCanonico)
        : Promise.resolve<MovimientoRecienteRow[]>([]);

      const [resCats, rangeRows, mesRows, recRows] = await Promise.all([
        pCats,
        pMovsRange,
        pMovsMes,
        pRecientes,
      ]);

      if (resCats.error) throw resCats.error;

      catsRows = (resCats.data ?? []) as CatalogoNombreRow[];
      movsRange = rangeRows;
      movsMes = mesRows;
      recientesRows = recRows;
    }

    const catMap = new Map<string, string>();
    for (const cat of catsRows) {
      catMap.set(cat.id, cat.nombre);
    }

    const sucMap = new Map<string, string>();
    for (const suc of sucsRows) {
      sucMap.set(suc.id, suc.nombre);
    }

    let ingresos = 0;
    let egresos = 0;
    const byDay = new Map<string, { ingresos: number; egresos: number }>();
    const byCatIngreso = new Map<string, number>();
    const byCatEgreso = new Map<string, number>();

    for (const mov of movsRange) {
      const val = normalizarMonto(mov.monto);
      const esIngreso = mov.tipo === 'ingreso';
      const esEgreso = mov.tipo === 'egreso';
      if (!esIngreso && !esEgreso) continue;

      if (esIngreso) {
        ingresos += val;
      } else {
        egresos += val;
      }

      const dia = typeof mov.fecha === 'string' ? mov.fecha.slice(0, 10) : '';
      if (dia) {
        const nodoDia = byDay.get(dia) ?? { ingresos: 0, egresos: 0 };
        if (esIngreso) {
          nodoDia.ingresos += val;
        } else {
          nodoDia.egresos += val;
        }
        byDay.set(dia, nodoDia);
      }

      const catKey = mov.categoria_id || SIN_CATEGORIA_KEY;
      const targetMap = esIngreso ? byCatIngreso : byCatEgreso;
      targetMap.set(catKey, (targetMap.get(catKey) ?? 0) + val);
    }

    const ingresosTotales = redondearDosDecimales(ingresos);
    const egresosTotales = redondearDosDecimales(egresos);
    const balanceTotales = redondearDosDecimales(ingresosTotales - egresosTotales);

    const days = listarDiasInclusivos(desde, hasta);
    const porDia: DashboardDia[] = days.map((dia) => {
      const nodo = byDay.get(dia);
      const ingDia = redondearDosDecimales(nodo?.ingresos ?? 0);
      const egrDia = redondearDosDecimales(nodo?.egresos ?? 0);
      return {
        fecha: dia,
        ingresos: ingDia,
        egresos: egrDia,
        balance: redondearDosDecimales(ingDia - egrDia),
      };
    });

    const response: DashboardResponse = {
      range: { desde, hasta, dias: days.length },
      totales: {
        ingresos: ingresosTotales,
        egresos: egresosTotales,
        balance: balanceTotales,
      },
      por_dia: porDia,
      por_categoria: {
        ingreso: formatearCategorias(byCatIngreso, catMap),
        egreso: formatearCategorias(byCatEgreso, catMap),
      },
      meta: { items: movsRange.length },
    };

    if (incluirMes) {
      let ingMes = 0;
      let egrMes = 0;
      const catIngMes = new Map<string, number>();
      const catEgrMes = new Map<string, number>();
      const sucMes = new Map<string, { ingresos: number; egresos: number }>();

      for (const mov of movsMes) {
        const val = normalizarMonto(mov.monto);
        const esIngreso = mov.tipo === 'ingreso';
        const esEgreso = mov.tipo === 'egreso';
        if (!esIngreso && !esEgreso) continue;

        if (esIngreso) {
          ingMes += val;
        } else {
          egrMes += val;
        }

        const catKey = mov.categoria_id || SIN_CATEGORIA_KEY;
        const catMapTarget = esIngreso ? catIngMes : catEgrMes;
        catMapTarget.set(catKey, (catMapTarget.get(catKey) ?? 0) + val);

        const sucKey = mov.sucursal_id || SIN_SUCURSAL_KEY;
        const sucNodo = sucMes.get(sucKey) ?? { ingresos: 0, egresos: 0 };
        if (esIngreso) {
          sucNodo.ingresos += val;
        } else {
          sucNodo.egresos += val;
        }
        sucMes.set(sucKey, sucNodo);
      }

      const ingMesRedondeado = redondearDosDecimales(ingMes);
      const egrMesRedondeado = redondearDosDecimales(egrMes);

      response.kpis_mes = {
        ingresos: ingMesRedondeado,
        egresos: egrMesRedondeado,
        balance: redondearDosDecimales(ingMesRedondeado - egrMesRedondeado),
      };

      response.por_categoria_mes = {
        ingreso: formatearCategorias(catIngMes, catMap),
        egreso: formatearCategorias(catEgrMes, catMap),
      };

      response.por_sucursal_mes = Array.from(sucMes.entries())
        .map(([id, valores]) => {
          const sucIng = redondearDosDecimales(valores.ingresos);
          const sucEgr = redondearDosDecimales(valores.egresos);
          return {
            sucursal_id: id === SIN_SUCURSAL_KEY ? null : id,
            nombre: id === SIN_SUCURSAL_KEY ? 'Sin sucursal' : (sucMap.get(id) || 'Sin sucursal'),
            ingresos: sucIng,
            egresos: sucEgr,
            balance: redondearDosDecimales(sucIng - sucEgr),
          };
        })
        .sort((a, b) => (b.ingresos + b.egresos) - (a.ingresos + a.egresos));
    }

    if (incluirRecientes) {
      const pedidoIds = Array.from(
        new Set(
          recientesRows
            .map((mov) => mov.pedido_id)
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        )
      );

      const pedidoMap = await this.obtenerFoliosPedidos(orgId, pedidoIds);

      response.recientes = recientesRows.map((mov) => {
        const montoAbs = redondearDosDecimales(normalizarMonto(mov.monto));
        const monto = mov.tipo === 'egreso' ? (montoAbs === 0 ? 0 : -montoAbs) : montoAbs;
        const createdAtRaw = typeof mov.created_at === 'string' ? mov.created_at.trim() : '';
        const createdAt = createdAtRaw.length > 0 ? createdAtRaw : null;
        const fechaFallback = `${String(mov.fecha ?? '').slice(0, 10)}T00:00:00`;
        const pedidoId = mov.pedido_id ?? null;

        return {
          id: mov.id,
          tipo: mov.tipo,
          categoria: mov.categoria_id ? (catMap.get(mov.categoria_id) || 'Sin categoría') : 'Sin categoría',
          sucursal_id: mov.sucursal_id ?? null,
          sucursal_nombre: mov.sucursal_id ? (sucMap.get(mov.sucursal_id) || 'Sin sucursal') : 'Sin sucursal',
          metodo_pago: mov.metodo_pago ?? null,
          nota: mov.nota ?? null,
          pedido_id: pedidoId,
          pedido_folio: pedidoId ? (pedidoMap.get(pedidoId) ?? null) : null,
          fecha: createdAt ?? fechaFallback,
          created_at: createdAt,
          monto,
        };
      });
    }

    return response;
  }
}

export async function obtenerDashboard(
  orgId: string,
  query: DashboardQueryInput = {},
  referencia: Date = new Date()
): Promise<DashboardResponse> {
  return DashboardService.obtenerDashboard(orgId, query, referencia);
}
