import { Router } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';
import { requireMembership } from '../lib/guard';

const r = Router();

// Configuración de Multer (Manejo de archivos en memoria RAM temporalmente)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // Límite de 5MB por foto
});

// Middleware de seguridad general
r.use(requireAuth);

// --- UTILIDADES ---

// Generador de Folio Aleatorio (Ej: "A-9X23")
function generarFolio() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sin I, 1, O, 0 para evitar confusión
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Prefijo opcional, puedes cambiarlo o quitarlo
  return `LAV-${result}`; 
}

// --- RUTAS ---

// 1. LISTAR PEDIDOS (Activos o Historial)
r.get('/', requireMembership, async (req: AuthedRequest, res) => {
  try {
    const org_id = (req as any).org_id;
    const { activo, q, limit, offset } = req.query;

    let query = supabaseAdmin
      .from('pedidos')
      .select('*, clientes(nombre, telefono), sucursales(nombre)', { count: 'exact' })
      .eq('org_id', org_id)
      .order('created_at', { ascending: false });

    // Filtro: Activos vs Historial
    if (activo === 'true') {
      query = query.in('estado', ['recibido', 'lavando', 'listo']);
    } else if (activo === 'false') {
      query = query.in('estado', ['entregado', 'cancelado']);
    }

    // Buscador
    if (q) {
      query = query.ilike('folio', `%${q}%`);
    }

    // Paginación
    if (limit && offset) {
      query = query.range(Number(offset), Number(offset) + Number(limit) - 1);
    }
    
    // Cantidad específica (si envías limit sin offset)
    if (limit && !offset) {
       query = query.limit(Number(limit));
    }

    const { data, error, count } = await query;
    if (error) throw error;

    // Aplanar respuesta para el frontend
    const result = data.map((p: any) => ({
      ...p,
      cliente_nombre: p.clientes?.nombre || 'Cliente Manual',
      cliente_telefono: p.clientes?.telefono || '',
      // 👇 CAMBIO 2: Mapeamos el nombre de la sucursal
      sucursal_nombre: p.sucursales?.nombre || 'Sin sucursal'
    }));

    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// 2. CREAR PEDIDO
r.post('/', requireMembership, async (req: AuthedRequest, res) => {
  try {
    const org_id = (req as any).org_id;
    const { cliente_id, descripcion, fecha_entrega_estimada, monto_total, sucursal_id } = req.body;

    // Generar un folio único
    const folio = generarFolio();

    const payload = {
      org_id,
      folio,
      cliente_id,
      descripcion,
      fecha_entrega_estimada,
      monto_total,
      saldo_pendiente: monto_total,
      sucursal_id,
      estado: 'recibido' // Estado inicial
    };

    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// 3. ACTUALIZAR ESTADO O INFORMACIÓN
r.put('/:id', requireMembership, async (req: AuthedRequest, res) => {
  try {
    const { id } = req.params;
    const { estado, saldo_pendiente, fecha_entrega_estimada, sucursal_id } = req.body;

    const updates: any = {};
    if (estado) updates.estado = estado;
    if (saldo_pendiente !== undefined) updates.saldo_pendiente = saldo_pendiente;
    if (fecha_entrega_estimada) updates.fecha_entrega_estimada = fecha_entrega_estimada;
    if (sucursal_id) updates.sucursal_id = sucursal_id;

    // Si se marca como entregado, guardamos la fecha real
    if (estado === 'entregado') {
      updates.fecha_entregado = new Date().toISOString();
    }

    const { data, error } = await supabaseAdmin
      .from('pedidos')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// 4. SUBIR EVIDENCIA (FOTO) 📸
// Nota: Usamos 'upload.single' para procesar 1 archivo llamado 'foto'
r.post('/:id/evidencia', requireMembership, upload.single('foto'), async (req: any, res: any) => {
  try {
    const { id } = req.params; // ID del Pedido
    const file = req.file;
    const { tipo, nota } = req.body; // 'ingreso' o 'entrega'

    if (!file) return res.status(400).json({ error: 'No se subió ningún archivo' });

    // 1. Subir a Supabase Storage
    const fileExt = file.originalname.split('.').pop();
    const fileName = `${id}/${Date.now()}.${fileExt}`; // Estructura: pedido_id/timestamp.jpg

    const { data: uploadData, error: uploadError } = await supabaseAdmin
      .storage
      .from('evidencias')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (uploadError) throw uploadError;

    // 2. Obtener URL Pública
    const { data: { publicUrl } } = supabaseAdmin
      .storage
      .from('evidencias')
      .getPublicUrl(fileName);

    // 3. Guardar referencia en base de datos
    const { data: dbData, error: dbError } = await supabaseAdmin
      .from('pedido_evidencias')
      .insert({
        pedido_id: id,
        url: publicUrl,
        tipo: tipo || 'ingreso',
        nota: nota || ''
      })
      .select()
      .single();

    if (dbError) throw dbError;

    res.status(201).json(dbData);

  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 5. OBTENER EVIDENCIAS DE UN PEDIDO
r.get('/:id/evidencia', requireMembership, async (req: AuthedRequest, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('pedido_evidencias')
      .select('*')
      .eq('pedido_id', id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// 6. ELIMINAR PEDIDO
r.delete('/:id', requireMembership, async (req: AuthedRequest, res) => {
  try {
    const { id } = req.params;
    
    // Eliminamos el pedido (la base de datos se encargará de borrar 
    // las evidencias en cascada si configuraste "ON DELETE CASCADE")
    const { error } = await supabaseAdmin
      .from('pedidos')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

r.delete('/:id/evidencia/:evidenciaId', requireMembership, async (req: AuthedRequest, res) => {
  try {
    const { id, evidenciaId } = req.params;

    // 1. Obtener la evidencia para saber qué archivo borrar
    const { data: evidencia, error: findError } = await supabaseAdmin
      .from('pedido_evidencias')
      .select('url')
      .eq('id', evidenciaId)
      .eq('pedido_id', id)
      .single();

    if (findError || !evidencia) return res.status(404).json({ error: 'Evidencia no encontrada' });

    // 2. Intentar borrar del Storage (Limpieza)
    // La URL pública suele ser: .../storage/v1/object/public/evidencias/CARPETA/ARCHIVO.jpg
    // Necesitamos extraer la ruta relativa: "CARPETA/ARCHIVO.jpg"
    try {
      // Hacemos split por el nombre del bucket ("evidencias")
      const urlParts = evidencia.url.split('/evidencias/');
      if (urlParts.length > 1) {
        const path = urlParts[1]; // Esto nos da "pedido_id/timestamp.jpg"
        await supabaseAdmin.storage.from('evidencias').remove([path]);
      }
    } catch (err) {
      console.warn('No se pudo borrar el archivo físico, pero continuamos con la BD:', err);
    }

    // 3. Borrar el registro de la Base de Datos
    const { error: deleteError } = await supabaseAdmin
      .from('pedido_evidencias')
      .delete()
      .eq('id', evidenciaId);

    if (deleteError) throw deleteError;

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default r;