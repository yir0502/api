import { supabaseAdmin } from '../lib/supabase';

export interface MovimientosFilter {
  desde?: unknown;
  hasta?: unknown;
  tipo?: unknown;
  categoria_id?: unknown;
  metodo_pago?: unknown;
  sucursal_id?: unknown;
  q?: unknown;
  limit?: unknown;
  offset?: unknown;
  pedido_id?: unknown;
  paginated?: unknown;
}

export interface MovimientoRelacionesInput {
  sucursal_id?: string | null;
  categoria_id?: string | null;
  pedido_id?: string | null;
}

export interface MovimientoInput extends MovimientoRelacionesInput {
  tipo?: 'ingreso' | 'egreso';
  monto?: number;
  fecha?: string;
  metodo_pago?: string | null;
  nota?: string | null;
}

export interface RelacionNombre {
  id?: string;
  nombre?: string | null;
}

export interface MovimientoDbRow {
  id: string;
  org_id: string;
  tipo: 'ingreso' | 'egreso';
  monto: number;
  categoria_id?: string | null;
  sucursal_id?: string | null;
  pedido_id?: string | null;
  fecha?: string | null;
  metodo_pago?: string | null;
  nota?: string | null;
  created_at?: string | null;
  categorias?: RelacionNombre | RelacionNombre[] | null;
  sucursales?: RelacionNombre | RelacionNombre[] | null;
}

export interface MovimientosTotales {
  ingresos: number;
  egresos: number;
  balance: number;
  total_movimientos: number;
  ingresos_count: number;
  egresos_count: number;
}

const SUPABASE_BATCH_SIZE = 1000;

interface FilterableQuery<T> {
  eq(column: string, value: string): T;
  gte(column: string, value: string): T;
  lte(column: string, value: string): T;
}

export type MovimientoListadoRow = Omit<MovimientoDbRow, 'categorias' | 'sucursales'> & {
  categoria_nombre: string;
  sucursal_nombre: string;
  categorias?: undefined;
  sucursales?: undefined;
};

export interface MovimientosPaginadosResult {
  data: MovimientoListadoRow[];
  count: number;
  totales: MovimientosTotales;
}

function extraerNombreRelacion(rel: RelacionNombre | RelacionNombre[] | null | undefined): string | null {
  if (!rel) return null;
  const item = Array.isArray(rel) ? rel[0] : rel;
  return item?.nombre ?? null;
}

function crearErrorHttp(mensaje: string, status: number): Error & { status: number } {
  return Object.assign(new Error(mensaje), { status });
}

function redondearDosDecimales(valor: number): number {
  return Math.round(valor * 100) / 100;
}

export function normalizarPaginacion(limitRaw: unknown, offsetRaw: unknown): { limit: number; offset: number } {
  const parsedLimit = limitRaw !== undefined ? Number(limitRaw) : NaN;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.max(1, Math.min(Math.floor(parsedLimit), 100))
      : 20;

  const parsedOffset = offsetRaw !== undefined ? Number(offsetRaw) : NaN;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, Math.floor(parsedOffset)) : 0;

  return { limit, offset };
}

function normalizarMovimiento(row: MovimientoDbRow): MovimientoListadoRow {
  return {
    ...row,
    categoria_nombre: extraerNombreRelacion(row.categorias) || 'Sin categoría',
    sucursal_nombre: extraerNombreRelacion(row.sucursales) || 'Sin sucursal',
    categorias: undefined,
    sucursales: undefined,
  };
}

export function normalizarYFiltrarMovimientos(rows: MovimientoDbRow[], q?: unknown): MovimientoListadoRow[] {
  let result = rows.map(normalizarMovimiento);

  const needle = q ? String(q).trim().toLowerCase() : '';
  if (needle) {
    result = result.filter((m) => {
      const nota = (m.nota || '').toLowerCase();
      const metodo = (m.metodo_pago || '').toLowerCase();
      const cat = (m.categoria_nombre || '').toLowerCase();
      const suc = (m.sucursal_nombre || '').toLowerCase();
      return nota.includes(needle) || metodo.includes(needle) || cat.includes(needle) || suc.includes(needle);
    });
  }

  return result;
}

