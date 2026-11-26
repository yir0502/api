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

export function calcularTotalesMovimientos(rows: MovimientoListadoRow[]): MovimientosTotales {
  let ingresos = 0;
  let egresos = 0;

  for (const row of rows) {
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

  private static construirQueryBase(org_id: string, filters: MovimientosFilter) {
    const { desde, hasta, tipo, categoria_id, metodo_pago, sucursal_id, pedido_id } = filters;

    let qmov = supabaseAdmin
      .from('movimientos')
      .select('*, categorias ( id, nombre ), sucursales ( id, nombre )')
      .eq('org_id', org_id);

    if (desde) qmov = qmov.gte('fecha', String(desde));
    if (hasta) qmov = qmov.lte('fecha', String(hasta));
    if (tipo) qmov = qmov.eq('tipo', String(tipo));
    if (categoria_id) qmov = qmov.eq('categoria_id', String(categoria_id));
    if (metodo_pago) qmov = qmov.eq('metodo_pago', String(metodo_pago));
    if (sucursal_id) qmov = qmov.eq('sucursal_id', String(sucursal_id));
    if (pedido_id) qmov = qmov.eq('pedido_id', String(pedido_id));

    return qmov.order('fecha', { ascending: false }).order('created_at', { ascending: false });
  }

  static async listarMovimientos(org_id: string, filters: MovimientosFilter): Promise<MovimientoListadoRow[]> {
    const { q, limit, offset } = filters;
    let qmov = this.construirQueryBase(org_id, filters);

    const rawLim = limit !== undefined ? Number(limit) : undefined;
    const rawOff = offset !== undefined ? Number(offset) : undefined;
    const lim = rawLim !== undefined && Number.isFinite(rawLim) ? Math.min(Math.max(0, Math.floor(rawLim)), 2000) : undefined;
    const off = rawOff !== undefined && Number.isFinite(rawOff) ? Math.max(0, Math.floor(rawOff)) : undefined;
    if (lim !== undefined && lim > 0 && off !== undefined) qmov = qmov.range(off, off + lim - 1);
    else if (lim !== undefined && lim > 0) qmov = qmov.limit(lim);

    const { data: movs, error } = await qmov;
    if (error) throw error;

    return normalizarYFiltrarMovimientos((movs || []) as MovimientoDbRow[], q);
  }

  static async listarMovimientosPaginados(
    org_id: string,
    filters: MovimientosFilter
  ): Promise<MovimientosPaginadosResult> {
    const { data: movs, error } = await this.construirQueryBase(org_id, filters);
    if (error) throw error;

    const filtrados = normalizarYFiltrarMovimientos((movs || []) as MovimientoDbRow[], filters.q);
    const count = filtrados.length;
    const totales = calcularTotalesMovimientos(filtrados);
    const { limit, offset } = normalizarPaginacion(filters.limit, filters.offset);
    const data = filtrados.slice(offset, offset + limit);

    return { data, count, totales };
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

