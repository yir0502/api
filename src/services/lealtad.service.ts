import { supabaseAdmin } from '../lib/supabase';

export class LealtadService {
  static readonly MONEDERO_MAX = 50;
  static readonly SERVICIOS_POR_CICLO = 4;
  static readonly BONO_REGULAR = 10;
  static readonly BONO_CICLO = 20;
  static readonly ESTADOS_ACTIVOS = ['recibido', 'lavando', 'secando', 'doblando', 'listo'];

  static calcularGananciaPorContador(contadorServicios: number): number {
    return contadorServicios % this.SERVICIOS_POR_CICLO === 0
      ? this.BONO_CICLO
      : this.BONO_REGULAR;
  }

  static construirInfoLealtadPublica(
    clienteData: { apto_promociones: boolean; monedero: number; contador_servicios: number },
    pedido: { estado: string; promo_canjeada?: boolean; descuento_aplicado?: number; monto_total?: number; saldo_pendiente?: number }
  ) {
    if (!clienteData.apto_promociones) {
      return { apto: false };
    }

    const monederoTope = Math.min(this.MONEDERO_MAX, Math.max(0, Number(clienteData.monedero) || 0));
    const contadorServicios = Math.max(0, Number(clienteData.contador_servicios) || 0);
    const serviciosEnCiclo = contadorServicios % this.SERVICIOS_POR_CICLO;
    const serviciosParaProxima = this.SERVICIOS_POR_CICLO - serviciosEnCiclo;
    const proximaGanancia = monederoTope >= this.MONEDERO_MAX
      ? 0
      : (serviciosEnCiclo === this.SERVICIOS_POR_CICLO - 1 ? this.BONO_CICLO : this.BONO_REGULAR);

    const tieneDescuentoActivo = Boolean(pedido.promo_canjeada && Number(pedido.descuento_aplicado) > 0);
    const puedeCanjear =
      monederoTope > 0 &&
      this.ESTADOS_ACTIVOS.includes(pedido.estado) &&
      !tieneDescuentoActivo &&
      (Number(pedido.monto_total) === 0 || Number(pedido.saldo_pendiente) > 0);

    return {
      apto: true,
      monedero: monederoTope,
      contador_servicios: contadorServicios,
      servicios_en_ciclo: serviciosEnCiclo,
      servicios_para_proxima: serviciosParaProxima,
      proxima_ganancia: proximaGanancia,
      puede_canjear: puedeCanjear,
    };
  }

  static async descontarMonederoInicial(orgId: string, clienteId: string, descuentoSolicitado: number) {
    const descuentoAplicado = Math.min(this.MONEDERO_MAX, Math.max(0, Number(descuentoSolicitado) || 0));
    if (descuentoAplicado <= 0) return;

    const { data: cliente } = await supabaseAdmin
      .from('clientes')
      .select('monedero')
      .eq('id', clienteId)
      .eq('org_id', orgId)
      .single();

    if (cliente) {
      const monederoAct = Math.min(this.MONEDERO_MAX, Number(cliente.monedero) || 0);
      await supabaseAdmin
        .from('clientes')
        .update({ monedero: Math.max(0, monederoAct - descuentoAplicado) })
        .eq('id', clienteId)
        .eq('org_id', orgId);
    }
  }

  static async devolverAlMonedero(orgId: string, clienteId: string, montoDevolver: number) {
    const monto = Math.max(0, Number(montoDevolver) || 0);
    if (monto <= 0) return;

    const { data: cliente } = await supabaseAdmin
      .from('clientes')
      .select('monedero')
      .eq('id', clienteId)
      .eq('org_id', orgId)
      .single();

    if (cliente) {
      const monederoAct = Number(cliente.monedero) || 0;
      const nuevoMonedero = Math.min(this.MONEDERO_MAX, monederoAct + monto);
      await supabaseAdmin
        .from('clientes')
        .update({ monedero: nuevoMonedero })
        .eq('id', clienteId)
        .eq('org_id', orgId);
    }
  }

