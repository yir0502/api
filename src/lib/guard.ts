import { Response, NextFunction } from 'express';
import { AuthedRequest } from './auth';
import { supabaseAdmin } from './supabase';

export async function requireMembership(req: AuthedRequest, res: Response, next: NextFunction) {
  const orgId = String(req.query.org_id || req.body.org_id || process.env.DEFAULT_ORG_ID || '');
  if (!orgId) return res.status(400).json({ error: 'org_id requerido' });
  if (!req.user?.id) return res.status(401).json({ error: 'No user' });

  const { count, error } = await supabaseAdmin
    .from('organizacion_miembros')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });
  if (!count || count < 1) return res.status(403).json({ error: 'Sin membresía en la organización' });

  // expone org_id normalizado para las rutas
  (req as any).org_id = orgId;
  next();
}