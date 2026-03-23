import cron from 'node-cron';
import { supabaseAdmin } from '../lib/supabase';
import { whatsappService } from '../lib/whatsapp';

export const initWhatsAppJobs = () => {
  // Ejecutar todos los días a las 9 AM
  cron.schedule('0 9 * * *', async () => {
    console.log('[CRON] Iniciando envío de recordatorios diarios...');
    try {
      // 1. Obtener todos los clientes activos para WhatsApp
      const { data: clientes, error } = await supabaseAdmin
        .from('clientes')
        .select('*')
        .eq('permite_whatsapp', true)
        .not('telefono', 'is', null);

      if (error) {
        console.error('❌ Error buscando clientes para cron:', error);
        return;
      }

      if (!clientes || clientes.length === 0) {
        console.log('No hay clientes inscritos para recordatorios.');
        return;
      }

      const hoy = new Date();
      let enviados = 0;

      // 2. Filtrar y enviar basado en frecuencia y última visita
      for (const c of clientes) {
        if (!c.ultima_visita || !c.frecuencia_recordatorio) continue;

        const ultimaVisita = new Date(c.ultima_visita);
        const diasPasados = Math.floor((hoy.getTime() - ultimaVisita.getTime()) / (1000 * 60 * 60 * 24));

        // Enviamos si han pasado exactamente los días de frecuencia (ej. cada 15, 30, 45 días)
        if (diasPasados > 0 && diasPasados % c.frecuencia_recordatorio === 0) {
          const firstName = c.nombre.split(' ')[0];
          const msg = `🤖 Hola ${firstName}! Te recordamos que ya es tiempo para agendar tu próximo servicio. ¡Te esperamos pronto en Nano Clean!`;
          
          console.log(` -> Enviando recordatorio a ${c.nombre} (${c.telefono})...`);
          
          const res = await whatsappService.send(c.telefono, msg);
          
          if (res) {
            enviados++;
          }
          // Pequeña pausa para no saturar la API de Meta
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      console.log(`[CRON] Proceso finalizado exitosamente. ${enviados} recordatorios enviados.`);

    } catch (err) {
      console.error('❌ [CRON] Error crítico:', err);
    }
  });
};
