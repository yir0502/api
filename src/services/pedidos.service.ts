import sharp from 'sharp';
import { supabaseAdmin } from '../lib/supabase';

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
      query = query.ilike('folio', `%${q}%`);
    }

    if (limit && offset) {
      query = query.range(offset, offset + limit - 1);
    } else if (limit) {
      query = query.limit(limit);
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
    const dataToInsert = { ...payload, org_id, folio, estado: 'recibido' };

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
        .eq('id', payload.cliente_id);
    }
    
    // Descontar monedero si se aplicó
    if (payload.descuento_aplicado && payload.descuento_aplicado > 0 && payload.cliente_id) {
      const { data: cliente } = await supabaseAdmin
        .from('clientes')
        .select('monedero')
        .eq('id', payload.cliente_id)
        .single();
        
      if (cliente) {
        const monederoAct = Number(cliente.monedero) || 0;
        await supabaseAdmin
          .from('clientes')
          .update({ monedero: Math.max(0, monederoAct - payload.descuento_aplicado) })
          .eq('id', payload.cliente_id);
      }
    }

    return data;
  }

  static async actualizarPedido(id: string, org_id: string, updates: any) {
    const { data: currentPedido } = await supabaseAdmin
      .from('pedidos')
      .select('cliente_id, puntos_generados, estado, promo_canjeada, descuento_aplicado')
      .eq('id', id)
      .eq('org_id', org_id)
      .single();

    if (!currentPedido) throw new Error('Pedido no encontrado o sin acceso');

    // Ajustar descuento si el monto_total es menor que el descuento_aplicado
    if (updates.monto_total !== undefined && currentPedido.descuento_aplicado > 0) {
      const nuevoTotal = Number(updates.monto_total) || 0;
      const descOriginal = Number(currentPedido.descuento_aplicado) || 0;
      if (nuevoTotal < descOriginal) {
        const diferencia = descOriginal - nuevoTotal;
        if (currentPedido.cliente_id) {
          const { data: cliente } = await supabaseAdmin.from('clientes').select('monedero').eq('id', currentPedido.cliente_id).single();
          if (cliente) {
            const monederoAct = Number(cliente.monedero) || 0;
            const nuevoMonedero = Math.min(60, monederoAct + diferencia);
            await supabaseAdmin.from('clientes').update({ monedero: nuevoMonedero }).eq('id', currentPedido.cliente_id);
          }
        }
        updates.descuento_aplicado = nuevoTotal;
        updates.saldo_pendiente = 0;
      }
    }

    const estadoAnterior = currentPedido.estado;
    const nuevoEstado = updates.estado || estadoAnterior;

    // Si el pedido pasa de entregado a otro estado, revertir cashback generado
    if (estadoAnterior === 'entregado' && nuevoEstado !== 'entregado' && currentPedido.puntos_generados && currentPedido.cliente_id) {
        const { data: cliente } = await supabaseAdmin.from('clientes').select('contador_servicios, monedero, apto_promociones').eq('id', currentPedido.cliente_id).single();
        if (cliente && cliente.apto_promociones !== false) {
            const contadorAct = Number(cliente.contador_servicios) || 0;
            const monederoAct = Number(cliente.monedero) || 0;
            const ganancia = (contadorAct % 4 === 0) ? 30 : 10;
            
            const nuevoContador = Math.max(0, contadorAct - 1);
            const nuevoMonedero = Math.max(0, monederoAct - ganancia);
            
            await supabaseAdmin.from('clientes').update({ contador_servicios: nuevoContador, monedero: nuevoMonedero }).eq('id', currentPedido.cliente_id);
            updates.puntos_generados = false;
        }
    }

    // Si el pedido se cancela, devolver descuento_aplicado al monedero
    if (nuevoEstado === 'cancelado' && estadoAnterior !== 'cancelado' && currentPedido.promo_canjeada && currentPedido.descuento_aplicado > 0 && currentPedido.cliente_id) {
        const { data: cliente } = await supabaseAdmin.from('clientes').select('monedero').eq('id', currentPedido.cliente_id).single();
        if (cliente) {
            const monederoAct = Number(cliente.monedero) || 0;
            const nuevoMonedero = Math.min(60, monederoAct + Number(currentPedido.descuento_aplicado));
            await supabaseAdmin.from('clientes').update({ monedero: nuevoMonedero }).eq('id', currentPedido.cliente_id);
        }
        updates.promo_canjeada = false;
        updates.descuento_aplicado = 0;
    }

    // Generar cashback al entregar
    if (nuevoEstado === 'entregado' && estadoAnterior !== 'entregado') {
      updates.fecha_entregado = new Date().toISOString();
      if (currentPedido.cliente_id && !currentPedido.puntos_generados) {
        const { data: cliente } = await supabaseAdmin.from('clientes').select('contador_servicios, monedero, apto_promociones').eq('id', currentPedido.cliente_id).single();
        if (cliente && cliente.apto_promociones !== false) {
          const monederoAct = Number(cliente.monedero) || 0;
          if (monederoAct >= 60) {
            updates.puntos_generados = true;
          } else {
            const contadorAct = Number(cliente.contador_servicios) || 0;
            const nuevoContador = contadorAct + 1;
            const ganancia = (nuevoContador % 4 === 0) ? 30 : 10;
            const nuevoMonedero = Math.min(60, monederoAct + ganancia);
            await supabaseAdmin.from('clientes').update({ contador_servicios: nuevoContador, monedero: nuevoMonedero }).eq('id', currentPedido.cliente_id);
            updates.puntos_generados = true;
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
      const { data: cliente } = await supabaseAdmin.from('clientes').select('contador_servicios, monedero, apto_promociones').eq('id', currentPedido.cliente_id).single();
      if (cliente && cliente.apto_promociones !== false) {
        const contadorAct = Number(cliente.contador_servicios) || 0;
        const monederoAct = Number(cliente.monedero) || 0;
        const ganancia = (contadorAct % 4 === 0) ? 30 : 10;
        const nuevoContador = Math.max(0, contadorAct - 1);
        const nuevoMonedero = Math.max(0, monederoAct - ganancia);
        await supabaseAdmin.from('clientes').update({ contador_servicios: nuevoContador, monedero: nuevoMonedero }).eq('id', currentPedido.cliente_id);
      }
    }

    // Revertir promo canjeada
    if (currentPedido.promo_canjeada && currentPedido.descuento_aplicado > 0 && currentPedido.cliente_id) {
      const { data: cliente } = await supabaseAdmin.from('clientes').select('monedero').eq('id', currentPedido.cliente_id).single();
      if (cliente) {
        const monederoAct = Number(cliente.monedero) || 0;
        const nuevoMonedero = Math.min(60, monederoAct + Number(currentPedido.descuento_aplicado));
        await supabaseAdmin.from('clientes').update({ monedero: nuevoMonedero }).eq('id', currentPedido.cliente_id);
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
