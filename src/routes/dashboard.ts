// routes/dashboard.ts
import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth } from '../lib/auth';

const r = Router();
r.use(requireAuth);

type Mov = {
  id: string;
  org_id: string;
  tipo: 'ingreso' | 'egreso';
  monto: number | string;
  categoria_id: string | null;
  sucursal_id?: string | null;
  fecha: string;
  created_at?: string;
};

type Cat = { id: string; org_id: string; nombre: string; tipo: 'ingreso' | 'egreso'; activo: boolean; };
type Suc = { id: string; org_id: string; nombre: string; activo: boolean };

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

r.get('/', async (req, res) => {
  try {
    const org_id = (req.query.org_id as string) || process.env.DEFAULT_ORG_ID!;
    const include = String(req.query.include || 'mes,recientes').split(',').map(s => s.trim()).filter(Boolean);
    const limitRec = Math.max(1, Math.min(50, Number(req.query.limit_recientes) || 5));

    // rango para la serie (si no envías, usa últimos 30 días)
    const desdeQ = (req.query.desde as string) || (() => { const d = new Date(); d.setDate(d.getDate() - 29); return iso(d); })();
    const hastaQ = (req.query.hasta as string) || todayISO();
    if (!org_id) return res.status(400).json({ error: 'org_id requerido (o configura DEFAULT_ORG_ID)' });
    if (desdeQ > hastaQ) return res.status(400).json({ error: 'rango inválido: desde > hasta' });

    // ===== Categorías (para nombres de categoría)
    const { data: catsRaw, error: errCat } = await supabaseAdmin
      .from('categorias')
      .select('id, org_id, nombre, tipo, activo')
      .eq('org_id', org_id);
    if (errCat) return res.status(400).json({ error: errCat.message });
    const cats = (catsRaw || []) as Cat[];
    const catMap = new Map<string, Cat>(); cats.forEach(c => catMap.set(c.id, c));

    // ===== Movimientos del rango para la serie + por_categoria del rango
    const { data: movsRaw, error: errMov } = await supabaseAdmin
      .from('movimientos')
      .select('id, org_id, tipo, monto, categoria_id, sucursal_id, fecha')
      .eq('org_id', org_id)
      .gte('fecha', desdeQ)
      .lte('fecha', hastaQ)
      .order('fecha', { ascending: true });
    if (errMov) return res.status(400).json({ error: errMov.message });
    const movs = (movsRaw || []) as Mov[];

    // ===== Agregados de la SERIE (valor absoluto para sumatorias)
    let ingresos = 0, egresos = 0;
    const byDay = new Map<string, { ingresos: number; egresos: number }>();
    const byCatIngreso = new Map<string, number>();
    const byCatEgreso  = new Map<string, number>();

    for (const m of movs) {
      const montoAbs = Math.abs(Number(m.monto) || 0);
      if (m.tipo === 'ingreso') ingresos += montoAbs; else egresos += montoAbs;

      const s = byDay.get(m.fecha) || { ingresos: 0, egresos: 0 };
      if (m.tipo === 'ingreso') s.ingresos += montoAbs; else s.egresos += montoAbs;
      byDay.set(m.fecha, s);

      const key = m.categoria_id || '__none__';
      if (m.tipo === 'ingreso') byCatIngreso.set(key, (byCatIngreso.get(key) || 0) + montoAbs);
      else                      byCatEgreso.set(key,  (byCatEgreso.get(key)  || 0) + montoAbs);
    }

    const days = eachDayInclusive(desdeQ, hastaQ);
    const serie = days.map(d => {
      const s = byDay.get(d) || { ingresos: 0, egresos: 0 };
      return { fecha: d, ingresos: s.ingresos, egresos: s.egresos, balance: s.ingresos - s.egresos };
    });

    const toCatArray = (map: Map<string, number>) =>
      Array.from(map.entries()).map(([id, total]) => ({
        categoria_id: id === '__none__' ? null : id,
        nombre: id === '__none__' ? 'Sin categoría' : (catMap.get(id)?.nombre || 'Sin categoría'),
        total
      })).sort((a, b) => b.total - a.total);

    // ===== Datos de MES ACTUAL (para KPIs / dona / sucursales)
    let kpis_mes:
      | { ingresos: number; egresos: number; balance: number }
      | undefined;
    let por_categoria_mes:
      | { ingreso: { categoria_id: string | null; nombre: string; total: number }[]
        , egreso:  { categoria_id: string | null; nombre: string; total: number }[] }
      | undefined;
    let por_sucursal_mes:
      | { sucursal_id: string | null; nombre: string; ingresos: number; egresos: number; balance: number }[]
      | undefined;

    if (include.includes('mes')) {
      const mesDesde = firstDayOfThisMonth();
      const mesHasta = todayISO();

      const { data: movsMesRaw, error: errMes } = await supabaseAdmin
        .from('movimientos')
        .select('id, org_id, tipo, monto, categoria_id, sucursal_id, fecha')
        .eq('org_id', org_id).gte('fecha', mesDesde).lte('fecha', mesHasta);
      if (errMes) return res.status(400).json({ error: errMes.message });
      const movsMes = (movsMesRaw || []) as Mov[];

      let ing = 0, egr = 0;
      const byCatIngMes = new Map<string, number>();
      const byCatEgrMes = new Map<string, number>();
      const bySucMes    = new Map<string, { ingresos: number; egresos: number }>();

      // acumular
      for (const m of movsMes) {
        const montoAbs = Math.abs(Number(m.monto) || 0);
        if (m.tipo === 'ingreso') {
          ing += montoAbs;
          byCatIngMes.set(m.categoria_id || '__none__', (byCatIngMes.get(m.categoria_id || '__none__') || 0) + montoAbs);
        } else {
          egr += montoAbs;
          byCatEgrMes.set(m.categoria_id || '__none__', (byCatEgrMes.get(m.categoria_id || '__none__') || 0) + montoAbs);
        }

        const sucKey = m.sucursal_id || '__none__';
        const sucAgg = bySucMes.get(sucKey) || { ingresos: 0, egresos: 0 };
        if (m.tipo === 'ingreso') sucAgg.ingresos += montoAbs;
        else                      sucAgg.egresos  += montoAbs;
        bySucMes.set(sucKey, sucAgg);
      }

      kpis_mes = { ingresos: ing, egresos: egr, balance: ing - egr };
      por_categoria_mes = { ingreso: toCatArray(byCatIngMes), egreso: toCatArray(byCatEgrMes) };

      // nombres de sucursales para el mes (solo si hay ids)
      const sucIds = [...bySucMes.keys()].filter(k => k !== '__none__') as string[];
      let sucMap = new Map<string, string>();
      if (sucIds.length) {
        const { data: sucsRaw, error: errS } = await supabaseAdmin
          .from('sucursales')
          .select('id, org_id, nombre, activo')
          .eq('org_id', org_id)
          .in('id', sucIds);
        if (errS) return res.status(400).json({ error: errS.message });
        const sucs = (sucsRaw || []) as Suc[];
        sucMap = new Map<string, string>(sucs.map(s => [s.id, s.nombre]));
      }

      por_sucursal_mes = Array.from(bySucMes.entries())
        .map(([sucursal_id, v]) => ({
          sucursal_id: sucursal_id === '__none__' ? null : sucursal_id,
          nombre: sucursal_id === '__none__' ? 'Sin sucursal' : (sucMap.get(sucursal_id!) || 'Sin sucursal'),
          ingresos: v.ingresos,
          egresos: v.egresos,
          balance: v.ingresos - v.egresos
        }))
        .sort((a, b) => (b.ingresos + b.egresos) - (a.ingresos + a.egresos)); // opcional: ordenar por volumen
    }

    // ===== Últimos movimientos (para sección “Recientes”)
    let recientes:
      | { id: string; tipo: 'ingreso' | 'egreso'; categoria: string; fecha: string; monto: number }[]
      | undefined;

    if (include.includes('recientes')) {
      const { data: raw, error: errR } = await supabaseAdmin
        .from('movimientos')
        .select('id, org_id, tipo, monto, categoria_id, fecha')
        .eq('org_id', org_id)
        .order('fecha', { ascending: false })
        .limit(limitRec);
      if (errR) return res.status(400).json({ error: errR.message });

      recientes = (raw || []).map((m: Mov) => ({
        id: m.id,
        tipo: m.tipo,
        categoria: m.categoria_id ? (catMap.get(m.categoria_id)?.nombre || 'Sin categoría') : 'Sin categoría',
        fecha: m.fecha + 'T00:00:00',
        // Para la sección de "recientes" mostramos el signo: negativo si egreso.
        monto: m.tipo === 'egreso' ? -Math.abs(Number(m.monto) || 0) : Math.abs(Number(m.monto) || 0)
      }));
    }

    // ===== Respuesta final
    res.json({
      range: { desde: desdeQ, hasta: hastaQ, dias: days.length },
      totales: { ingresos, egresos, balance: ingresos - egresos },
      por_dia: serie,
      por_categoria: { ingreso: toCatArray(byCatIngreso), egreso: toCatArray(byCatEgreso) },
      ...(include.includes('mes') ? { kpis_mes, por_categoria_mes, por_sucursal_mes } : {}),
      ...(include.includes('recientes') ? { recientes } : {}),
      meta: { items: movs.length }
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server error' });
  }
});

export default r;