import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';
import { whatsappService } from '../lib/whatsapp';
import { validateRequest } from '../lib/validate';
import { ClienteSchema, ClienteUpdateSchema } from '../lib/schemas';
import { asyncHandler } from '../lib/error';

const r = Router();

// Middleware de seguridad: Usuario autenticado y miembro de la organización
r.use(requireAuth, requireMembership);

// --- 1. LISTAR CLIENTES (Con Filtros y Paginación) ---
r.get('/', asyncHandler(async (req: AuthedRequest, res: any) => {
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
}));

// --- 2. CREAR CLIENTE ---
r.post('/', validateRequest(ClienteSchema), asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = (req as any).org_id;
  const { nombre, telefono, email, direccion, permite_whatsapp, frecuencia_recordatorio } = req.body;

  if (!org_id) return res.status(401).json({ error: 'La organización es obligatoria' });
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });

  // validar si el numero de teléfono ya existe para la misma org
  const { data: existing, error: existError } = await supabaseAdmin
    .from('clientes')
    .select('id')
    .eq('org_id', org_id)
    .eq('telefono', telefono);

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
}));

// --- 3. ACTUALIZAR CLIENTE ---
r.put('/:id', validateRequest(ClienteUpdateSchema), asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = (req as any).org_id;
  const { id } = req.params;
  
  const { id: _, org_id: __, created_at, ...updates } = req.body;

  const { data, error } = await supabaseAdmin
    .from('clientes')
    .update(updates)
    .eq('id', id)
    .eq('org_id', org_id)
    .select()
    .single();

  if (error) throw error;
  res.json(data);
}));

// --- 4. ELIMINAR CLIENTE ---
r.delete('/:id', asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = (req as any).org_id;
  const { id } = req.params;

  const { error } = await supabaseAdmin
    .from('clientes')
    .delete()
    .eq('id', id)
    .eq('org_id', org_id);

  if (error) throw error;
  res.json({ ok: true });
}));

// --- 5. MENSAJES MASIVOS (Real) ---
r.post('/mass-message', asyncHandler(async (req: AuthedRequest, res: any) => {
  const org_id = (req as any).org_id;
  const { message } = req.body;

  if (!message) return res.status(400).json({ error: 'Falta el mensaje' });

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

  let enviados = 0;
  for (const cliente of targets) {
    const personalizedMsg = message.replace('[Nombre]', cliente.nombre.split(' ')[0]);
    if (cliente.telefono && cliente.telefono.length > 9) {
      await whatsappService.send(cliente.telefono, personalizedMsg);
      enviados++;
      await new Promise(r => setTimeout(r, 100)); 
    }
  }

  res.json({ 
    ok: true, 
    message: 'Proceso finalizado', 
    total: targets.length, 
    enviados 
  });
}));

export default r;