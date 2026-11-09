import { Response, NextFunction } from 'express';
import { AuthedRequest } from './auth';
import { supabaseAdmin } from './supabase';

export async function requireMembership(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user?.id) return res.status(401).json({ error: 'No user' });

  const solicitado = String(req.query.org_id || req.body.org_id || req.headers['x-org-id'] || '');

  const { data: membresias, error } = await supabaseAdmin
    .from('organizacion_miembros')
    .select('org_id')
    .eq('user_id', req.user.id);

  if (error) {
    console.error('Error al verificar membresía:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }

  const orgIds = (membresias || []).map((m: any) => String(m.org_id));

  if (orgIds.length === 0) return res.status(403).json({ error: 'Usuario sin organización asignada' });

  if (solicitado) {
    if (!orgIds.includes(solicitado)) {
      return res.status(403).json({ error: 'Sin membresía en la organización' });
    }
    req.org_id = solicitado;
    return next();
  }

  if (orgIds.length === 1) {
    req.org_id = orgIds[0];
    return next();
  }

  return res.status(400).json({ error: 'org_id requerido: el usuario pertenece a múltiples organizaciones' });
}
