import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import movimientos from './routes/movimientos';
import categorias from './routes/categorias';
import auth from './routes/auth';

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*', credentials: true }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/auth', auth);
app.use('/movimientos', movimientos);
app.use('/categorias', categorias);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API on http://localhost:${port}`));