  static async ajustarDescuentoPorCambioDeTotal(orgId: string, currentPedido: any, updates: any) {
    if (updates.monto_total === undefined || Number(currentPedido.descuento_aplicado) <= 0) {
      return;
    }

    const nuevoTotal = Number(updates.monto_total) || 0;
    const descOriginal = Math.min(this.MONEDERO_MAX, Number(currentPedido.descuento_aplicado) || 0);

    if (nuevoTotal === 0) {
      // El pedido sigue en espera de costo total (pre-canje): conservar intacto el descuento_aplicado
      updates.descuento_aplicado = descOriginal;
      updates.promo_canjeada = true;
      updates.saldo_pendiente = 0;
    } else if (nuevoTotal < descOriginal) {
      // El costo real fue menor al descuento pre-canjeado: devolver diferencia al monedero (tope $50)
      const diferencia = descOriginal - nuevoTotal;
      if (currentPedido.cliente_id) {
        await this.devolverAlMonedero(orgId, currentPedido.cliente_id, diferencia);
      }
      updates.descuento_aplicado = nuevoTotal;
      updates.saldo_pendiente = 0;
    } else {
      // nuevoTotal >= descOriginal: garantizar que saldo_pendiente nunca exceda (nuevoTotal - descOriginal)
      const maxPendienteConDescuento = Math.max(0, nuevoTotal - descOriginal);
      const pendienteSolicitado =
        updates.saldo_pendiente !== undefined ? Number(updates.saldo_pendiente) : maxPendienteConDescuento;
      updates.descuento_aplicado = descOriginal;
      updates.saldo_pendiente = Math.max(0, Math.min(pendienteSolicitado, maxPendienteConDescuento));
    }
  }

  static async otorgarCashbackEntrega(orgId: string, clienteId: string, puntosYaGenerados: boolean, nowIso: string): Promise<boolean> {
    const { data: cliente } = await supabaseAdmin
      .from('clientes')
      .select('contador_servicios, monedero, apto_promociones')
      .eq('id', clienteId)
      .eq('org_id', orgId)
      .single();

    if (!cliente) return false;

    if (!puntosYaGenerados && cliente.apto_promociones !== false) {
      const monederoAct = Number(cliente.monedero) || 0;
      if (monederoAct >= this.MONEDERO_MAX) {
        await supabaseAdmin
          .from('clientes')
          .update({ monedero: this.MONEDERO_MAX, ultima_visita: nowIso })
          .eq('id', clienteId)
          .eq('org_id', orgId);
        return true;
      } else {
        const contadorAct = Number(cliente.contador_servicios) || 0;
        const nuevoContador = contadorAct + 1;
        const ganancia = this.calcularGananciaPorContador(nuevoContador);
        const nuevoMonedero = Math.min(this.MONEDERO_MAX, monederoAct + ganancia);
        await supabaseAdmin
          .from('clientes')
          .update({
            contador_servicios: nuevoContador,
            monedero: nuevoMonedero,
            ultima_visita: nowIso,
          })
          .eq('id', clienteId)
          .eq('org_id', orgId);
        return true;
      }
    } else {
      await supabaseAdmin
        .from('clientes')
        .update({ ultima_visita: nowIso })
        .eq('id', clienteId)
        .eq('org_id', orgId);
      return puntosYaGenerados;
    }
  }

  static async revertirCashbackEntrega(orgId: string, clienteId: string): Promise<boolean> {
    const { data: cliente } = await supabaseAdmin
      .from('clientes')
      .select('contador_servicios, monedero, apto_promociones')
      .eq('id', clienteId)
      .eq('org_id', orgId)
      .single();

    if (cliente && cliente.apto_promociones !== false) {
      const contadorAct = Number(cliente.contador_servicios) || 0;
      const monederoAct = Number(cliente.monedero) || 0;
      const ganancia = this.calcularGananciaPorContador(contadorAct);
      const nuevoContador = Math.max(0, contadorAct - 1);
      const nuevoMonedero = Math.max(0, monederoAct - ganancia);

      await supabaseAdmin
        .from('clientes')
        .update({ contador_servicios: nuevoContador, monedero: nuevoMonedero })
        .eq('id', clienteId)
        .eq('org_id', orgId);
      return true;
    }
    return false;
  }

