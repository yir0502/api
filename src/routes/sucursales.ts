// routes/sucursales.ts
import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';

const r = Router();
r.use(requireAuth, requireMembership);

type Sucursal = {
    id: string;
    org_id: string;
    nombre: string;
    activo: boolean;
    created_at?: string;
    updated_at?: string;
};

// GET /sucursales?activo=1&q=cent&limit=20&offset=0
r.get('/', async (req: AuthedRequest, res) => {
    try {
        const org_id = (req as any).org_id as string;

        if (!org_id) return res.status(401).json({ error: 'No org' });


        const { activo, q, limit, offset } = req.query as {
            activo?: string; q?: string; limit?: string; offset?: string;
        };

        let qSuc = supabaseAdmin
            .from('sucursales')
            .select('id, nombre, activo, created_at, updated_at')
            .eq('org_id', org_id)
            .order('nombre', { ascending: true });

        if (typeof activo !== 'undefined') {
            const val = ['1', 'true', 'TRUE', 'True'].includes(String(activo));
            qSuc = qSuc.eq('activo', val);
        }

        if (q && String(q).trim()) {
            // búsqueda por nombre (ilike)
            qSuc = qSuc.ilike('nombre', `%${String(q).trim()}%`);
        }

        const lim = limit ? Number(limit) : undefined;
        const off = offset ? Number(offset) : undefined;
        if (lim !== undefined && off !== undefined) {
            qSuc = qSuc.range(off, off + lim - 1);
        }

        const { data, error } = await qSuc;
        if (error) return res.status(400).json({ error: error.message });

        res.json((data || []) as Sucursal[]);
    } catch (e: any) {
        res.status(500).json({ error: e?.message || 'server error' });
    }
});

// POST /sucursales  { nombre, activo? }
r.post('/', async (req, res) => {
    try {
        const org_id = (req as any)?.org_id;
        if (!org_id) return res.status(400).json({ error: 'El usuario no pertenece a una organización' });

        const { nombre, activo } = req.body || {};
        if (!nombre || !String(nombre).trim()) {
            return res.status(400).json({ error: 'nombre requerido' });
        }

        const payload: Partial<Sucursal> = {
            org_id,
            nombre: String(nombre).trim(),
            ...(typeof activo !== 'undefined' ? { activo: !!activo } : {})
        };

        const { data, error } = await supabaseAdmin
            .from('sucursales')
            .insert(payload)
            .select()
            .single();

        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e: any) {
        res.status(500).json({ error: e?.message || 'server error' });
    }
});

// PUT /sucursales/:id  { nombre?, activo? }
r.put('/:id', async (req, res) => {
    try {
        const org_id = (req as any).user?.org_id;
        if (!org_id) return res.status(401).json({ error: 'No org' });

        const { id } = req.params;
        const patch: Partial<Sucursal> = {};
        if ('nombre' in req.body) patch.nombre = String(req.body.nombre || '').trim();
        if ('activo' in req.body) patch.activo = !!req.body.activo;

        const { data, error } = await supabaseAdmin
            .from('sucursales')
            .update(patch)
            .eq('id', id)
            .eq('org_id', org_id)
            .select()
            .single();

        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e: any) {
        res.status(500).json({ error: e?.message || 'server error' });
    }
});

// DELETE /sucursales/:id[?soft=1]
r.delete('/:id', async (req: AuthedRequest, res) => {
    try {
        const { id } = req.params;
        const { soft } = req.query as { soft?: string };

        if (String(soft) === '1') {
            // "archivar": activo = false
            const { error } = await supabaseAdmin
                .from('sucursales')
                .update({ activo: false })
                .eq('id', id)
            if (error) return res.status(400).json({ error: error.message });
            return res.json({ ok: true, soft: true });
        }

        // delete duro (si hay movimientos con FK, quedarán en null si el FK es ON DELETE SET NULL)
        const { error } = await supabaseAdmin
            .from('sucursales')
            .delete()
            .eq('id', id)
        if (error) return res.status(400).json({ error: error.message });

        res.json({ ok: true });
    } catch (e: any) {
        res.status(500).json({ error: e?.message || 'server error' });
    }
});

export default r;