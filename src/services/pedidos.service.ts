import sharp from 'sharp';
import { supabaseAdmin } from '../lib/supabase';
import { escapeLike } from '../lib/validate';

export class PedidosService {
  
  static generarFolio() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; 
    let result = '';
    for (let i = 0; i < 4; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `LAV-${result}`; 
  }

  static async listarPedidos(org_id: string, activo?: string, q?: string, limit?: number, offset?: number, deuda?: string) {
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

    if (q) {
      query = query.ilike('folio', `%${escapeLike(String(q))}%`);
    }

    const lim = limit !== undefined && Number.isFinite(limit) ? Math.min(Math.max(0, Math.floor(limit)), 100) : undefined;
    const off = offset !== undefined && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : undefined;

    if (lim !== undefined && lim > 0 && off !== undefined) {
      query = query.range(off, off + lim - 1);
    } else if (lim !== undefined && lim > 0) {
      query = query.limit(lim);
    }

    const { data, error } = await query;
    if (error) throw error;

    return data.map((p: any) => ({
      ...p,
      cliente_nombre: p.clientes?.nombre || 'Cliente Manual',
      cliente_telefono: p.clientes?.telefono || '',
      sucursal_nombre: p.sucursales?.nombre || 'Sin sucursal'
    }));
  }

  static async obtenerPedido(id: string, org_id: string) {
    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .select('*, clientes(nombre, telefono), sucursales(nombre)')
      .eq('id', id)
      .eq('org_id', org_id)
      .single();
    if (error) throw error;
    return {
      ...data,
      cliente_nombre: data.clientes?.nombre || 'Cliente Manual',
      cliente_telefono: data.clientes?.telefono || '',
      sucursal_nombre: data.sucursales?.nombre || 'Sin sucursal'
    };
  }

  static async crearPedido(org_id: string, payload: any) {
    const folio = this.generarFolio();

    if (payload.cliente_id) {
      const { data: cliente } = await supabaseAdmin
        .from('clientes')
        .select('id')
        .eq('id', payload.cliente_id)
        .eq('org_id', org_id)
        .maybeSingle();
      if (!cliente) throw new Error('cliente_id inválido');
    }

    if (payload.sucursal_id) {
      const { data: sucursal } = await supabaseAdmin
        .from('sucursales')
        .select('id')
        .eq('id', payload.sucursal_id)
        .eq('org_id', org_id)
        .maybeSingle();
      if (!sucursal) throw new Error('sucursal_id inválido');
    }

    const hasDiscount = payload.descuento_aplicado && Number(payload.descuento_aplicado) > 0;
    const dataToInsert = { 
      ...payload, 
      org_id, 
      folio, 
      estado: 'recibido',
      promo_canjeada: hasDiscount ? true : (payload.promo_canjeada ?? false)
    };

    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .insert(dataToInsert)
      .select()
      .single();

    if (error) throw error;

    // Actualizar la última visita del cliente
    if (payload.cliente_id) {
      await supabaseAdmin
        .from('clientes')
        .update({ ultima_visita: new Date().toISOString() })
        .eq('id', payload.cliente_id)
        .eq('org_id', org_id);
    }
    
    // Descontar monedero si se aplicó
    if (payload.descuento_aplicado && payload.descuento_aplicado > 0 && payload.cliente_id) {
      const descuentoAplicado = Math.min(50, Number(payload.descuento_aplicado) || 0);
      const { data: cliente } = await supabaseAdmin
        .from('clientes')
        .select('monedero')
        .eq('id', payload.cliente_id)
        .eq('org_id', org_id)
        .single();
        
      if (cliente) {
        const monederoAct = Math.min(50, Number(cliente.monedero) || 0);
        await supabaseAdmin
          .from('clientes')
          .update({ monedero: Math.max(0, monederoAct - descuentoAplicado) })
          .eq('id', payload.cliente_id)
          .eq('org_id', org_id);
      }
    }

    return data;
  }

