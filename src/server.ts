import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import movimientos from './routes/movimientos';
import categorias from './routes/categorias';
import auth from './routes/auth';
import dashboard from './routes/dashboard';
import sucursales from './routes/sucursales';
import clientes from './routes/clientes';

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*', credentials: false }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/auth', auth);
app.use('/movimientos', movimientos);
app.use('/categorias', categorias);
app.use('/dashboard', dashboard);
app.use('/sucursales', sucursales);
app.use('/clientes', clientes);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API on http://localhost:${port}`));