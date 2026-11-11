import { Router } from 'express';
import { createEphemeralAnonClient, supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';

const r = Router();

r.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email y password requeridos' });

    const authClient = createEphemeralAnonClient();
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error) {
        console.error('Error de autenticacion:', error);
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const user = data.user;
    let orgIds: string[] = [];

    if (user) {
        // Usa supabaseAdmin porque RLS restringe lectura directa en organizacion_miembros
        const { data: memberData, error: memberError } = await supabaseAdmin
            .from('organizacion_miembros')
            .select('org_id')
            .eq('user_id', user.id);

        if (memberError) {
            console.error('Error al obtener org_ids:', memberError);
        } else if (memberData) {
            orgIds = memberData
                .map((m: { org_id: string | null }) => m.org_id)
                .filter((id): id is string => Boolean(id));
        }
    }

    return res.json({
        access_token: data.session?.access_token,
        user: user ? { id: user.id, email: user.email } : user,
        org_id: orgIds[0] || null,
        org_ids: orgIds
    });
});

r.get('/me', requireAuth, requireMembership, (req: AuthedRequest, res) => {
    return res.json({
        user: req.user || null,
        org_id: req.org_id || null
    });
});

export default r;