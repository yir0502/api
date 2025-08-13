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
    fecha: string;         // YYYY-MM-DD
    created_at?: string;
};
type Cat = { id: string; org_id: string; nombre: string; tipo: 'ingreso' | 'egreso'; activo: boolean; };

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
        const include = String(req.query.include || 'mes,recientes').split(',').map(s => s.trim());
        const limitRec = Math.max(1, Math.min(50, Number(req.query.limit_recientes) || 5));

        // rango para la serie (si no envías, usa últimos 30 días)
        const desdeQ = (req.query.desde as string) || (() => { const d = new Date(); d.setDate(d.getDate() - 29); return iso(d); })();
        const hastaQ = (req.query.hasta as string) || todayISO();
        if (!org_id) return res.status(400).json({ error: 'org_id requerido (o configura DEFAULT_ORG_ID)' });
        if (desdeQ > hastaQ) return res.status(400).json({ error: 'rango inválido: desde > hasta' });

        // ===== Cats (para nombres)
        const { data: catsRaw, error: errCat } = await supabaseAdmin
            .from('categorias')
            .select('id, org_id, nombre, tipo, activo')
            .eq('org_id', org_id);
        if (errCat) return res.status(400).json({ error: errCat.message });
        const cats = (catsRaw || []) as Cat[];
        const catMap = new Map<string, Cat>(); cats.forEach(c => catMap.set(c.id, c));

        // ===== Movs del rango para la serie
        const { data: movsRaw, error: errMov } = await supabaseAdmin
            .from('movimientos')
            .select('id, org_id, tipo, monto, categoria_id, fecha')
            .eq('org_id', org_id)
            .gte('fecha', desdeQ)
            .lte('fecha', hastaQ)
            .order('fecha', { ascending: true });
        if (errMov) return res.status(400).json({ error: errMov.message });
        const movs = (movsRaw || []) as Mov[];

        // ===== Agregados de la SERIE
        let ingresos = 0, egresos = 0;
        const byDay = new Map<string, { ingresos: number; egresos: number }>();
        const byCatIngreso = new Map<string, number>();
        const byCatEgreso = new Map<string, number>();
        for (const m of movs) {
            const monto = Number(m.monto) || 0;
            if (m.tipo === 'ingreso') ingresos += monto; else egresos += monto;
            const s = byDay.get(m.fecha) || { ingresos: 0, egresos: 0 };
            if (m.tipo === 'ingreso') s.ingresos += monto; else s.egresos += monto;
            byDay.set(m.fecha, s);
            const key = m.categoria_id || '__none__';
            if (m.tipo === 'ingreso') byCatIngreso.set(key, (byCatIngreso.get(key) || 0) + monto);
            else byCatEgreso.set(key, (byCatEgreso.get(key) || 0) + monto);
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

        // ===== Datos de MES ACTUAL (para KPIs y dona)
        let kpis_mes: { ingresos: number; egresos: number; balance: number } | undefined;
        let por_categoria_mes: { ingreso: any[]; egreso: any[] } | undefined;
        if (include.includes('mes')) {
            const mesDesde = firstDayOfThisMonth();
            const mesHasta = todayISO();
            const { data: movsMesRaw, error: errMes } = await supabaseAdmin
                .from('movimientos')
                .select('id, org_id, tipo, monto, categoria_id, fecha')
                .eq('org_id', org_id).gte('fecha', mesDesde).lte('fecha', mesHasta);
            if (errMes) return res.status(400).json({ error: errMes.message });
            const movsMes = (movsMesRaw || []) as Mov[];
            let ing = 0, egr = 0;
            const byCatIngMes = new Map<string, number>();
            const byCatEgrMes = new Map<string, number>();
            for (const m of movsMes) {
                const monto = Number(m.monto) || 0;
                if (m.tipo === 'ingreso') { ing += monto; byCatIngMes.set(m.categoria_id || '__none__', (byCatIngMes.get(m.categoria_id || '__none__') || 0) + monto); }
                else { egr += monto; byCatEgrMes.set(m.categoria_id || '__none__', (byCatEgrMes.get(m.categoria_id || '__none__') || 0) + monto); }
            }
            kpis_mes = { ingresos: ing, egresos: egr, balance: ing - egr };
            por_categoria_mes = { ingreso: toCatArray(byCatIngMes), egreso: toCatArray(byCatEgrMes) };
        }

        // ===== Últimos movimientos (para sección “Recientes”)
        let recientes: { id: string; tipo: 'ingreso' | 'egreso'; categoria: string; fecha: string; monto: number }[] | undefined;
        if (include.includes('recientes')) {
            const { data: raw, error: errR } = await supabaseAdmin
                .from('movimientos')
                .select('id, org_id, tipo, monto, categoria_id, fecha, created_at')
                .eq('org_id', org_id)
                .order('created_at', { ascending: false })  // 👈 ordenar por creación
                .limit(limitRec);
            if (errR) return res.status(400).json({ error: errR.message });
            const rows = (raw || []) as Mov[];
            recientes = (raw || []).map(m => ({
                id: m.id,
                tipo: m.tipo,
                categoria: m.categoria_id ? (catMap.get(m.categoria_id)?.nombre || 'Sin categoría') : 'Sin categoría',
                fecha: m.created_at ?? (m.fecha + 'T00:00:00'),   // 👈 ISO con hora
                monto: m.tipo === 'egreso' ? -Math.abs(Number(m.monto) || 0) : Math.abs(Number(m.monto) || 0)
            }));
        }

        // ===== Respuesta
        res.json({
            range: { desde: desdeQ, hasta: hastaQ, dias: days.length },
            totales: { ingresos, egresos, balance: ingresos - egresos },
            por_dia: serie,
            por_categoria: { ingreso: toCatArray(byCatIngreso), egreso: toCatArray(byCatEgreso) },
            kpis_mes, por_categoria_mes, recientes,
            meta: { items: movs.length }
        });
    } catch (e: any) {
        res.status(500).json({ error: e?.message || 'server error' });
    }
});

export default r;