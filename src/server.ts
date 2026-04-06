import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { globalErrorHandler } from './lib/error';
import { initWhatsAppJobs } from './jobs/whatsapp.job';

import movimientos from './routes/movimientos';
import categorias from './routes/categorias';
import auth from './routes/auth';
import dashboard from './routes/dashboard';
import sucursales from './routes/sucursales';
import clientes from './routes/clientes';
import pedidos from './routes/pedidos';
import rastreo from './routes/rastreo';

const app = express();
app.use(compression());
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*', credentials: false }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/auth', auth);
app.use('/movimientos', movimientos);
app.use('/categorias', categorias);
app.use('/dashboard', dashboard);
app.use('/sucursales', sucursales);
app.use('/clientes', clientes);
app.use('/pedidos', pedidos);
app.use('/rastreo', rastreo);

// Inicializamos las tareas automáticas
initWhatsAppJobs();

// Middleware Global de Errores (debe ir al final de todas las rutas)
app.use(globalErrorHandler);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API on http://localhost:${port}`));