export function calcularTotalesMovimientos(
  rows: ReadonlyArray<{ tipo: 'ingreso' | 'egreso'; monto: number }>
): MovimientosTotales {
  let ingresos = 0;
  let egresos = 0;
  let ingresosCount = 0;
  let egresosCount = 0;

  for (const row of rows) {
    if (row.tipo === 'ingreso') {
      ingresosCount += 1;
    } else if (row.tipo === 'egreso') {
      egresosCount += 1;
    }

    const monto = Number(row.monto);
    if (!Number.isFinite(monto)) continue;
    if (row.tipo === 'ingreso') {
      ingresos += monto;
    } else if (row.tipo === 'egreso') {
      egresos += monto;
    }
  }

  const ingresosRedondeado = redondearDosDecimales(ingresos);
  const egresosRedondeado = redondearDosDecimales(egresos);
  const balanceRedondeado = redondearDosDecimales(ingresosRedondeado - egresosRedondeado);

  return {
    ingresos: ingresosRedondeado,
    egresos: egresosRedondeado,
    balance: balanceRedondeado,
    total_movimientos: rows.length,
    ingresos_count: ingresosCount,
    egresos_count: egresosCount,
  };
}

export class MovimientosService {
  static async reconciliarPedido(pedido_id: string, org_id: string) {
    if (!pedido_id) return;

    const { data: movs } = await supabaseAdmin
      .from('movimientos')
      .select('monto, tipo')
      .eq('pedido_id', pedido_id)
      .eq('org_id', org_id);

    if (!movs) return;

    const totalPagado = movs
      .filter((m) => m.tipo === 'ingreso')
      .reduce((sum, m) => sum + Number(m.monto), 0);
    const totalDevuelto = movs
      .filter((m) => m.tipo === 'egreso')
      .reduce((sum, m) => sum + Number(m.monto), 0);
    const abonoNeto = totalPagado - totalDevuelto;

    const { data: ped } = await supabaseAdmin
      .from('pedidos')
      .select('monto_total, descuento_aplicado')
      .eq('id', pedido_id)
      .eq('org_id', org_id)
      .maybeSingle();

    if (!ped) return;

    const descuento = Number(ped.descuento_aplicado) || 0;
    const nuevoSaldo = Math.max(0, Number(ped.monto_total) - descuento - abonoNeto);

    await supabaseAdmin
      .from('pedidos')
      .update({ saldo_pendiente: nuevoSaldo })
      .eq('id', pedido_id)
      .eq('org_id', org_id);
  }

  private static aplicarFiltrosComunes<T extends FilterableQuery<T>>(
    query: T,
    filters: MovimientosFilter,
    incluirTipo: boolean
  ): T {
    const { desde, hasta, tipo, categoria_id, metodo_pago, sucursal_id, pedido_id } = filters;

    let qmov = query;
    if (desde) qmov = qmov.gte('fecha', String(desde));
    if (hasta) qmov = qmov.lte('fecha', String(hasta));
    if (incluirTipo && tipo) qmov = qmov.eq('tipo', String(tipo));
    if (categoria_id) qmov = qmov.eq('categoria_id', String(categoria_id));
    if (metodo_pago) qmov = qmov.eq('metodo_pago', String(metodo_pago));
    if (sucursal_id) qmov = qmov.eq('sucursal_id', String(sucursal_id));
    if (pedido_id) qmov = qmov.eq('pedido_id', String(pedido_id));

    return qmov;
  }

  private static construirQueryBase(org_id: string, filters: MovimientosFilter) {
    const base = supabaseAdmin
      .from('movimientos')
      .select('*, categorias ( id, nombre ), sucursales ( id, nombre )')
      .eq('org_id', org_id);

    return this.aplicarFiltrosComunes(base, filters, true)
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
  }

  private static construirQueryResumen(org_id: string, filters: MovimientosFilter) {
    const base = supabaseAdmin
      .from('movimientos')
      .select('tipo, monto')
      .eq('org_id', org_id);

    return this.aplicarFiltrosComunes(base, filters, false).order('id', { ascending: true });
  }

