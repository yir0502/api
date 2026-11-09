import { supabaseAdmin } from '../lib/supabase';

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

  static async listarMovimientos(org_id: string, filters: any) {
    const { desde, hasta, tipo, categoria_id, metodo_pago, sucursal_id, q, limit, offset, pedido_id } = filters;

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

    qmov = qmov.order('fecha', { ascending: false }).order('created_at', { ascending: false });

    const rawLim = limit !== undefined ? Number(limit) : undefined;
    const rawOff = offset !== undefined ? Number(offset) : undefined;
    const lim = rawLim !== undefined && Number.isFinite(rawLim) ? Math.min(Math.max(0, Math.floor(rawLim)), 2000) : undefined;
    const off = rawOff !== undefined && Number.isFinite(rawOff) ? Math.max(0, Math.floor(rawOff)) : undefined;
    if (lim !== undefined && lim > 0 && off !== undefined) qmov = qmov.range(off, off + lim - 1);
    else if (lim !== undefined && lim > 0) qmov = qmov.limit(lim);

    const { data: movs, error } = await qmov;
    if (error) throw error;

    let result = (movs || []).map((m: any) => ({
      ...m,
      categoria_nombre: m.categorias?.nombre || 'Sin categoría',
      sucursal_nombre: m.sucursales?.nombre || 'Sin sucursal',
      categorias: undefined,
      sucursales: undefined,
    }));

    if (q && String(q).trim()) {
      const needle = String(q).trim().toLowerCase();
      result = result.filter((m: any) => {
        const nota = (m.nota || '').toLowerCase();
        const metodo = (m.metodo_pago || '').toLowerCase();
        const cat = (m.categoria_nombre || '').toLowerCase();
        const suc = (m.sucursal_nombre || '').toLowerCase();
        return nota.includes(needle) || metodo.includes(needle) || cat.includes(needle) || suc.includes(needle);
      });
    }

    return result;
  }

  static async obtenerMovimiento(id: string, org_id: string) {
    const { data, error } = await supabaseAdmin
      .from('movimientos')
      .select('*, categorias ( id, nombre ), sucursales ( id, nombre )')
      .eq('id', id)
      .eq('org_id', org_id)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      const err: any = new Error('Movimiento no encontrado');
      err.status = 404;
      throw err;
    }

    return {
      ...data,
      categoria_nombre: (data as any).categorias?.nombre || 'Sin categoría',
      sucursal_nombre: (data as any).sucursales?.nombre || 'Sin sucursal',
      categorias: undefined,
      sucursales: undefined,
    };
  }

  private static async validarRelaciones(org_id: string, payload: any) {
    if (payload.sucursal_id) {
      const { data: s } = await supabaseAdmin
        .from('sucursales')
        .select('id')
        .eq('id', payload.sucursal_id)
        .eq('org_id', org_id)
        .maybeSingle();
      if (!s) {
        const err: any = new Error('sucursal_id inválido');
        err.status = 400;
        throw err;
      }
    }

    if (payload.categoria_id) {
      const { data: c } = await supabaseAdmin
        .from('categorias')
        .select('id')
        .eq('id', payload.categoria_id)
        .eq('org_id', org_id)
        .maybeSingle();
      if (!c) {
        const err: any = new Error('categoria_id inválido');
        err.status = 400;
        throw err;
      }
    }

    if (payload.pedido_id) {
      const { data: p } = await supabaseAdmin
        .from('pedidos')
        .select('id')
        .eq('id', payload.pedido_id)
        .eq('org_id', org_id)
        .maybeSingle();
      if (!p) {
        const err: any = new Error('pedido_id inválido');
        err.status = 400;
        throw err;
      }
    }
  }

  static async crearMovimiento(org_id: string, usuario_id: string, body: any) {
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

  static async actualizarMovimiento(id: string, org_id: string, patch: any) {
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

