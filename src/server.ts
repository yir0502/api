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

// ─── CORS ───────────────────────────────────────────────────────────────
const DEFAULT_ORIGINS = [
  'http://localhost:4200',
  'https://nano-clean-app.vercel.app',
];
const extraOrigins = process.env.CORS_ORIGIN
  ?.split(',')
  .map((o) => o.trim())
  .filter(Boolean) ?? [];
const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...extraOrigins])];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Permite peticiones sin origen (Postman, curl, apps móviles)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: Origen '${origin}' no permitido`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
};

app.use(compression());
app.use(express.json());
app.use(cors(corsOptions));
// Responder preflight OPTIONS en todas las rutas
app.options('*', cors(corsOptions));

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