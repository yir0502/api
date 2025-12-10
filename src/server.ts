import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { supabaseAdmin } from './lib/supabase';
import { whatsappService } from './lib/whatsapp';

import movimientos from './routes/movimientos';
import categorias from './routes/categorias';
import auth from './routes/auth';
import dashboard from './routes/dashboard';
import sucursales from './routes/sucursales';
import clientes from './routes/clientes';
import pedidos from './routes/pedidos';
import rastreo from './routes/rastreo';

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
app.use('/pedidos', pedidos);
app.use('/pedidos', pedidos);
app.use('/rastreo', rastreo);

cron.schedule('0 9 * * *', async () => {
  // ⚠️ IMPORTANTE: Pon aquí tu número tal cual está en la base de datos
  // (incluyendo el código de país si lo guardaste así, ej: '521...')
  const MI_NUMERO_DE_PRUEBA = '522227342492'; 

  try {
    // 1. Buscamos SOLAMENTE a tu usuario de prueba
    const { data: clientes, error } = await supabaseAdmin
      .from('clientes')
      .select('*')
      .eq('telefono', MI_NUMERO_DE_PRUEBA);

    if (error) {
      console.error('❌ Error buscando cliente prueba:', error);
      return;
    }

    if (!clientes || clientes.length === 0) {
      console.log(`⚠️ No encontré al cliente con teléfono: ${MI_NUMERO_DE_PRUEBA}`);
      return;
    }

    // 2. Forzamos el envío (ignoramos la fecha de última visita para la prueba)
    for (const c of clientes) {
      const msg = `🤖 Hola ${c.nombre}! Esta es una prueba automática del sistema. Hora servidor: ${new Date().toLocaleTimeString()}`;
      
      console.log(` -> Intentando enviar a ${c.nombre} (${c.telefono})...`);
      
      const res = await whatsappService.send(c.telefono, msg);
      
      if (res) {
        console.log(`✅ ¡Éxito! Mensaje enviado.`);
      } else {
        console.log(`❌ Falló el envío (revisa credenciales de Meta).`);
      }
    }

  } catch (err) {
    console.error('❌ [CRON] Error crítico:', err);
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API on http://localhost:${port}`));