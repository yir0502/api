import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';

// Inicialización del Router de Express
const r = Router();

// Aplica middlewares de autenticación y membresía a todas las rutas de clientes
r.use(requireAuth, requireMembership);

// -----------------------------------------------------------
// GET /clientes?org_id
// -----------------------------------------------------------
r.get('/', async (req: AuthedRequest, res) => {
    console.log('GET /clientes', req.query);

    // Lógica para determinar el org_id (desde el usuario, query, o fallback de dev)
    const org_id =
        (req as any).user?.org_id ||
        (req.query.org_id as string) || // permite ?org_id=...
        process.env.DEFAULT_ORG_ID; // fallback de dev

    if (!org_id) return res.status(401).json({ error: 'No org' });

    // Consulta a Supabase: selecciona todos los clientes de la organización
    const { data, error } = await supabaseAdmin
        .from('clientes')
        .select('*')
        .eq('org_id', org_id)
        .order('nombre', { ascending: true }); // Ordena por nombre para mejor usabilidad

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
});

// -----------------------------------------------------------
// POST /clientes { nombre, email, telefono, org_id? }
// -----------------------------------------------------------
r.post('/', async (req: AuthedRequest, res) => {
    // Obtiene el org_id del cuerpo o del usuario autenticado
    const org_id = (req.body.org_id as string) || (req as any).user?.org_id;
    const { nombre } = req.body || {};

    if (!nombre) return res.status(400).json({ error: 'El nombre del cliente es requerido' });
    if (!org_id) return res.status(401).json({ error: 'No org' });

    // Inserta el nuevo cliente en Supabase
    const { data, error } = await supabaseAdmin
        .from('clientes')
        .insert([{ ...req.body, org_id }])
        .select()
        .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
});

// -----------------------------------------------------------
// PUT /clientes/:id
// -----------------------------------------------------------
r.put('/:id', async (req: AuthedRequest, res) => {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
        .from('clientes')
        .update(req.body)
        .eq('id', id)
        .select()
        .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
});

// -----------------------------------------------------------
// DELETE /clientes/:id
// -----------------------------------------------------------
r.delete('/:id', async (req: AuthedRequest, res) => {
    console.log('DELETE /clientes/:id', req.params);

    const { id } = req.params;
    const { error } = await supabaseAdmin
        .from('clientes')
        .delete()
        .eq('id', id); // Asume que el RLS en Supabase o un trigger verificará el org_id

    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
});

export default r;