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

  static async crearPedido(org_id: string, payload: any) {
    const folio = this.generarFolio();
    const dataToInsert = { ...payload, org_id, folio, estado: 'recibido' };

    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .insert(dataToInsert)
      .select()
      .single();

    if (error) throw error;
    
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

  static async actualizarPedido(id: string, updates: any) {
    if (updates.estado === 'entregado') {
      updates.fecha_entregado = new Date().toISOString();
      
      // Lógica de Monedero (Cashback)
      const { data: currentPedido } = await supabaseAdmin
        .from('pedidos')
        .select('cliente_id, puntos_generados')
        .eq('id', id)
        .single();
        
      if (currentPedido?.cliente_id && !currentPedido.puntos_generados) {
        // Obtener cliente actual para revisar su contador
        const { data: cliente } = await supabaseAdmin
          .from('clientes')
          .select('contador_servicios, monedero')
          .eq('id', currentPedido.cliente_id)
          .single();
          
        if (cliente) {
          const contadorAct = Number(cliente.contador_servicios) || 0;
          const monederoAct = Number(cliente.monedero) || 0;
          
          const nuevoContador = contadorAct + 1;
          const ganancia = (nuevoContador % 4 === 0) ? 30 : 10;
          
          await supabaseAdmin
            .from('clientes')
            .update({ 
              contador_servicios: nuevoContador,
              monedero: monederoAct + ganancia 
            })
            .eq('id', currentPedido.cliente_id);
            
          updates.puntos_generados = true;
        }
      }
    }

    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  static async subirEvidencia(id: string, fileBuffer: Buffer, tipo: string, nota: string) {
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

  static async obtenerEvidencias(id: string) {
    const { data, error } = await supabaseAdmin
      .from('pedido_evidencias')
      .select('*')
      .eq('pedido_id', id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data;
  }

  static async eliminarPedido(id: string) {
    // Primero, limpiar en cascada los movimientos financieros asociados
    await supabaseAdmin.from('movimientos').delete().eq('pedido_id', id);

    const { error } = await supabaseAdmin
      .from('pedidos')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  static async eliminarEvidencia(pedidoId: string, evidenciaId: string) {
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