  static async actualizarPedido(id: string, org_id: string, updates: any) {
    const { data: currentPedido } = await supabaseAdmin
      .from('pedidos')
      .select('cliente_id, puntos_generados, estado, promo_canjeada, descuento_aplicado, monto_total, saldo_pendiente')
      .eq('id', id)
      .eq('org_id', org_id)
      .single();

    if (!currentPedido) throw new Error('Pedido no encontrado o sin acceso');

    if (updates.sucursal_id) {
      const { data: sucursal } = await supabaseAdmin
        .from('sucursales')
        .select('id')
        .eq('id', updates.sucursal_id)
        .eq('org_id', org_id)
        .maybeSingle();
      if (!sucursal) throw new Error('sucursal_id inválido');
    }

    // Ajustar descuento y saldo pendiente cuando existe un descuento_aplicado (incluyendo pre-canje)
    if (updates.monto_total !== undefined && Number(currentPedido.descuento_aplicado) > 0) {
      const nuevoTotal = Number(updates.monto_total) || 0;
      const descOriginal = Math.min(50, Number(currentPedido.descuento_aplicado) || 0);

      if (nuevoTotal === 0) {
        // El pedido sigue en espera de costo total (pre-canje): conservar intacto el descuento_aplicado
        updates.descuento_aplicado = descOriginal;
        updates.promo_canjeada = true;
        updates.saldo_pendiente = 0;
      } else if (nuevoTotal < descOriginal) {
        // El costo real del servicio fue menor al descuento pre-canjeado: devolver la diferencia al monedero (tope $50)
        const diferencia = descOriginal - nuevoTotal;
        if (currentPedido.cliente_id) {
          const { data: cliente } = await supabaseAdmin.from('clientes').select('monedero').eq('id', currentPedido.cliente_id).eq('org_id', org_id).single();
          if (cliente) {
            const monederoAct = Number(cliente.monedero) || 0;
            const nuevoMonedero = Math.min(50, monederoAct + diferencia);
            await supabaseAdmin.from('clientes').update({ monedero: nuevoMonedero }).eq('id', currentPedido.cliente_id).eq('org_id', org_id);
          }
        }
        updates.descuento_aplicado = nuevoTotal;
        updates.saldo_pendiente = 0;
      } else {
        // nuevoTotal >= descOriginal: asegurar que el saldo_pendiente nunca exceda (nuevoTotal - descOriginal)
        const maxPendienteConDescuento = Math.max(0, nuevoTotal - descOriginal);
        const pendienteSolicitado = updates.saldo_pendiente !== undefined ? Number(updates.saldo_pendiente) : maxPendienteConDescuento;
        updates.descuento_aplicado = descOriginal;
        updates.saldo_pendiente = Math.max(0, Math.min(pendienteSolicitado, maxPendienteConDescuento));
      }
    }

    const estadoAnterior = currentPedido.estado;
    const nuevoEstado = updates.estado || estadoAnterior;

    // Si el pedido pasa de entregado a otro estado, revertir cashback generado
    if (estadoAnterior === 'entregado' && nuevoEstado !== 'entregado' && currentPedido.puntos_generados && currentPedido.cliente_id) {
        const { data: cliente } = await supabaseAdmin.from('clientes').select('contador_servicios, monedero, apto_promociones').eq('id', currentPedido.cliente_id).eq('org_id', org_id).single();
        if (cliente && cliente.apto_promociones !== false) {
            const contadorAct = Number(cliente.contador_servicios) || 0;
            const monederoAct = Number(cliente.monedero) || 0;
            const ganancia = (contadorAct % 4 === 0) ? 20 : 10;
            
            const nuevoContador = Math.max(0, contadorAct - 1);
            const nuevoMonedero = Math.max(0, monederoAct - ganancia);
            
            await supabaseAdmin.from('clientes').update({ contador_servicios: nuevoContador, monedero: nuevoMonedero }).eq('id', currentPedido.cliente_id).eq('org_id', org_id);
            updates.puntos_generados = false;
        }
    }

    // Si el pedido se cancela, devolver descuento_aplicado al monedero
    const teniaPromo = currentPedido.promo_canjeada || Number(currentPedido.descuento_aplicado) > 0;
    if (nuevoEstado === 'cancelado' && estadoAnterior !== 'cancelado' && teniaPromo && Number(currentPedido.descuento_aplicado) > 0 && currentPedido.cliente_id) {
        const { data: cliente } = await supabaseAdmin.from('clientes').select('monedero').eq('id', currentPedido.cliente_id).eq('org_id', org_id).single();
        if (cliente) {
            const monederoAct = Number(cliente.monedero) || 0;
            const nuevoMonedero = Math.min(50, monederoAct + Number(currentPedido.descuento_aplicado));
            await supabaseAdmin.from('clientes').update({ monedero: nuevoMonedero }).eq('id', currentPedido.cliente_id).eq('org_id', org_id);
        }
        updates.promo_canjeada = false;
        updates.descuento_aplicado = 0;
    }

    // Generar cashback al entregar
    if (nuevoEstado === 'entregado' && estadoAnterior !== 'entregado') {
      const nowIso = new Date().toISOString();
      updates.fecha_entregado = nowIso;
      if (currentPedido.cliente_id) {
        const { data: cliente } = await supabaseAdmin.from('clientes').select('contador_servicios, monedero, apto_promociones').eq('id', currentPedido.cliente_id).eq('org_id', org_id).single();
        if (cliente) {
          if (!currentPedido.puntos_generados && cliente.apto_promociones !== false) {
            const monederoAct = Number(cliente.monedero) || 0;
            if (monederoAct >= 50) {
              await supabaseAdmin.from('clientes').update({ monedero: 50, ultima_visita: nowIso }).eq('id', currentPedido.cliente_id).eq('org_id', org_id);
              updates.puntos_generados = true;
            } else {
              const contadorAct = Number(cliente.contador_servicios) || 0;
              const nuevoContador = contadorAct + 1;
              const ganancia = (nuevoContador % 4 === 0) ? 20 : 10;
              const nuevoMonedero = Math.min(50, monederoAct + ganancia);
              await supabaseAdmin.from('clientes').update({ contador_servicios: nuevoContador, monedero: nuevoMonedero, ultima_visita: nowIso }).eq('id', currentPedido.cliente_id).eq('org_id', org_id);
              updates.puntos_generados = true;
            }
          } else {
            await supabaseAdmin.from('clientes').update({ ultima_visita: nowIso }).eq('id', currentPedido.cliente_id).eq('org_id', org_id);
          }
        }
      }
    }

    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .update(updates)
      .eq('id', id)
      .eq('org_id', org_id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  static async subirEvidencia(id: string, org_id: string, fileBuffer: Buffer, tipo: string, nota: string) {
    const { data: ped } = await supabaseAdmin.from('pedidos').select('id').eq('id', id).eq('org_id', org_id).single();
    if (!ped) throw new Error('Pedido no encontrado o sin acceso');
    const compressedBuffer = await sharp(fileBuffer)
      .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    const fileName = `${id}/${Date.now()}.webp`; 

    const { error: uploadError } = await supabaseAdmin
      .storage
      .from('evidencias')
      .upload(fileName, compressedBuffer, {
        contentType: 'image/webp',
        upsert: false
      });

    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabaseAdmin
      .storage
      .from('evidencias')
      .getPublicUrl(fileName);

    const { data: dbData, error: dbError } = await supabaseAdmin
      .from('pedido_evidencias')
      .insert({
        pedido_id: id,
        url: publicUrl,
        tipo: tipo || 'ingreso',
        nota: nota || ''
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
    const { data: currentPedido } = await supabaseAdmin.from('pedidos').select('cliente_id, promo_canjeada, descuento_aplicado, puntos_generados, estado').eq('id', id).eq('org_id', org_id).single();
    if (!currentPedido) throw new Error('Pedido no encontrado o sin acceso');

    // Revertir cashback
    if (currentPedido.puntos_generados && currentPedido.cliente_id) {
      const { data: cliente } = await supabaseAdmin.from('clientes').select('contador_servicios, monedero, apto_promociones').eq('id', currentPedido.cliente_id).eq('org_id', org_id).single();
      if (cliente && cliente.apto_promociones !== false) {
        const contadorAct = Number(cliente.contador_servicios) || 0;
        const monederoAct = Number(cliente.monedero) || 0;
        const ganancia = (contadorAct % 4 === 0) ? 20 : 10;
        const nuevoContador = Math.max(0, contadorAct - 1);
        const nuevoMonedero = Math.max(0, monederoAct - ganancia);
        await supabaseAdmin.from('clientes').update({ contador_servicios: nuevoContador, monedero: nuevoMonedero }).eq('id', currentPedido.cliente_id).eq('org_id', org_id);
      }
    }

    // Revertir promo canjeada
    if (currentPedido.promo_canjeada && currentPedido.descuento_aplicado > 0 && currentPedido.cliente_id) {
      const { data: cliente } = await supabaseAdmin.from('clientes').select('monedero').eq('id', currentPedido.cliente_id).eq('org_id', org_id).single();
      if (cliente) {
        const monederoAct = Number(cliente.monedero) || 0;
        const nuevoMonedero = Math.min(50, monederoAct + Number(currentPedido.descuento_aplicado));
        await supabaseAdmin.from('clientes').update({ monedero: nuevoMonedero }).eq('id', currentPedido.cliente_id).eq('org_id', org_id);
      }
    }

    // Primero, limpiar en cascada los movimientos financieros asociados
    await supabaseAdmin.from('movimientos').delete().eq('pedido_id', id).eq('org_id', org_id);

    const { error } = await supabaseAdmin
      .from('pedidos')
      .delete()
      .eq('id', id)
      .eq('org_id', org_id);

    if (error) throw error;
  }

  static async eliminarEvidencia(pedidoId: string, org_id: string, evidenciaId: string) {
    const { data: ped } = await supabaseAdmin.from('pedidos').select('id').eq('id', pedidoId).eq('org_id', org_id).single();
    if (!ped) throw new Error('Pedido no encontrado o sin acceso');
    const { data: evidencia, error: findError } = await supabaseAdmin
      .from('pedido_evidencias')
      .select('url')
      .eq('id', evidenciaId)
      .eq('pedido_id', pedidoId)
      .single();

    if (findError || !evidencia) {
      const err: any = new Error('Evidencia no encontrada');
      err.status = 404;
      throw err;
    }

    try {
      const urlParts = evidencia.url.split('/evidencias/');
      if (urlParts.length > 1) {
        const path = urlParts[1];
        await supabaseAdmin.storage.from('evidencias').remove([path]);
      }
    } catch (err) {
      console.warn('Advertencia: No se pudo borrar el archivo físico de Storage:', err);
    }

    const { error: deleteError } = await supabaseAdmin
      .from('pedido_evidencias')
      .delete()
      .eq('id', evidenciaId);

    if (deleteError) throw deleteError;
  }
}
