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

interface ClienteRelacion {
  id?: string;
  nombre: string;
  telefono: string;
  permite_whatsapp?: boolean;
}

function normalizarRelacionCliente(rel: ClienteRelacion | ClienteRelacion[] | null | undefined): ClienteRelacion | null {
  if (!rel) return null;
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

export class PedidosService {
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
    categoriaSolicitada?: string | null
  ): Promise<string | null> {
    if (categoriaSolicitada) return categoriaSolicitada;

    const { data: cats } = await supabaseAdmin
      .from('categorias')
      .select('id')
      .eq('org_id', org_id)
      .eq('tipo', 'ingreso')
      .eq('activo', true)
      .order('created_at', { ascending: true })
      .limit(2);

    if (!cats || cats.length === 0) return null;
    return cats.length > 1 ? cats[1].id : cats[0].id;
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
    return (data || []).map((p) => {
      const cli = normalizarRelacionCliente(p.clientes as ClienteRelacion | ClienteRelacion[] | null);
      const suc = Array.isArray(p.sucursales) ? p.sucursales[0] : p.sucursales;
      return {
        ...p,
        cliente_nombre: cli?.nombre || 'Cliente Manual',
        cliente_telefono: cli?.telefono || '',
        sucursal_nombre: (suc as { nombre?: string } | null)?.nombre || 'Sin sucursal',
        whatsapp_automatico: waAuto,
      };
    });
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

      const categoriaId = await this.resolverCategoriaIngresoDefault(org_id, categoria_ingreso_id);
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
