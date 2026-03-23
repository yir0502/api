import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny } from 'zod';

export const validateRequest = (schema: ZodTypeAny) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
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
