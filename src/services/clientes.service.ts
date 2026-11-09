import { supabaseAdmin } from '../lib/supabase';
import { escapeLike } from '../lib/validate';

export class ClientesService {
  static normalizarYValidarTelefono(tel: string): string {
    if (!tel) {
      throw new Error('El número de teléfono es obligatorio');
    }
    let clean = tel.replace(/\D/g, '');
    if (clean.startsWith('52') && clean.length === 12) {
      clean = clean.substring(2);
    }
    if (clean.length === 11 && clean.startsWith('1')) {
      clean = clean.substring(1);
    }
    if (clean.length !== 10) {
      throw new Error('El número de teléfono debe tener 10 dígitos (puedes incluir prefijo +52, espacios o guiones)');
    }
    return clean;
  }

  static async listarClientes(org_id: string, params: { q?: any; limit?: any; offset?: any; filter?: any }) {
    const { q, limit, offset, filter } = params;

    let query = supabaseAdmin
      .from('clientes')
      .select('*', { count: 'exact' })
      .eq('org_id', org_id)
      .order('nombre', { ascending: true });

    if (filter === 'falta_promo') {
      const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      query = query.or(`fecha_ultima_promo.is.null,fecha_ultima_promo.lt.${startOfMonth}`);
    } else if (filter === '0-15') {
      const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte('ultima_visita', fifteenDaysAgo);
    } else if (filter === '16-45') {
      const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
      const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
      query = query.lt('ultima_visita', fifteenDaysAgo).gte('ultima_visita', fortyFiveDaysAgo);
    } else if (filter === '45plus') {
      const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
      query = query.or(`ultima_visita.is.null,ultima_visita.lt.${fortyFiveDaysAgo}`);
    }

    if (q && String(q).trim()) {
      const term = escapeLike(String(q).trim());
      query = query.or(`nombre.ilike.%${term}%,telefono.ilike.%${term}%`);
    }

    const rawLim = limit !== undefined ? Number(limit) : undefined;
    const rawOff = offset !== undefined ? Number(offset) : undefined;
    const lim = rawLim !== undefined && Number.isFinite(rawLim) ? Math.min(Math.max(0, Math.floor(rawLim)), 100) : undefined;
    const off = rawOff !== undefined && Number.isFinite(rawOff) ? Math.max(0, Math.floor(rawOff)) : undefined;
    if (lim !== undefined && lim > 0 && off !== undefined) {
      query = query.range(off, off + lim - 1);
    } else if (lim !== undefined && lim > 0) {
      query = query.limit(lim);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    return { data: data || [], count: count || 0 };
  }

  static async obtenerEstadisticas(org_id: string) {
    const { data, error } = await supabaseAdmin
      .from('clientes')
      .select('id, ultima_visita, fecha_ultima_promo, permite_whatsapp, frecuencia_recordatorio')
      .eq('org_id', org_id);

    if (error) throw error;

    let faltan_promo = 0;
    let active_0_15 = 0;
    let risk_16_45 = 0;
    let lost_45plus = 0;
    let con_whatsapp = 0;

    const frecuencias: Record<string, number> = { '7': 0, '15': 0, '30': 0, otros: 0 };
    const now = Date.now();
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    data?.forEach((c) => {
      if (c.permite_whatsapp) con_whatsapp++;

      const f = String(c.frecuencia_recordatorio || 15);
      if (['7', '15', '30'].includes(f)) frecuencias[f]++;
      else frecuencias.otros++;

      if (!c.fecha_ultima_promo || new Date(c.fecha_ultima_promo) < startOfMonth) {
        faltan_promo++;
      }

      if (!c.ultima_visita) {
        lost_45plus++;
      } else {
        const diff = now - new Date(c.ultima_visita).getTime();
        const dias = diff / (1000 * 3600 * 24);
        if (dias <= 15) active_0_15++;
        else if (dias <= 45) risk_16_45++;
        else lost_45plus++;
      }
    });

    return {
      total: data?.length || 0,
      faltan_promo,
      con_whatsapp,
      frecuencias,
      segmentos: { active_0_15, risk_16_45, lost_45plus },
    };
  }

  static async obtenerCliente(id: string, org_id: string) {
    const { data, error } = await supabaseAdmin
      .from('clientes')
      .select('*')
      .eq('id', id)
      .eq('org_id', org_id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        const err: any = new Error('Cliente no encontrado');
        err.status = 404;
        throw err;
      }
      throw error;
    }
    return data;
  }

  static async crearCliente(org_id: string, body: any) {
    const { nombre, telefono, email, direccion, permite_whatsapp, frecuencia_recordatorio, apto_promociones } = body;

    let telNormalizado: string;
    try {
      telNormalizado = this.normalizarYValidarTelefono(telefono);
    } catch (e: any) {
      const err: any = new Error(e.message);
      err.status = 400;
      throw err;
    }

    const { data: existing, error: existError } = await supabaseAdmin
      .from('clientes')
      .select('id')
      .eq('org_id', org_id)
      .eq('telefono', telNormalizado);

    if (existError && existError.code !== 'PGRST116') throw existError;
    if (existing && existing.length > 0) {
      const err: any = new Error('El número de teléfono ya está registrado para otro cliente');
      err.status = 400;
      throw err;
    }

    const payload = {
      org_id,
      nombre,
      telefono: telNormalizado,
      email,
      direccion,
      permite_whatsapp: permite_whatsapp ?? true,
      frecuencia_recordatorio: frecuencia_recordatorio ?? 15,
      apto_promociones: apto_promociones ?? false,
      ultima_visita: new Date().toISOString(),
    };

    const { data, error } = await supabaseAdmin
      .from('clientes')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  static async actualizarCliente(id: string, org_id: string, body: any) {
    const { id: _, org_id: __, created_at, ...updates } = body;

    if (updates.telefono) {
      let telNormalizado: string;
      try {
        telNormalizado = this.normalizarYValidarTelefono(updates.telefono);
      } catch (e: any) {
        const err: any = new Error(e.message);
        err.status = 400;
        throw err;
      }

      const { data: existing, error: existError } = await supabaseAdmin
        .from('clientes')
        .select('id')
        .eq('org_id', org_id)
        .eq('telefono', telNormalizado)
        .neq('id', id);

      if (existError && existError.code !== 'PGRST116') throw existError;
      if (existing && existing.length > 0) {
        const err: any = new Error('El número de teléfono ya está registrado para otro cliente');
        err.status = 400;
        throw err;
      }

      updates.telefono = telNormalizado;
    }

    const { data, error } = await supabaseAdmin
      .from('clientes')
      .update(updates)
      .eq('id', id)
      .eq('org_id', org_id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  static async eliminarCliente(id: string, org_id: string) {
    const { error } = await supabaseAdmin
      .from('clientes')
      .delete()
      .eq('id', id)
      .eq('org_id', org_id);

    if (error) throw error;
  }
}