  private static async obtenerResumenEnLotes(
    org_id: string,
    filtersSinTipo: MovimientosFilter
  ): Promise<MovimientosTotales> {
    const acumulado: Array<{ tipo: 'ingreso' | 'egreso'; monto: number }> = [];
    let inicio = 0;

    // PostgREST limita cada consulta individual a 1000 filas; iteramos en lotes para no truncar periodos largos.
    while (true) {
      const { data, error } = await this.construirQueryResumen(org_id, filtersSinTipo).range(
        inicio,
        inicio + SUPABASE_BATCH_SIZE - 1
      );
      if (error) throw error;

      const lote = (data || []) as Array<{ tipo: 'ingreso' | 'egreso'; monto: number }>;
      acumulado.push(...lote);

      if (lote.length < SUPABASE_BATCH_SIZE) {
        break;
      }
      inicio += SUPABASE_BATCH_SIZE;
    }

    return calcularTotalesMovimientos(acumulado);
  }

  private static async obtenerTodosEnLotes(
    org_id: string,
    filters: MovimientosFilter,
    startOffset = 0,
    maxRows?: number
  ): Promise<MovimientoDbRow[]> {
    const acumulado: MovimientoDbRow[] = [];
    let inicio = Math.max(0, startOffset);

    while (true) {
      const restante = maxRows !== undefined ? maxRows - acumulado.length : SUPABASE_BATCH_SIZE;
      if (restante <= 0) {
        break;
      }

      const batchLen = Math.min(SUPABASE_BATCH_SIZE, restante);
      const { data, error } = await this.construirQueryBase(org_id, filters).range(
        inicio,
        inicio + batchLen - 1
      );
      if (error) throw error;

      const lote = (data || []) as MovimientoDbRow[];
      acumulado.push(...lote);

      if (lote.length < batchLen) {
        break;
      }
      inicio += batchLen;
    }

    return acumulado;
  }

  static async listarMovimientos(org_id: string, filters: MovimientosFilter): Promise<MovimientoListadoRow[]> {
    const { q, limit, offset } = filters;
    const rawLim = limit !== undefined ? Number(limit) : undefined;
    const rawOff = offset !== undefined ? Number(offset) : undefined;
    const lim = rawLim !== undefined && Number.isFinite(rawLim) ? Math.min(Math.max(0, Math.floor(rawLim)), 2000) : undefined;
    const off = rawOff !== undefined && Number.isFinite(rawOff) ? Math.max(0, Math.floor(rawOff)) : undefined;

    if (lim !== undefined && lim > 0 && lim <= SUPABASE_BATCH_SIZE) {
      let qmov = this.construirQueryBase(org_id, filters);
      if (off !== undefined) qmov = qmov.range(off, off + lim - 1);
      else qmov = qmov.limit(lim);

      const { data: movs, error } = await qmov;
      if (error) throw error;

      return normalizarYFiltrarMovimientos((movs || []) as MovimientoDbRow[], q);
    }

    const movs = await this.obtenerTodosEnLotes(org_id, filters, off ?? 0, lim && lim > 0 ? lim : undefined);
    return normalizarYFiltrarMovimientos(movs, q);
  }

  static async listarMovimientosPaginados(
    org_id: string,
    filters: MovimientosFilter
  ): Promise<MovimientosPaginadosResult> {
    const { limit, offset } = normalizarPaginacion(filters.limit, filters.offset);
    const filtersSinTipo: MovimientosFilter = { ...filters, tipo: undefined };
    const needle = filters.q ? String(filters.q).trim() : '';
    const tipoFiltro = filters.tipo ? String(filters.tipo) : '';

    if (!needle) {
      const [pageRes, totales] = await Promise.all([
        this.construirQueryBase(org_id, filters).range(offset, offset + limit - 1),
        this.obtenerResumenEnLotes(org_id, filtersSinTipo),
      ]);
      if (pageRes.error) throw pageRes.error;

      const count =
        tipoFiltro === 'ingreso'
          ? totales.ingresos_count
          : tipoFiltro === 'egreso'
            ? totales.egresos_count
            : totales.total_movimientos;

      const data = normalizarYFiltrarMovimientos((pageRes.data || []) as MovimientoDbRow[]);
      return { data, count, totales };
    }

    const allRows = await this.obtenerTodosEnLotes(org_id, filtersSinTipo);
    const periodoFiltrado = normalizarYFiltrarMovimientos(allRows, filters.q);
    const totales = calcularTotalesMovimientos(periodoFiltrado);
    const listaFiltrada = tipoFiltro
      ? periodoFiltrado.filter((m) => m.tipo === tipoFiltro)
      : periodoFiltrado;
    const data = listaFiltrada.slice(offset, offset + limit);

    return { data, count: listaFiltrada.length, totales };
  }

