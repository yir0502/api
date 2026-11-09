import { Router } from 'express';
import { supabaseAnon } from '../lib/supabase';

const r = Router();

// POST /auth/login { email, password }
r.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email y password requeridos' });

    // 1. Iniciar sesión con Supabase
    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
    if (error) {
        console.error('Error de autenticación:', error);
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const user = data.user;

    // **2. Obtener todas las organizaciones del usuario**
    let orgIds: string[] = [];

    if (user) {
        const { data: memberData, error: memberError } = await supabaseAnon
            .from('organizacion_miembros')
            .select('org_id')
            .eq('user_id', user.id);

        if (memberError) {
            console.error('Error al obtener org_ids:', memberError);
        } else if (memberData) {
            orgIds = memberData
                .map((m: any) => m.org_id)
                .filter((id: any): id is string => Boolean(id));
        }
    }

    // 3. Devolver la respuesta con el access_token, user mínimo y las organizaciones
    return res.json({
        access_token: data.session?.access_token,
        user: user ? { id: user.id, email: user.email } : user,
        org_id: orgIds[0] || null,
        org_ids: orgIds
    });
});

export default r;