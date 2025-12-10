import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';
import { whatsappService } from '../lib/whatsapp';

const r = Router();

// Middleware de seguridad: Usuario autenticado y miembro de la organización
r.use(requireAuth, requireMembership);

// --- 1. LISTAR CLIENTES (Con Filtros y Paginación) ---
r.get('/', async (req: AuthedRequest, res) => {
  try {
    const org_id = (req as any).org_id;
    const { q, limit, offset } = req.query;

    let query = supabaseAdmin
      .from('clientes')
      .select('*', { count: 'exact' })
      .eq('org_id', org_id)
      .order('nombre', { ascending: true });

    // Filtro de búsqueda (Nombre o Teléfono)
    if (q && String(q).trim()) {
      const term = String(q).trim();
      // "ilike" es case-insensitive. Buscamos en ambos campos con OR.
      query = query.or(`nombre.ilike.%${term}%,telefono.ilike.%${term}%`);
    }

    // Paginación
    if (limit && offset) {
      const from = Number(offset);
      const to = from + Number(limit) - 1;
      query = query.range(from, to);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    res.json(data || []);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// --- 2. CREAR CLIENTE ---
r.post('/', async (req: AuthedRequest, res) => {
  try {
    const org_id = (req as any).org_id;
    const { nombre, telefono, email, direccion, permite_whatsapp, frecuencia_recordatorio } = req.body;

    if (!org_id) return res.status(401).json({ error: 'La organización es obligatoria' });

    if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
    console.log('Creando cliente:', req.body);
    

    // validar si el numero de teléfono ya existe para la misma org
    const { data: existing, error: existError } = await supabaseAdmin
      .from('clientes')
      .select('id')
      .eq('org_id', org_id)
      .eq('telefono', telefono)

      console.log('Existing check error:', existError);
      console.log('Existing check data:', existing);
      
    if (existError && existError.code !== 'PGRST116') throw existError; // PGRST116 = no encontrado
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'El número de teléfono ya está registrado para otro cliente' });
    }

    const payload = {
      org_id,
      nombre,
      telefono,
      email,
      direccion,
      permite_whatsapp: permite_whatsapp ?? true,
      frecuencia_recordatorio: frecuencia_recordatorio ?? 15,
      ultima_visita: new Date().toISOString()
    };

    const { data, error } = await supabaseAdmin
      .from('clientes')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// --- 3. ACTUALIZAR CLIENTE ---
r.put('/:id', async (req: AuthedRequest, res) => {
  try {
    const org_id = (req as any).org_id;
    const { id } = req.params;
    
    // Evitamos actualizar campos sensibles como org_id o id
    const { id: _, org_id: __, created_at, ...updates } = req.body;

    const { data, error } = await supabaseAdmin
      .from('clientes')
      .update(updates)
      .eq('id', id)
      .eq('org_id', org_id) // Seguridad extra: solo si pertenece a la org
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// --- 4. ELIMINAR CLIENTE ---
r.delete('/:id', async (req: AuthedRequest, res) => {
  try {
    const org_id = (req as any).org_id;
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('clientes')
      .delete()
      .eq('id', id)
      .eq('org_id', org_id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// --- 5. MENSAJES MASIVOS (Real) ---
r.post('/mass-message', async (req: AuthedRequest, res) => {
  try {
    const org_id = (req as any).org_id;
    const { message } = req.body; // Mensaje personalizado

    if (!message) return res.status(400).json({ error: 'Falta el mensaje' });

    // 1. Buscar destinatarios aptos (WA activo + Teléfono válido)
    const { data: targets, error } = await supabaseAdmin
      .from('clientes')
      .select('id, nombre, telefono')
      .eq('org_id', org_id)
      .eq('permite_whatsapp', true)
      .not('telefono', 'is', null);

    if (error) throw error;
    if (!targets || targets.length === 0) {
      return res.json({ message: 'No hay clientes aptos para envío', count: 0 });
    }

    // 2. Procesar envíos (en segundo plano o esperando, depende del volumen)
    // Para < 50 clientes, podemos esperar. Para más, idealmente usar colas (bullmq).
    // Aquí lo hacemos simple con espera.
    
    let enviados = 0;
    
    for (const cliente of targets) {
      // Personalización básica: Reemplazar [Nombre] por el nombre real
      const personalizedMsg = message.replace('[Nombre]', cliente.nombre.split(' ')[0]);
      
      if (cliente.telefono && cliente.telefono.length > 9) {
        await whatsappService.send(cliente.telefono, personalizedMsg);
        enviados++;
        // Pequeña pausa para no ser marcado como spam inmediato (100ms)
        await new Promise(r => setTimeout(r, 100)); 
      }
    }

    res.json({ 
      ok: true, 
      message: 'Proceso finalizado', 
      total: targets.length, 
      enviados 
    });

  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default r;