  static async obtenerMovimiento(id: string, org_id: string): Promise<MovimientoListadoRow> {
    const { data, error } = await supabaseAdmin
      .from('movimientos')
      .select('*, categorias ( id, nombre ), sucursales ( id, nombre )')
      .eq('id', id)
      .eq('org_id', org_id)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      throw crearErrorHttp('Movimiento no encontrado', 404);
    }

    return normalizarMovimiento(data as MovimientoDbRow);
  }

  private static async validarRelaciones(org_id: string, payload: MovimientoRelacionesInput) {
    const validaciones: Promise<void>[] = [];

    if (payload.sucursal_id) {
      validaciones.push(
        (async () => {
          const { data: s } = await supabaseAdmin
            .from('sucursales')
            .select('id')
            .eq('id', payload.sucursal_id)
            .eq('org_id', org_id)
            .maybeSingle();
          if (!s) {
            throw crearErrorHttp('sucursal_id inválido', 400);
          }
        })()
      );
    }

    if (payload.categoria_id) {
      validaciones.push(
        (async () => {
          const { data: c } = await supabaseAdmin
            .from('categorias')
            .select('id')
            .eq('id', payload.categoria_id)
            .eq('org_id', org_id)
            .maybeSingle();
          if (!c) {
            throw crearErrorHttp('categoria_id inválido', 400);
          }
        })()
      );
    }

    if (payload.pedido_id) {
      validaciones.push(
        (async () => {
          const { data: p } = await supabaseAdmin
            .from('pedidos')
            .select('id')
            .eq('id', payload.pedido_id)
            .eq('org_id', org_id)
            .maybeSingle();
          if (!p) {
            throw crearErrorHttp('pedido_id inválido', 400);
          }
        })()
      );
    }

    if (validaciones.length > 0) {
      await Promise.all(validaciones);
    }
  }

  static async crearMovimiento(org_id: string, usuario_id: string, body: MovimientoInput) {
    await this.validarRelaciones(org_id, body);

    const payload = { ...body, org_id, usuario_id };
    const { data, error } = await supabaseAdmin
      .from('movimientos')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    if (payload.pedido_id) {
      await this.reconciliarPedido(payload.pedido_id, org_id);
    }

    return data;
  }

  static async actualizarMovimiento(id: string, org_id: string, patch: MovimientoInput) {
    await this.validarRelaciones(org_id, patch);

    const { data: oldMov } = await supabaseAdmin
      .from('movimientos')
      .select('pedido_id')
      .eq('id', id)
      .eq('org_id', org_id)
      .maybeSingle();

    const { data, error } = await supabaseAdmin
      .from('movimientos')
      .update(patch)
      .eq('id', id)
      .eq('org_id', org_id)
      .select()
      .single();

    if (error) throw error;

    if (oldMov?.pedido_id && patch.pedido_id !== undefined && oldMov.pedido_id !== patch.pedido_id) {
      await this.reconciliarPedido(oldMov.pedido_id, org_id);
    }

    const finalPedidoId = patch.pedido_id !== undefined ? patch.pedido_id : oldMov?.pedido_id;
    if (finalPedidoId) {
      await this.reconciliarPedido(finalPedidoId, org_id);
    }

    return data;
  }

  static async eliminarMovimiento(id: string, org_id: string) {
    const { data: oldMov } = await supabaseAdmin
      .from('movimientos')
      .select('pedido_id')
      .eq('id', id)
      .eq('org_id', org_id)
      .maybeSingle();

    const { error } = await supabaseAdmin
      .from('movimientos')
      .delete()
      .eq('id', id)
      .eq('org_id', org_id);

    if (error) throw error;

    if (oldMov?.pedido_id) {
      await this.reconciliarPedido(oldMov.pedido_id, org_id);
    }
  }
}

