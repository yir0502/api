import { Request, Response, NextFunction } from 'express';
import { supabaseAnon } from './supabase';

export type AuthedRequest = Request & { user?: { id: string; email?: string } };

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'No token' });

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' });

  req.user = { id: data.user.id, email: data.user.email ?? undefined };
  next();
}