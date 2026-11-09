import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny } from 'zod';

export const escapeLike = (s: string): string =>
  String(s)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/,/g, '\\,')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/"/g, '\\"');

export const validateRequest = (schema: ZodTypeAny) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed: any = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      if (parsed && typeof parsed === 'object') {
        if (parsed.body !== undefined) req.body = parsed.body;
        if (parsed.params !== undefined) req.params = parsed.params;
        if (parsed.query !== undefined) req.query = parsed.query;
      }
      return next();
    } catch (error: any) {
      if (error && error.name === 'ZodError') {
        res.status(400).json({ error: 'Datos de entrada inválidos', details: error.errors || error.issues });
        return;
      }
      res.status(400).json({ error: 'Error de validación inesperado' });
      return;
    }
  };
