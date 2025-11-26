import { Router } from 'express';
import { supabaseAnon } from '../lib/supabase';

const r = Router();

// POST /auth/login { email, password }
r.post('/login', async (req, res) => {
    console.log('nuevo inicio de sesiion:', req.body);
    
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email y password requeridos' });

    // 1. Iniciar sesión con Supabase
    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });

    const user = data.user;
    
    // **2. Obtener el org_id de la tabla organizacion_miembros**
    let orgId = null;

    if (user) {
        // Ejecutar la consulta en la tabla 'organizacion_miembros'
        const { data: memberData, error: memberError } = await supabaseAnon
            .from('organizacion_miembros')
            .select('org_id') // Selecciona solo la columna org_id
            .eq('user_id', user.id) // Filtra por el ID del usuario
            .limit(1) // Asume que un usuario solo pertenece a una organización (o toma la primera)
            .single(); // Espera un único registro

        if (memberError && memberError.code !== 'PGRST116') { // 'PGRST116' es para No Rows
            console.error('Error al obtener org_id:', memberError);
            // Puedes decidir si este error debe impedir el login o si solo no se devuelve el org_id
            // Por ahora, solo se registra el error y se continúa.
        } else if (memberData) {
            orgId = memberData.org_id;
        }
    }

    // 3. Devolver la respuesta con el access_token, user y el org_id
    return res.json({
        access_token: data.session?.access_token,
        user: user,
        org_id: orgId // Agregamos la información de la organización
    });
});

export default r;