import { Router, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';
import { escapeLike } from '../lib/validate';
import {
  GuardarRepartoInput,
  RepartoService,
  RepartoValidationError,
} from '../services/reparto.service';

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

function obtenerMensajeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return String(error);
}

r.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const org_id = req.org_id;
    if (!org_id) return res.status(401).json({ error: 'No org' });

    const { activo, q, limit, offset } = req.query as {
      activo?: string;
      q?: string;
      limit?: string;
      offset?: string;
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
      qSuc = qSuc.ilike('nombre', `%${escapeLike(String(q).trim())}%`);
    }

    const rawLim = limit !== undefined ? Number(limit) : undefined;
    const rawOff = offset !== undefined ? Number(offset) : undefined;
    const lim =
      rawLim !== undefined && Number.isFinite(rawLim)
        ? Math.min(Math.max(0, Math.floor(rawLim)), 100)
        : undefined;
    const off =
      rawOff !== undefined && Number.isFinite(rawOff)
        ? Math.max(0, Math.floor(rawOff))
        : undefined;
    if (lim !== undefined && lim > 0 && off !== undefined) {
      qSuc = qSuc.range(off, off + lim - 1);
    }

    const { data, error } = await qSuc;
    if (error) return res.status(400).json({ error: 'No se pudo completar la operación' });

    return res.json((data || []) as Sucursal[]);
  } catch (e: unknown) {
    console.error('Error al listar sucursales:', obtenerMensajeError(e));
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

r.post('/', async (req: AuthedRequest, res: Response) => {
  try {
    const org_id = req.org_id;
    if (!org_id) {
      return res.status(400).json({ error: 'El usuario no pertenece a una organización' });
    }

    const body =
      typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const { nombre, activo } = body;
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: 'nombre requerido' });
    }

    const payload: Partial<Sucursal> = {
      org_id,
      nombre: String(nombre).trim(),
      ...(typeof activo !== 'undefined' ? { activo: !!activo } : {}),
    };

    const { data: existing, error: existError } = await supabaseAdmin
      .from('sucursales')
      .select('id')
      .eq('org_id', org_id)
      .eq('nombre', payload.nombre);

    if (existError) throw existError;
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'Ya existe una sucursal con ese nombre' });
    }

    const { data, error } = await supabaseAdmin
      .from('sucursales')
      .insert(payload)
      .select()
      .single();

    if (error) return res.status(400).json({ error: 'No se pudo completar la operación' });
    return res.json(data);
  } catch (e: unknown) {
    console.error('Error al crear sucursal:', obtenerMensajeError(e));
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

r.get('/:id/reparto', async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = req.org_id;
    if (!orgId) {
      return res.status(401).json({ error: 'Organización no autorizada' });
    }

    const data = await RepartoService.obtenerRepartoPorSucursal(orgId, req.params.id);
    return res.json(data);
  } catch (error: unknown) {
    if (error instanceof RepartoValidationError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error al obtener reparto de sucursal:', obtenerMensajeError(error));
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

r.put('/:id/reparto', async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = req.org_id;
    if (!orgId) {
      return res.status(401).json({ error: 'Organización no autorizada' });
    }

    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'El cuerpo de la configuración de reparto es inválido' });
    }

    const body = req.body as Record<string, unknown>;
    const input: GuardarRepartoInput = {
      capital_pct: body.capital_pct,
      socios: body.socios,
    };

    const data = await RepartoService.guardarRepartoPorSucursal(orgId, req.params.id, input);
    return res.json(data);
  } catch (error: unknown) {
    if (error instanceof RepartoValidationError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error al guardar reparto de sucursal:', obtenerMensajeError(error));
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

r.put('/:id', async (req: AuthedRequest, res: Response) => {
  try {
    const org_id = req.org_id;
    if (!org_id) return res.status(401).json({ error: 'No org' });

    const { id } = req.params;
    const body =
      typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const patch: Partial<Sucursal> = {};
    if ('nombre' in body) patch.nombre = String(body.nombre || '').trim();
    if ('activo' in body) patch.activo = !!body.activo;

    const { data, error } = await supabaseAdmin
      .from('sucursales')
      .update(patch)
      .eq('id', id)
      .eq('org_id', org_id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: 'No se pudo completar la operación' });
    return res.json(data);
  } catch (e: unknown) {
    console.error('Error al actualizar sucursal:', obtenerMensajeError(e));
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

r.delete('/:id', async (req: AuthedRequest, res: Response) => {
  try {
    const org_id = req.org_id;
    if (!org_id) return res.status(401).json({ error: 'No org' });

    const { id } = req.params;
    const { soft } = req.query as { soft?: string };

    if (String(soft) === '1') {
      const { error } = await supabaseAdmin
        .from('sucursales')
        .update({ activo: false })
        .eq('id', id)
        .eq('org_id', org_id);
      if (error) return res.status(400).json({ error: 'No se pudo completar la operación' });
      return res.json({ ok: true, soft: true });
    }

    // Borrado fisico; los movimientos con FK pasan a null cuando el constraint es ON DELETE SET NULL.
    const { error } = await supabaseAdmin
      .from('sucursales')
      .delete()
      .eq('id', id)
      .eq('org_id', org_id);
    if (error) return res.status(400).json({ error: 'No se pudo completar la operación' });

    return res.json({ ok: true });
  } catch (e: unknown) {
    console.error('Error al eliminar sucursal:', obtenerMensajeError(e));
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default r;
