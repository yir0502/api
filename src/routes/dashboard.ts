import { Router, Response } from 'express';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';
import {
  DashboardService,
  DashboardValidationError,
} from '../services/dashboard.service';

const r = Router();
r.use(requireAuth, requireMembership);

r.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const orgId = req.org_id;
    if (!orgId) {
      return res.status(401).json({ error: 'Organización no autorizada' });
    }

    const data = await DashboardService.obtenerDashboard(orgId, {
      desde: req.query.desde,
      hasta: req.query.hasta,
      include: req.query.include,
      limit_recientes: req.query.limit_recientes,
      sucursal_id: req.query.sucursal_id,
    });

    return res.json(data);
  } catch (error: unknown) {
    if (error instanceof DashboardValidationError) {
      return res.status(error.status).json({ error: error.message });
    }

    console.error('Error dashboard:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default r;
