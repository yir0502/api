export type WhatsappProvider = 'evolution' | 'ultramsg' | 'generic';

export type EventoWhatsappPedido = 'recibido' | 'listo' | 'entregado';

export interface NotificacionPedidoPayload {
  orgId: string;
  folio: string;
  estado: EventoWhatsappPedido;
  clienteNombre: string;
  clienteTelefono: string;
  permiteWhatsapp?: boolean;
  montoTotal: number;
  saldoPendiente: number;
}

export interface ResultadoEnvioWhatsapp {
  enviado: boolean;
  proveedor: WhatsappProvider | 'none';
  motivo?: string;
}

export class WhatsappService {
  static isConfigured(): boolean {
    return Boolean(process.env.WHATSAPP_WEBHOOK_URL?.trim());
  }

  static detectarProveedor(webhookUrl: string): WhatsappProvider {
    const explicit = process.env.WHATSAPP_PROVIDER?.trim().toLowerCase();
    if (explicit === 'evolution' || explicit === 'ultramsg' || explicit === 'generic') {
      return explicit;
    }
    const lowerUrl = webhookUrl.toLowerCase();
    if (lowerUrl.includes('/message/sendtext') || lowerUrl.includes('evolution')) {
      return 'evolution';
    }
    if (lowerUrl.includes('ultramsg.com')) {
      return 'ultramsg';
    }
    return 'generic';
  }

  static normalizarTelefono(telefono: string): string | null {
    const digits = telefono.replace(/\D/g, '');
    if (digits.length < 10) return null;
    // Numeros nacionales de 10 digitos en Mexico requieren prefijo internacional 52
    if (digits.length === 10) {
      return `52${digits}`;
    }
    return digits;
  }

  static construirUrlRastreo(orgId: string, folio: string): string {
    const base = (process.env.APP_PUBLIC_URL || 'https://nano-clean-app.vercel.app').replace(/\/+$/, '');
    return orgId ? `${base}/rastreo/${orgId}/${folio}` : `${base}/rastreo/${folio}`;
  }

  static construirMensaje(payload: NotificacionPedidoPayload): string {
    const urlRastreo = this.construirUrlRastreo(payload.orgId, payload.folio);
    const totalStr = `$${Number(payload.montoTotal || 0).toFixed(2)}`;
    const saldo = Number(payload.saldoPendiente || 0);
    const saldoStr = `$${saldo.toFixed(2)}`;

    switch (payload.estado) {
      case 'recibido': {
        const resumenMonto =
          Number(payload.montoTotal) > 0
            ? `\nTotal: *${totalStr}* | Saldo pendiente: *${saldoStr}*`
            : '\nMonto pendiente por confirmar al pesar tus prendas.';
        return (
          `Hola *${payload.clienteNombre}*\n\n` +
          `Tu pedido *${payload.folio}* ha sido recibido en Lavandería Nano Clean.${resumenMonto}\n\n` +
          `Consulta estatus, saldo y evidencia fotográfica aquí:\n${urlRastreo}\n\n` +
          `Gracias por tu confianza.`
        );
      }
      case 'listo': {
        const lineaSaldo =
          saldo > 0
            ? `Saldo pendiente al recoger: *${saldoStr}* (Total: ${totalStr}).`
            : `Tu pedido ya se encuentra *pagado en su totalidad* (${totalStr}).`;
        return (
          `Hola *${payload.clienteNombre}*\n\n` +
          `Tu pedido *${payload.folio}* ya está *LISTO* para entrega en Lavandería Nano Clean.\n` +
          `${lineaSaldo}\n\n` +
          `Detalles y seguimiento:\n${urlRastreo}\n\n` +
          `Puedes pasar a recogerlo en horario de sucursal o solicitar entrega a domicilio.`
        );
      }
      case 'entregado':
        return (
          `Hola *${payload.clienteNombre}*\n\n` +
          `Confirmamos la entrega de tu pedido *${payload.folio}* en Lavandería Nano Clean.\n\n` +
          `Gracias por tu preferencia.`
        );
    }
  }

  static async enviarTexto(
    telefono: string,
    mensaje: string,
    meta?: { orgId: string; folio: string; evento: EventoWhatsappPedido }
  ): Promise<ResultadoEnvioWhatsapp> {
    const webhookUrl = process.env.WHATSAPP_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      return { enviado: false, proveedor: 'none', motivo: 'webhook_no_configurado' };
    }

    const numeroLimpio = this.normalizarTelefono(telefono);
    if (!numeroLimpio) {
      return { enviado: false, proveedor: 'none', motivo: 'telefono_invalido' };
    }

    const proveedor = this.detectarProveedor(webhookUrl);
    const apiKey = process.env.WHATSAPP_API_KEY?.trim() || '';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    let bodyPayload: Record<string, unknown>;

    if (proveedor === 'evolution') {
      if (apiKey) headers['apikey'] = apiKey;
      bodyPayload = {
        number: numeroLimpio,
        text: mensaje,
      };
    } else if (proveedor === 'ultramsg') {
      bodyPayload = {
        token: apiKey,
        to: `+${numeroLimpio}`,
        body: mensaje,
      };
    } else {
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['x-api-key'] = apiKey;
      }
      bodyPayload = {
        phone: numeroLimpio,
        to: numeroLimpio,
        number: numeroLimpio,
        message: mensaje,
        text: mensaje,
        org_id: meta?.orgId,
        folio: meta?.folio,
        event: meta?.evento,
      };
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        console.warn(`[whatsapp] Proveedor ${proveedor} respondio HTTP ${response.status}: ${errText.slice(0, 200)}`);
        return { enviado: false, proveedor, motivo: `http_${response.status}` };
      }

      return { enviado: true, proveedor };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[whatsapp] Error de red enviando notificacion a ${numeroLimpio}: ${msg}`);
      return { enviado: false, proveedor, motivo: 'error_red' };
    }
  }

  static async notificarPedido(payload: NotificacionPedidoPayload): Promise<ResultadoEnvioWhatsapp> {
    if (payload.permiteWhatsapp === false) {
      return { enviado: false, proveedor: 'none', motivo: 'cliente_bloqueo_whatsapp' };
    }
    if (!payload.clienteTelefono) {
      return { enviado: false, proveedor: 'none', motivo: 'sin_telefono' };
    }
    if (payload.estado === 'entregado' && process.env.WHATSAPP_NOTIFY_DELIVERED !== 'true') {
      return { enviado: false, proveedor: 'none', motivo: 'evento_entregado_omitido' };
    }

    const mensaje = this.construirMensaje(payload);
    return this.enviarTexto(payload.clienteTelefono, mensaje, {
      orgId: payload.orgId,
      folio: payload.folio,
      evento: payload.estado,
    });
  }
}
