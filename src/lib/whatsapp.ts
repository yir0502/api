// src/lib/whatsapp.ts
import 'dotenv/config';

const META_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERSION = 'v19.0'; // Versión estable de la API

export const whatsappService = {
  
  async send(to: string, body: string) {
    // Si no hay credenciales, solo logueamos (modo desarrollo seguro)
    if (!META_TOKEN || !PHONE_ID) {
      console.log(`[SIMULACIÓN WA] Para: ${to} | Mensaje: ${body}`);
      return { simulated: true };
    }

    // Limpieza del número: Meta requiere código de país sin '+' (ej: 52155...)
    // Asegúrate de que tus clientes se guarden con código de país (ej: 52...)
    const cleanNumber = to.replace(/\D/g, ''); 

    try {
      const response = await fetch(`https://graph.facebook.com/${VERSION}/${PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${META_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: cleanNumber,
          type: 'text',
          text: { body: body },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ Error Meta API:', data);
        // No lanzamos error fatal para no detener envíos masivos, pero retornamos null
        return null; 
      }

      return data;

    } catch (error) {
      console.error('Error de red enviando WhatsApp:', error);
      return null;
    }
  }
};