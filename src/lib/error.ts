import { Request, Response, NextFunction } from 'express';

// Wrapper para evitar los try/catch repetitivos en cada ruta asíncrona
export const asyncHandler = (fn: Function) => 
  (req: Request, res: Response, next: NextFunction): Promise<void> => 
    Promise.resolve(fn(req, res, next)).catch(next);

// Interceptor global de errores
export const globalErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  console.error('🔥 [Error Global]:', err);

  const statusCode = err.status || 500;
  
  res.status(statusCode).json({
    error: err.message || 'Error interno del servidor',
    code: err.code || undefined
  });
};