  static async canjearMonederoEnPedido(orgId: string, folio: string) {
    const { data: pedido, error: pedidoError } = await supabaseAdmin
      .from('pedidos')
      .select('id, estado, saldo_pendiente, promo_canjeada, descuento_aplicado, cliente_id, monto_total')
      .eq('org_id', orgId)
      .eq('folio', folio)
      .maybeSingle();

    if (pedidoError) throw pedidoError;
    if (!pedido) {
      const err: any = new Error('Pedido no encontrado');
      err.status = 404;
      throw err;
    }

    if (!this.ESTADOS_ACTIVOS.includes(pedido.estado)) {
      const err: any = new Error('No se puede canjear en un pedido entregado o cancelado. Tu saldo sigue disponible para el próximo pedido.');
      err.status = 409;
      throw err;
    }

    if (pedido.promo_canjeada && Number(pedido.descuento_aplicado) > 0) {
      const err: any = new Error('Ya se aplicó una promoción a este pedido.');
      err.status = 409;
      throw err;
    }

    if (!pedido.cliente_id) {
      const err: any = new Error('Este pedido no tiene un cliente registrado.');
      err.status = 400;
      throw err;
    }

    const { data: cliente, error: clienteError } = await supabaseAdmin
      .from('clientes')
      .select('monedero, apto_promociones')
      .eq('id', pedido.cliente_id)
      .eq('org_id', orgId)
      .single();

    if (clienteError) throw clienteError;
    if (!cliente) {
      const err: any = new Error('Cliente no encontrado.');
      err.status = 404;
      throw err;
    }

    if (!cliente.apto_promociones) {
      const err: any = new Error('Este cliente no está inscrito en el programa de lealtad.');
      err.status = 403;
      throw err;
    }

    const monedero = Math.min(this.MONEDERO_MAX, Number(cliente.monedero) || 0);
    if (monedero <= 0) {
      const err: any = new Error('No tienes saldo acumulado disponible.');
      err.status = 400;
      throw err;
    }

    const esPreCanje = Number(pedido.monto_total) === 0;
    const saldoPendiente = Number(pedido.saldo_pendiente) || 0;

    if (!esPreCanje && saldoPendiente <= 0) {
      const err: any = new Error(
        `Tu pedido ya está pagado en su totalidad. Tu saldo de $${monedero.toFixed(2)} MXN se conservará intacto para tu próximo pedido.`
      );
      err.status = 400;
      throw err;
    }

    const descuento = esPreCanje ? monedero : Math.min(monedero, saldoPendiente);
    if (descuento <= 0) {
      const err: any = new Error('No hay saldo pendiente disponible para aplicar descuento en este pedido.');
      err.status = 400;
      throw err;
    }

    const nuevoSaldo = esPreCanje ? 0 : Math.max(0, saldoPendiente - descuento);
    const monederoRestante = Math.max(0, monedero - descuento);

    const { error: updatePedidoError } = await supabaseAdmin
      .from('pedidos')
      .update({
        descuento_aplicado: descuento,
        saldo_pendiente: nuevoSaldo,
        promo_canjeada: true,
      })
      .eq('id', pedido.id)
      .eq('org_id', orgId);

    if (updatePedidoError) throw updatePedidoError;

    const { error: updateClienteError } = await supabaseAdmin
      .from('clientes')
      .update({ monedero: monederoRestante })
      .eq('id', pedido.cliente_id)
      .eq('org_id', orgId);

    if (updateClienteError) throw updateClienteError;

    return {
      ok: true,
      descuento_aplicado: descuento,
      saldo_pendiente: nuevoSaldo,
      monedero_restante: monederoRestante,
      mensaje: `¡Listo! Se aplicó un descuento de $${descuento.toFixed(2)} a tu pedido.`,
    };
  }
}

