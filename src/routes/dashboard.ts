import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../lib/auth';

const r = Router();
r.use(requireAuth);

// Helper de fechas
const iso = (d: Date) => d.toISOString().slice(0, 10);
const firstDayOfThisMonth = () => iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
const todayISO = () => iso(new Date());

function eachDayInclusive(desdeISO: string, hastaISO: string): string[] {
  const out: string[] = [];
  const d = new Date(desdeISO + 'T00:00:00');
  const end = new Date(hastaISO + 'T00:00:00');
  while (d <= end) { out.push(iso(d)); d.setDate(d.getDate() + 1); }
  return out;
}

// Tipos internos para este endpoint
type MovSimple = {
  tipo: 'ingreso' | 'egreso';
  monto: number;
  categoria_id: string | null;
  sucursal_id: string | null;
  fecha: string;
};

r.get('/', async (req, res) => {
  try {
    // 1. Validación y Parámetros
    const org_id = (req.query.org_id as string) || process.env.DEFAULT_ORG_ID!;
    if (!org_id) return res.status(400).json({ error: 'org_id requerido' });

    const include = String(req.query.include || 'mes,recientes').split(',').map(s => s.trim());
    const limitRec = Math.max(1, Math.min(50, Number(req.query.limit_recientes) || 5));

    // Rangos de fecha
    const desdeQ = (req.query.desde as string) || (() => { const d = new Date(); d.setDate(d.getDate() - 29); return iso(d); })();
    const hastaQ = (req.query.hasta as string) || todayISO();

    if (desdeQ > hastaQ) return res.status(400).json({ error: 'rango inválido: desde > hasta' });

    // ============================================================
    // 2. PREPARACIÓN DE PROMESAS (Consultas en Paralelo)
    // ============================================================

    // A. Catálogos: Traemos todo lo activo para mapear nombres en memoria rápidamente (O(1))
    // Esto evita tener que hacer consultas extras dentro de bucles.
    const pCats = supabaseAdmin.from('categorias').select('id, nombre').eq('org_id', org_id);
    const pSucs = supabaseAdmin.from('sucursales').select('id, nombre').eq('org_id', org_id);

    // B. Movimientos del RANGO (Gráfica principal)
    const pMovsRange = supabaseAdmin
      .from('movimientos')
      .select('tipo, monto, categoria_id, sucursal_id, fecha') // Solo columnas necesarias = menos tráfico
      .eq('org_id', org_id)
      .gte('fecha', desdeQ)
      .lte('fecha', hastaQ);

    // C. Movimientos del MES (KPIs y Donas) - Solo si se pide
    let pMovsMes: any = Promise.resolve({ data: [] }); 
    
    if (include.includes('mes')) {
      const mesDesde = firstDayOfThisMonth();
      const mesHasta = todayISO();
      pMovsMes = supabaseAdmin
        .from('movimientos')
        .select('tipo, monto, categoria_id, sucursal_id') 
        .eq('org_id', org_id)
        .gte('fecha', mesDesde)
        .lte('fecha', mesHasta);
    }

    // D. Recientes - Solo si se pide
    let pRecientes: any = Promise.resolve({ data: [] });

    if (include.includes('recientes')) {
      pRecientes = supabaseAdmin
        .from('movimientos')
        .select('id, tipo, monto, categoria_id, fecha')
        .eq('org_id', org_id)
        .order('fecha', { ascending: false })
        .limit(limitRec);
    }
    // ============================================================
    // 3. EJECUCIÓN PARALELA (Await de todo junto) 🔥
    // ============================================================
    const [resCats, resSucs, resMovsRange, resMovsMes, resRecientes] = await Promise.all([
      pCats, pSucs, pMovsRange, pMovsMes, pRecientes
    ]);

    if (resCats.error) throw resCats.error;
    if (resMovsRange.error) throw resMovsRange.error;

    // Mapas para búsqueda rápida de nombres
    const catMap = new Map<string, string>();
    (resCats.data || []).forEach((c: any) => catMap.set(c.id, c.nombre));

    const sucMap = new Map<string, string>();
    (resSucs.data || []).forEach((s: any) => sucMap.set(s.id, s.nombre));

    // ============================================================
    // 4. PROCESAMIENTO EN MEMORIA (Agregaciones)
    // ============================================================

    // --- A. Procesar Rango (Gráfica lineal) ---
    const movsRange = (resMovsRange.data || []) as MovSimple[];
    let ingresos = 0, egresos = 0;
    const byDay = new Map<string, { ingresos: number; egresos: number }>();
    const byCatIngreso = new Map<string, number>();
    const byCatEgreso  = new Map<string, number>();

    for (const m of movsRange) {
      const val = Math.abs(Number(m.monto) || 0);
      const isIngreso = m.tipo === 'ingreso';

      // Totales globales del rango
      if (isIngreso) ingresos += val; else egresos += val;

      // Agrupado por Día
      const d = m.fecha.slice(0, 10); // asegurar YYYY-MM-DD
      const dayNode = byDay.get(d) || { ingresos: 0, egresos: 0 };
      if (isIngreso) dayNode.ingresos += val; else dayNode.egresos += val;
      byDay.set(d, dayNode);

      // Agrupado por Categoría (Rango)
      const catKey = m.categoria_id || 'sin_cat';
      const targetMap = isIngreso ? byCatIngreso : byCatEgreso;
      targetMap.set(catKey, (targetMap.get(catKey) || 0) + val);
    }

    // Rellenar días vacíos para que la gráfica no tenga huecos
    const days = eachDayInclusive(desdeQ, hastaQ);
    const serie = days.map(d => {
      const s = byDay.get(d) || { ingresos: 0, egresos: 0 };
      return { fecha: d, ...s, balance: s.ingresos - s.egresos };
    });

    // Helper para formatear array de categorías con nombres reales
    const formatCats = (map: Map<string, number>) => 
      Array.from(map.entries())
        .map(([id, total]) => ({
          categoria_id: id === 'sin_cat' ? null : id,
          nombre: id === 'sin_cat' ? 'Sin categoría' : (catMap.get(id) || 'Sin categoría'),
          total
        }))
        .sort((a, b) => b.total - a.total);

    // --- B. Procesar Mes Actual (KPIs) ---
    let kpis_mes, por_categoria_mes, por_sucursal_mes;
    
    if (include.includes('mes')) {
      const movsMes = (resMovsMes.data || []) as MovSimple[];
      let ingM = 0, egrM = 0;
      const catIngM = new Map<string, number>();
      const catEgrM = new Map<string, number>();
      const sucM = new Map<string, { ingresos: number; egresos: number }>();

      for (const m of movsMes) {
        const val = Math.abs(Number(m.monto) || 0);
        const isIngreso = m.tipo === 'ingreso';

        // Totales Mes
        if (isIngreso) ingM += val; else egrM += val;

        // Categorías Mes
        const cKey = m.categoria_id || 'sin_cat';
        const cMap = isIngreso ? catIngM : catEgrM;
        cMap.set(cKey, (cMap.get(cKey) || 0) + val);

        // Sucursales Mes
        const sKey = m.sucursal_id || 'sin_suc';
        const sNode = sucM.get(sKey) || { ingresos: 0, egresos: 0 };
        if (isIngreso) sNode.ingresos += val; else sNode.egresos += val;
        sucM.set(sKey, sNode);
      }

      kpis_mes = { ingresos: ingM, egresos: egrM, balance: ingM - egrM };
      por_categoria_mes = { ingreso: formatCats(catIngM), egreso: formatCats(catEgrM) };
      
      // Mapeamos los nombres de sucursales usando el mapa que cargamos al inicio (sin consultas extra)
      por_sucursal_mes = Array.from(sucM.entries())
        .map(([id, v]) => ({
          sucursal_id: id === 'sin_suc' ? null : id,
          nombre: id === 'sin_suc' ? 'Sin sucursal' : (sucMap.get(id) || 'Sin sucursal'),
          ingresos: v.ingresos,
          egresos: v.egresos,
          balance: v.ingresos - v.egresos
        }))
        .sort((a, b) => (b.ingresos + b.egresos) - (a.ingresos + a.egresos));
    }

    // --- C. Procesar Recientes ---
    let recientes;
    if (include.includes('recientes')) {
      recientes = (resRecientes.data || []).map((m: any) => ({
        id: m.id,
        tipo: m.tipo,
        categoria: m.categoria_id ? (catMap.get(m.categoria_id) || 'Sin categoría') : 'Sin categoría',
        fecha: m.fecha + 'T00:00:00', // Formato ISO para compatibilidad
        monto: m.tipo === 'egreso' ? -Math.abs(m.monto) : Math.abs(m.monto)
      }));
    }

    // Respuesta Final
    res.json({
      range: { desde: desdeQ, hasta: hastaQ, dias: days.length },
      totales: { ingresos, egresos, balance: ingresos - egresos },
      por_dia: serie,
      por_categoria: { ingreso: formatCats(byCatIngreso), egreso: formatCats(byCatEgreso) },
      ...(kpis_mes ? { kpis_mes, por_categoria_mes, por_sucursal_mes } : {}),
      ...(recientes ? { recientes } : {}),
      meta: { items: movsRange.length }
    });

  } catch (e: any) {
    console.error('Error dashboard:', e);
    res.status(500).json({ error: e?.message || 'server error' });
  }
});

export default r;