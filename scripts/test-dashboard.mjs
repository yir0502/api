import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

// Dummy env vars must exist before importing dist/lib/supabase.js
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
process.env.SUPABASE_ANON_KEY = 'dummy-anon-key';

const supabaseMod = await import('../dist/lib/supabase.js');
const dashboardServiceMod = await import('../dist/services/dashboard.service.js');
const dashboardRouteMod = await import('../dist/routes/dashboard.js');
const errorMod = await import('../dist/lib/error.js');

const supabaseAdmin = supabaseMod.supabaseAdmin ?? supabaseMod.default.supabaseAdmin;
const supabaseAnon = supabaseMod.supabaseAnon ?? supabaseMod.default.supabaseAnon;
const DashboardService =
  dashboardServiceMod.DashboardService ?? dashboardServiceMod.default.DashboardService;
const DashboardValidationError =
  dashboardServiceMod.DashboardValidationError ?? dashboardServiceMod.default.DashboardValidationError;
const normalizarLimitRecientes =
  dashboardServiceMod.normalizarLimitRecientes ?? dashboardServiceMod.default.normalizarLimitRecientes;
const obtenerHoyLocalISO =
  dashboardServiceMod.obtenerHoyLocalISO ?? dashboardServiceMod.default.obtenerHoyLocalISO;
const dashboardRouter = dashboardRouteMod.default?.default ?? dashboardRouteMod.default;
const globalErrorHandler = errorMod.globalErrorHandler ?? errorMod.default.globalErrorHandler;

const ORG_A = 'org-alpha-1111';
const ORG_B = 'org-beta-2222';
const USER_A = { id: 'user-qa-dash-1', email: 'qa-dash@nanoclean.local' };
const POSTGREST_MAX_ROWS = 1000;
const REF_DATE = new Date(2026, 4, 20, 12, 0, 0);

const dbState = {
  categorias: [],
  sucursales: [],
  movimientos: [],
  pedidos: [],
  membresias: [],
  injectedError: null,
  queryLog: [],
};

function projectRow(row, selectCols) {
  if (!selectCols || selectCols.trim() === '*') {
    return { ...row };
  }
  const cols = selectCols
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const projected = {};
  for (const col of cols) {
    projected[col] = col in row ? row[col] : undefined;
  }
  return projected;
}

function getTableSource(tableName) {
  if (tableName === 'movimientos') return dbState.movimientos;
  if (tableName === 'categorias') return dbState.categorias;
  if (tableName === 'sucursales') return dbState.sucursales;
  if (tableName === 'pedidos') return dbState.pedidos;
  if (tableName === 'organizacion_miembros') return dbState.membresias;
  return [];
}

function createSupabaseBuilder(tableName) {
  const state = {
    table: tableName,
    selectCols: null,
    eqFilters: [],
    gteFilters: [],
    lteFilters: [],
    inFilters: [],
    orders: [],
    limitVal: null,
    rangeFrom: null,
    rangeTo: null,
  };

  function runQuery(singleMode) {
    const queryEntry = {
      table: state.table,
      selectCols: state.selectCols,
      eqFilters: state.eqFilters.map((f) => ({ ...f })),
      gteFilters: state.gteFilters.map((f) => ({ ...f })),
      lteFilters: state.lteFilters.map((f) => ({ ...f })),
      inFilters: state.inFilters.map((f) => ({ col: f.col, vals: [...f.vals] })),
      orders: state.orders.map((o) => ({ ...o })),
      limitVal: state.limitVal,
      rangeFrom: state.rangeFrom,
      rangeTo: state.rangeTo,
    };
    dbState.queryLog.push(queryEntry);

    if (typeof dbState.injectedError === 'function') {
      const err = dbState.injectedError(queryEntry);
      if (err) {
        return { data: null, error: err };
      }
    } else if (dbState.injectedError) {
      return { data: null, error: dbState.injectedError };
    }

    const source = getTableSource(state.table);
    if (source === null) {
      return { data: null, error: null };
    }

    let rows = source.filter((row) => {
      for (const f of state.eqFilters) {
        if (row[f.col] !== f.val) return false;
      }
      for (const f of state.gteFilters) {
        if (row[f.col] === null || row[f.col] === undefined) return false;
        if (String(row[f.col]) < String(f.val)) return false;
      }
      for (const f of state.lteFilters) {
        if (row[f.col] === null || row[f.col] === undefined) return false;
        if (String(row[f.col]) > String(f.val)) return false;
      }
      for (const f of state.inFilters) {
        if (!f.vals.includes(row[f.col])) return false;
      }
      return true;
    });

    if (state.orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const ord of state.orders) {
          const av = a[ord.col] ?? '';
          const bv = b[ord.col] ?? '';
          if (av === bv) continue;
          const cmp = av < bv ? -1 : 1;
          return ord.ascending ? cmp : -cmp;
        }
        return 0;
      });
    }

    if (state.rangeFrom !== null && state.rangeTo !== null) {
      rows = rows.slice(state.rangeFrom, state.rangeTo + 1);
    } else if (state.limitVal !== null) {
      rows = rows.slice(0, state.limitVal);
    }
    rows = rows.slice(0, POSTGREST_MAX_ROWS);

    const projected = rows.map((row) => projectRow(row, state.selectCols));
    if (singleMode === 'maybeSingle') {
      return { data: projected[0] ?? null, error: null };
    }
    return { data: projected, error: null };
  }

  const builder = {
    select(cols) {
      state.selectCols = cols;
      return builder;
    },
    eq(col, val) {
      state.eqFilters.push({ col, val });
      return builder;
    },
    gte(col, val) {
      state.gteFilters.push({ col, val });
      return builder;
    },
    lte(col, val) {
      state.lteFilters.push({ col, val });
      return builder;
    },
    in(col, vals) {
      state.inFilters.push({ col, vals: Array.isArray(vals) ? [...vals] : [] });
      return builder;
    },
    order(col, opts) {
      state.orders.push({ col, ascending: opts?.ascending ?? true });
      return builder;
    },
    limit(n) {
      state.limitVal = n;
      return builder;
    },
    range(from, to) {
      state.rangeFrom = from;
      state.rangeTo = to;
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(runQuery('maybeSingle'));
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve(runQuery('many')).then(onFulfilled, onRejected);
    },
  };

  return builder;
}

function roundTwo(val) {
  const r = Math.round(val * 100) / 100;
  return r === 0 ? 0 : r;
}

function buildMovimiento(index, overrides = {}) {
  const day = String(((index - 1) % 20) + 1).padStart(2, '0');
  const sec = String(index % 60).padStart(2, '0');
  const min = String(Math.floor(index / 60) % 60).padStart(2, '0');
  const isIngreso = index % 3 !== 0;
  return {
    id: `mov-${String(index).padStart(5, '0')}`,
    org_id: ORG_A,
    tipo: isIngreso ? 'ingreso' : 'egreso',
    monto: isIngreso ? roundTwo(100 + (index % 17) + 0.15) : roundTwo(35 + (index % 11) + 0.05),
    categoria_id: index % 10 === 0 ? null : `cat-${(index % 3) + 1}`,
    sucursal_id: index % 12 === 0 ? null : `suc-${(index % 2) + 1}`,
    metodo_pago: index % 2 === 0 ? 'Transferencia' : 'Efectivo',
    nota: `Nota mov ${index}`,
    pedido_id: null,
    fecha: `2026-05-${day}`,
    created_at: `2026-05-${day}T10:${min}:${sec}.000Z`,
    ...overrides,
  };
}

function computeExpectedAgregados(rows, catMap, sucMap) {
  let ingresos = 0;
  let egresos = 0;
  const byDay = new Map();
  const byCatIng = new Map();
  const byCatEgr = new Map();
  const bySuc = new Map();

  for (const r of rows) {
    const val = Math.abs(Number(r.monto));
    const safeVal = Number.isFinite(val) ? val : 0;
    const isIng = r.tipo === 'ingreso';
    const isEgr = r.tipo === 'egreso';
    if (!isIng && !isEgr) continue;

    if (isIng) ingresos += safeVal;
    else egresos += safeVal;

    const dia = String(r.fecha).slice(0, 10);
    const dayNode = byDay.get(dia) ?? { ingresos: 0, egresos: 0 };
    if (isIng) dayNode.ingresos += safeVal;
    else dayNode.egresos += safeVal;
    byDay.set(dia, dayNode);

    const catKey = r.categoria_id || '__sin_cat__';
    const catTarget = isIng ? byCatIng : byCatEgr;
    catTarget.set(catKey, (catTarget.get(catKey) ?? 0) + safeVal);

    const sucKey = r.sucursal_id || '__sin_suc__';
    const sucNode = bySuc.get(sucKey) ?? { ingresos: 0, egresos: 0 };
    if (isIng) sucNode.ingresos += safeVal;
    else sucNode.egresos += safeVal;
    bySuc.set(sucKey, sucNode);
  }

  const ingR = roundTwo(ingresos);
  const egrR = roundTwo(egresos);
  const formatCat = (map) =>
    Array.from(map.entries())
      .map(([id, total]) => ({
        categoria_id: id === '__sin_cat__' ? null : id,
        nombre: id === '__sin_cat__' ? 'Sin categoría' : (catMap.get(id) || 'Sin categoría'),
        total: roundTwo(total),
      }))
      .sort((a, b) => b.total - a.total);

  const porSucursal = Array.from(bySuc.entries())
    .map(([id, v]) => {
      const sIng = roundTwo(v.ingresos);
      const sEgr = roundTwo(v.egresos);
      return {
        sucursal_id: id === '__sin_suc__' ? null : id,
        nombre: id === '__sin_suc__' ? 'Sin sucursal' : (sucMap.get(id) || 'Sin sucursal'),
        ingresos: sIng,
        egresos: sEgr,
        balance: roundTwo(sIng - sEgr),
      };
    })
    .sort((a, b) => (b.ingresos + b.egresos) - (a.ingresos + a.egresos));

  return {
    totales: { ingresos: ingR, egresos: egrR, balance: roundTwo(ingR - egrR) },
    byDay,
    porCategoria: { ingreso: formatCat(byCatIng), egreso: formatCat(byCatEgr) },
    porSucursal,
  };
}

async function requestJson(server, pathWithQuery, headers = {}) {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathWithQuery,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('DashboardService y ruta HTTP GET /dashboard', () => {
  let originalFrom;
  let originalGetUser;

  before(() => {
    originalFrom = supabaseAdmin.from;
    originalGetUser = supabaseAnon.auth.getUser;

    supabaseAdmin.from = (tableName) => createSupabaseBuilder(tableName);
    supabaseAnon.auth.getUser = async (token) => {
      if (token === 'valid-token') {
        return { data: { user: USER_A }, error: null };
      }
      return { data: { user: null }, error: { message: 'Invalid token' } };
    };
  });

  after(() => {
    supabaseAdmin.from = originalFrom;
    supabaseAnon.auth.getUser = originalGetUser;
  });

  beforeEach(() => {
    dbState.categorias = [
      { id: 'cat-1', org_id: ORG_A, nombre: 'Lavado' },
      { id: 'cat-2', org_id: ORG_A, nombre: 'Planchado' },
      { id: 'cat-3', org_id: ORG_A, nombre: 'Insumos' },
    ];
    dbState.sucursales = [
      { id: 'suc-1', org_id: ORG_A, nombre: 'Sucursal Centro' },
      { id: 'suc-2', org_id: ORG_A, nombre: 'Sucursal Norte' },
    ];
    dbState.movimientos = [];
    dbState.pedidos = [];
    dbState.membresias = [{ user_id: USER_A.id, org_id: ORG_A }];
    dbState.injectedError = null;
    dbState.queryLog = [];
  });

  describe('Caso 1: Loteo > 1000 filas sin truncamiento y caso borde de 1000 filas', () => {
    it('suma 100% de 1250 movimientos en rango y 1150 en el mes actual usando lotes ordenados por id', async () => {
      const catMap = new Map(dbState.categorias.map((c) => [c.id, c.nombre]));
      const sucMap = new Map(dbState.sucursales.map((s) => [s.id, s.nombre]));

      const aprilRows = [];
      for (let i = 1; i <= 100; i++) {
        const day = String(21 + ((i - 1) % 10)).padStart(2, '0');
        aprilRows.push(
          buildMovimiento(i, {
            fecha: `2026-04-${day}`,
            created_at: `2026-04-${day}T09:00:00.000Z`,
            monto: i % 2 === 0 ? '25.50' : 120.1,
          })
        );
      }

      const mayRows = [];
      for (let i = 101; i <= 1250; i++) {
        const day = String(((i - 101) % 20) + 1).padStart(2, '0');
        const extraWeight = i > 1000 ? 500 : 0;
        mayRows.push(
          buildMovimiento(i, {
            fecha: `2026-05-${day}`,
            created_at: `2026-05-${day}T11:00:00.000Z`,
            monto: roundTwo(50 + extraWeight + (i % 13) + 0.1),
          })
        );
      }

      const outOfRangeRows = [
        buildMovimiento(9001, { fecha: '2026-04-15', tipo: 'ingreso', monto: 77777 }),
        buildMovimiento(9002, { fecha: '2026-05-25', tipo: 'egreso', monto: 88888 }),
      ];

      const rangeRows = [...aprilRows, ...mayRows];
      dbState.movimientos = [...rangeRows, ...outOfRangeRows];

      const expectedRange = computeExpectedAgregados(rangeRows, catMap, sucMap);
      const expectedMes = computeExpectedAgregados(mayRows, catMap, sucMap);

      const res = await DashboardService.obtenerDashboard(
        ORG_A,
        { desde: '2026-04-21', hasta: '2026-05-20', include: 'mes,recientes' },
        REF_DATE
      );

      assert.deepEqual(res.range, { desde: '2026-04-21', hasta: '2026-05-20', dias: 30 });
      assert.equal(res.meta.items, 1250);
      assert.deepEqual(res.totales, expectedRange.totales);
      assert.deepEqual(res.por_categoria, expectedRange.porCategoria);

      assert.equal(res.por_dia.length, 30);
      let sumaDiasIng = 0;
      let sumaDiasEgr = 0;
      for (const diaItem of res.por_dia) {
        const expectedNode = expectedRange.byDay.get(diaItem.fecha);
        const expIng = roundTwo(expectedNode?.ingresos ?? 0);
        const expEgr = roundTwo(expectedNode?.egresos ?? 0);
        assert.deepEqual(diaItem, {
          fecha: diaItem.fecha,
          ingresos: expIng,
          egresos: expEgr,
          balance: roundTwo(expIng - expEgr),
        });
        sumaDiasIng += diaItem.ingresos;
        sumaDiasEgr += diaItem.egresos;
      }
      assert.equal(roundTwo(sumaDiasIng), res.totales.ingresos);
      assert.equal(roundTwo(sumaDiasEgr), res.totales.egresos);

      assert.deepEqual(res.kpis_mes, expectedMes.totales);
      assert.notEqual(res.kpis_mes.ingresos, res.totales.ingresos);
      assert.deepEqual(res.por_categoria_mes, expectedMes.porCategoria);
      assert.deepEqual(res.por_sucursal_mes, expectedMes.porSucursal);

      const rangeQueries = dbState.queryLog.filter(
        (q) => q.table === 'movimientos' && q.selectCols === 'tipo, monto, categoria_id, sucursal_id, fecha'
      );
      const mesQueries = dbState.queryLog.filter(
        (q) => q.table === 'movimientos' && q.selectCols === 'tipo, monto, categoria_id, sucursal_id'
      );

      assert.equal(rangeQueries.length, 2);
      assert.deepEqual(
        rangeQueries.map((q) => [q.rangeFrom, q.rangeTo]),
        [
          [0, 999],
          [1000, 1999],
        ]
      );
      for (const q of rangeQueries) {
        assert.deepEqual(q.orders, [{ col: 'id', ascending: true }]);
        assert.deepEqual(q.eqFilters, [{ col: 'org_id', val: ORG_A }]);
        assert.deepEqual(q.gteFilters, [{ col: 'fecha', val: '2026-04-21' }]);
        assert.deepEqual(q.lteFilters, [{ col: 'fecha', val: '2026-05-20' }]);
      }

      assert.equal(mesQueries.length, 2);
      assert.deepEqual(
        mesQueries.map((q) => [q.rangeFrom, q.rangeTo]),
        [
          [0, 999],
          [1000, 1999],
        ]
      );
      for (const q of mesQueries) {
        assert.deepEqual(q.orders, [{ col: 'id', ascending: true }]);
        assert.deepEqual(q.eqFilters, [{ col: 'org_id', val: ORG_A }]);
        assert.deepEqual(q.gteFilters, [{ col: 'fecha', val: '2026-05-01' }]);
        assert.deepEqual(q.lteFilters, [{ col: 'fecha', val: '2026-05-20' }]);
      }
    });

    it('maneja el caso borde de exactamente 1000 filas sin truncar ni duplicar', async () => {
      const catMap = new Map(dbState.categorias.map((c) => [c.id, c.nombre]));
      const sucMap = new Map(dbState.sucursales.map((s) => [s.id, s.nombre]));

      const exact1000 = [];
      for (let i = 1; i <= 1000; i++) {
        const day = String(((i - 1) % 20) + 1).padStart(2, '0');
        exact1000.push(
          buildMovimiento(i, {
            fecha: `2026-05-${day}`,
            monto: i === 1000 ? 987.65 : roundTwo(10 + (i % 9) + 0.2),
          })
        );
      }
      dbState.movimientos = exact1000;

      const expected = computeExpectedAgregados(exact1000, catMap, sucMap);
      const res = await DashboardService.obtenerDashboard(
        ORG_A,
        { desde: '2026-05-01', hasta: '2026-05-20' },
        REF_DATE
      );

      assert.equal(res.meta.items, 1000);
      assert.deepEqual(res.totales, expected.totales);
      assert.deepEqual(res.kpis_mes, expected.totales);
      assert.equal(res.por_dia.length, 20);
      for (const diaItem of res.por_dia) {
        const expectedNode = expected.byDay.get(diaItem.fecha);
        const expIng = roundTwo(expectedNode?.ingresos ?? 0);
        const expEgr = roundTwo(expectedNode?.egresos ?? 0);
        assert.deepEqual(diaItem, {
          fecha: diaItem.fecha,
          ingresos: expIng,
          egresos: expEgr,
          balance: roundTwo(expIng - expEgr),
        });
      }
      assert.deepEqual(res.por_categoria, expected.porCategoria);
      assert.deepEqual(res.por_categoria_mes, expected.porCategoria);
      assert.deepEqual(res.por_sucursal_mes, expected.porSucursal);

      const rangeQueries = dbState.queryLog.filter(
        (q) => q.table === 'movimientos' && q.selectCols === 'tipo, monto, categoria_id, sucursal_id, fecha'
      );
      const mesQueries = dbState.queryLog.filter(
        (q) => q.table === 'movimientos' && q.selectCols === 'tipo, monto, categoria_id, sucursal_id'
      );

      assert.equal(rangeQueries.length, 2);
      assert.deepEqual(
        rangeQueries.map((q) => [q.rangeFrom, q.rangeTo]),
        [
          [0, 999],
          [1000, 1999],
        ]
      );
      assert.equal(mesQueries.length, 2);
      assert.deepEqual(
        mesQueries.map((q) => [q.rangeFrom, q.rangeTo]),
        [
          [0, 999],
          [1000, 1999],
        ]
      );
      for (const q of [...rangeQueries, ...mesQueries]) {
        assert.deepEqual(q.orders, [{ col: 'id', ascending: true }]);
      }
    });

    it('respeta parametro include omitiendo consultas de mes o recientes cuando no se solicitan', async () => {
      dbState.movimientos = [
        buildMovimiento(1, { fecha: '2026-05-10', pedido_id: 'ped-1' }),
      ];
      dbState.pedidos = [{ id: 'ped-1', org_id: ORG_A, folio: 'NC-001' }];

      const resNone = await DashboardService.obtenerDashboard(
        ORG_A,
        { desde: '2026-05-01', hasta: '2026-05-20', include: 'none' },
        REF_DATE
      );

      assert.equal(resNone.kpis_mes, undefined);
      assert.equal(resNone.por_categoria_mes, undefined);
      assert.equal(resNone.por_sucursal_mes, undefined);
      assert.equal(resNone.recientes, undefined);
      assert.equal(resNone.meta.items, 1);

      const mesQueries = dbState.queryLog.filter(
        (q) => q.table === 'movimientos' && q.selectCols === 'tipo, monto, categoria_id, sucursal_id'
      );
      const pedidoQueries = dbState.queryLog.filter((q) => q.table === 'pedidos');
      assert.equal(mesQueries.length, 0);
      assert.equal(pedidoQueries.length, 0);
    });
  });

  describe('Caso 2: recientes enriquecidos, limites, orden y deduplicacion batch de pedidos', () => {
    it('aplica limite por defecto 5 y clamping [1, 50] para valores extremos o invalidos', async () => {
      const rows60 = [];
      for (let i = 1; i <= 60; i++) {
        const day = String(((i - 1) % 20) + 1).padStart(2, '0');
        rows60.push(
          buildMovimiento(i, {
            fecha: `2026-05-${day}`,
            created_at: `2026-05-${day}T12:${String(i % 60).padStart(2, '0')}:00.000Z`,
          })
        );
      }
      dbState.movimientos = rows60;

      assert.equal(normalizarLimitRecientes(undefined), 5);
      assert.equal(normalizarLimitRecientes(null), 5);
      assert.equal(normalizarLimitRecientes(''), 5);
      assert.equal(normalizarLimitRecientes('   '), 5);
      assert.equal(normalizarLimitRecientes('abc'), 5);
      assert.equal(normalizarLimitRecientes(Number.NaN), 5);
      assert.equal(normalizarLimitRecientes(Number.POSITIVE_INFINITY), 5);
      assert.equal(normalizarLimitRecientes(0), 1);
      assert.equal(normalizarLimitRecientes('-8'), 1);
      assert.equal(normalizarLimitRecientes(1), 1);
      assert.equal(normalizarLimitRecientes(50), 50);
      assert.equal(normalizarLimitRecientes(100), 50);
      assert.equal(normalizarLimitRecientes('12.9'), 12);

      const defaultRes = await DashboardService.obtenerDashboard(
        ORG_A,
        { desde: '2026-05-01', hasta: '2026-05-20' },
        REF_DATE
      );
      assert.equal(defaultRes.recientes.length, 5);

      const zeroRes = await DashboardService.obtenerDashboard(
        ORG_A,
        { desde: '2026-05-01', hasta: '2026-05-20', limit_recientes: 0 },
        REF_DATE
      );
      assert.equal(zeroRes.recientes.length, 1);

      const hundredRes = await DashboardService.obtenerDashboard(
        ORG_A,
        { desde: '2026-05-01', hasta: '2026-05-20', limit_recientes: 100 },
        REF_DATE
      );
      assert.equal(hundredRes.recientes.length, 50);

      const invalidRes = await DashboardService.obtenerDashboard(
        ORG_A,
        { desde: '2026-05-01', hasta: '2026-05-20', limit_recientes: 'invalido' },
        REF_DATE
      );
      assert.equal(invalidRes.recientes.length, 5);

      const recientesQueries = dbState.queryLog.filter(
        (q) => q.table === 'movimientos' && q.limitVal !== null
      );
      assert.deepEqual(
        recientesQueries.map((q) => q.limitVal),
        [5, 1, 50, 5]
      );
    });

    it('ordena por fecha DESC, created_at DESC, id DESC, enriquece campos, normaliza signos y deduplica batch a pedidos', async () => {
      dbState.pedidos = [
        { id: 'ped-1', org_id: ORG_A, folio: 'NC-1001' },
        { id: 'ped-2', org_id: ORG_A, folio: null },
      ];

      dbState.movimientos = [
        {
          id: 'mov-a',
          org_id: ORG_A,
          tipo: 'ingreso',
          monto: 250.5,
          categoria_id: 'cat-1',
          sucursal_id: 'suc-1',
          metodo_pago: 'Transferencia',
          nota: 'Pago completo',
          pedido_id: 'ped-1',
          fecha: '2026-05-20',
          created_at: '2026-05-20T14:00:00.000Z',
        },
        {
          id: 'mov-b',
          org_id: ORG_A,
          tipo: 'egreso',
          monto: 85.25,
          categoria_id: null,
          sucursal_id: null,
          metodo_pago: null,
          nota: null,
          pedido_id: 'ped-1',
          fecha: '2026-05-20',
          created_at: '2026-05-20T14:00:00.000Z',
        },
        {
          id: 'mov-c',
          org_id: ORG_A,
          tipo: 'egreso',
          monto: 0,
          categoria_id: 'cat-inexistente',
          sucursal_id: 'suc-inexistente',
          metodo_pago: 'Efectivo',
          nota: 'Ajuste en cero',
          pedido_id: 'ped-2',
          fecha: '2026-05-20',
          created_at: '2026-05-20T13:00:00.000Z',
        },
        {
          id: 'mov-d',
          org_id: ORG_A,
          tipo: 'egreso',
          monto: -0.001,
          categoria_id: 'cat-2',
          sucursal_id: 'suc-2',
          metodo_pago: 'Tarjeta',
          nota: 'Centavos menores a medio centavo',
          pedido_id: 'ped-faltante',
          fecha: '2026-05-19',
          created_at: null,
        },
        {
          id: 'mov-e',
          org_id: ORG_A,
          tipo: 'egreso',
          monto: -40.75,
          categoria_id: 'cat-3',
          sucursal_id: 'suc-1',
          metodo_pago: 'Efectivo',
          nota: 'Compra directa',
          pedido_id: null,
          fecha: '2026-05-18',
          created_at: '   ',
        },
      ];

      const res = await DashboardService.obtenerDashboard(
        ORG_A,
        { desde: '2026-05-01', hasta: '2026-05-20', limit_recientes: 10 },
        REF_DATE
      );

      assert.deepEqual(
        res.recientes.map((item) => item.id),
        ['mov-b', 'mov-a', 'mov-c', 'mov-d', 'mov-e']
      );

      assert.deepEqual(res.recientes[0], {
        id: 'mov-b',
        tipo: 'egreso',
        categoria: 'Sin categoría',
        sucursal_id: null,
        sucursal_nombre: 'Sin sucursal',
        metodo_pago: null,
        nota: null,
        pedido_id: 'ped-1',
        pedido_folio: 'NC-1001',
        fecha: '2026-05-20T14:00:00.000Z',
        created_at: '2026-05-20T14:00:00.000Z',
        monto: -85.25,
      });

      assert.deepEqual(res.recientes[1], {
        id: 'mov-a',
        tipo: 'ingreso',
        categoria: 'Lavado',
        sucursal_id: 'suc-1',
        sucursal_nombre: 'Sucursal Centro',
        metodo_pago: 'Transferencia',
        nota: 'Pago completo',
        pedido_id: 'ped-1',
        pedido_folio: 'NC-1001',
        fecha: '2026-05-20T14:00:00.000Z',
        created_at: '2026-05-20T14:00:00.000Z',
        monto: 250.5,
      });

      assert.deepEqual(res.recientes[2], {
        id: 'mov-c',
        tipo: 'egreso',
        categoria: 'Sin categoría',
        sucursal_id: 'suc-inexistente',
        sucursal_nombre: 'Sin sucursal',
        metodo_pago: 'Efectivo',
        nota: 'Ajuste en cero',
        pedido_id: 'ped-2',
        pedido_folio: null,
        fecha: '2026-05-20T13:00:00.000Z',
        created_at: '2026-05-20T13:00:00.000Z',
        monto: 0,
      });
      assert.equal(Object.is(res.recientes[2].monto, 0), true);

      assert.deepEqual(res.recientes[3], {
        id: 'mov-d',
        tipo: 'egreso',
        categoria: 'Planchado',
        sucursal_id: 'suc-2',
        sucursal_nombre: 'Sucursal Norte',
        metodo_pago: 'Tarjeta',
        nota: 'Centavos menores a medio centavo',
        pedido_id: 'ped-faltante',
        pedido_folio: null,
        fecha: '2026-05-19T00:00:00',
        created_at: null,
        monto: 0,
      });
      assert.equal(Object.is(res.recientes[3].monto, 0), true);

      assert.deepEqual(res.recientes[4], {
        id: 'mov-e',
        tipo: 'egreso',
        categoria: 'Insumos',
        sucursal_id: 'suc-1',
        sucursal_nombre: 'Sucursal Centro',
        metodo_pago: 'Efectivo',
        nota: 'Compra directa',
        pedido_id: null,
        pedido_folio: null,
        fecha: '2026-05-18T00:00:00',
        created_at: null,
        monto: -40.75,
      });

      const recientesQuery = dbState.queryLog.find(
        (q) => q.table === 'movimientos' && q.limitVal === 10
      );
      assert.ok(recientesQuery);
      assert.deepEqual(recientesQuery.orders, [
        { col: 'fecha', ascending: false },
        { col: 'created_at', ascending: false },
        { col: 'id', ascending: false },
      ]);

      const pedidosQueries = dbState.queryLog.filter((q) => q.table === 'pedidos');
      assert.equal(pedidosQueries.length, 1);
      assert.deepEqual(pedidosQueries[0].eqFilters, [{ col: 'org_id', val: ORG_A }]);
      assert.equal(pedidosQueries[0].inFilters.length, 1);
      assert.equal(pedidosQueries[0].inFilters[0].col, 'id');
      assert.deepEqual(pedidosQueries[0].inFilters[0].vals, ['ped-1', 'ped-2', 'ped-faltante']);
    });

    it('ejecuta 0 consultas a pedidos cuando todos los recientes tienen pedido_id null', async () => {
      dbState.movimientos = [
        buildMovimiento(1, { fecha: '2026-05-19', pedido_id: null }),
        buildMovimiento(2, { fecha: '2026-05-20', pedido_id: null }),
      ];
      dbState.pedidos = [{ id: 'ped-unused', org_id: ORG_A, folio: 'NC-999' }];

      const res = await DashboardService.obtenerDashboard(
        ORG_A,
        { desde: '2026-05-01', hasta: '2026-05-20' },
        REF_DATE
      );

      assert.equal(res.recientes.length, 2);
      for (const item of res.recientes) {
        assert.equal(item.pedido_id, null);
        assert.equal(item.pedido_folio, null);
      }

      const pedidosQueries = dbState.queryLog.filter((q) => q.table === 'pedidos');
      assert.equal(pedidosQueries.length, 0);
    });
  });

  describe('Caso 3: Aislamiento multi-tenant por org_id', () => {
    it('nunca filtra totales, categorias, sucursales, recientes ni pedido_folio de otra organizacion', async () => {
      dbState.categorias = [
        { id: 'cat-a-1', org_id: ORG_A, nombre: 'Lavado Org A' },
        { id: 'cat-b-1', org_id: ORG_B, nombre: 'Categoria Secreta Org B' },
      ];
      dbState.sucursales = [
        { id: 'suc-a-1', org_id: ORG_A, nombre: 'Sucursal Org A' },
        { id: 'suc-b-1', org_id: ORG_B, nombre: 'Sucursal Secreta Org B' },
      ];
      dbState.pedidos = [
        { id: 'ped-a-1', org_id: ORG_A, folio: 'FOLIO-A-100' },
        { id: 'ped-shared', org_id: ORG_B, folio: 'FOLIO-SECRETO-B-999' },
        { id: 'ped-b-2', org_id: ORG_B, folio: 'FOLIO-B-200' },
      ];
      dbState.movimientos = [
        {
          id: 'mov-a-1',
          org_id: ORG_A,
          tipo: 'ingreso',
          monto: 300,
          categoria_id: 'cat-a-1',
          sucursal_id: 'suc-a-1',
          metodo_pago: 'Efectivo',
          nota: 'Venta A',
          pedido_id: 'ped-a-1',
          fecha: '2026-05-18',
          created_at: '2026-05-18T10:00:00.000Z',
        },
        {
          id: 'mov-a-cross-ref',
          org_id: ORG_A,
          tipo: 'egreso',
          monto: 50,
          categoria_id: 'cat-b-1',
          sucursal_id: 'suc-b-1',
          metodo_pago: 'Tarjeta',
          nota: 'Referencia cruzada no autorizada',
          pedido_id: 'ped-shared',
          fecha: '2026-05-19',
          created_at: '2026-05-19T10:00:00.000Z',
        },
        {
          id: 'mov-b-1',
          org_id: ORG_B,
          tipo: 'ingreso',
          monto: 999999,
          categoria_id: 'cat-b-1',
          sucursal_id: 'suc-b-1',
          metodo_pago: 'Transferencia',
          nota: 'Ingreso confidencial Org B',
          pedido_id: 'ped-shared',
          fecha: '2026-05-20',
          created_at: '2026-05-20T23:59:59.000Z',
        },
        {
          id: 'mov-b-2',
          org_id: ORG_B,
          tipo: 'egreso',
          monto: 500000,
          categoria_id: 'cat-b-1',
          sucursal_id: 'suc-b-1',
          metodo_pago: 'Efectivo',
          nota: 'Egreso confidencial Org B',
          pedido_id: 'ped-b-2',
          fecha: '2026-05-20',
          created_at: '2026-05-20T22:00:00.000Z',
        },
      ];

      const resA = await DashboardService.obtenerDashboard(
        ORG_A,
        { desde: '2026-05-01', hasta: '2026-05-20' },
        REF_DATE
      );

      assert.equal(resA.meta.items, 2);
      assert.deepEqual(resA.totales, { ingresos: 300, egresos: 50, balance: 250 });
      assert.deepEqual(resA.kpis_mes, { ingresos: 300, egresos: 50, balance: 250 });
      assert.deepEqual(resA.por_categoria, {
        ingreso: [{ categoria_id: 'cat-a-1', nombre: 'Lavado Org A', total: 300 }],
        egreso: [{ categoria_id: 'cat-b-1', nombre: 'Sin categoría', total: 50 }],
      });
      assert.deepEqual(resA.por_sucursal_mes, [
        { sucursal_id: 'suc-a-1', nombre: 'Sucursal Org A', ingresos: 300, egresos: 0, balance: 300 },
        { sucursal_id: 'suc-b-1', nombre: 'Sin sucursal', ingresos: 0, egresos: 50, balance: -50 },
      ]);

      assert.equal(resA.recientes.length, 2);
      assert.deepEqual(
        resA.recientes.map((r) => r.id),
        ['mov-a-cross-ref', 'mov-a-1']
      );
      assert.equal(resA.recientes[0].pedido_id, 'ped-shared');
      assert.equal(resA.recientes[0].pedido_folio, null);
      assert.equal(resA.recientes[0].categoria, 'Sin categoría');
      assert.equal(resA.recientes[0].sucursal_nombre, 'Sin sucursal');
      assert.equal(resA.recientes[1].pedido_folio, 'FOLIO-A-100');

      const serializedA = JSON.stringify(resA);
      assert.equal(serializedA.includes('Org B'), false);
      assert.equal(serializedA.includes('FOLIO-SECRETO-B-999'), false);
      assert.equal(serializedA.includes('FOLIO-B-200'), false);

      assert.ok(dbState.queryLog.length > 0);
      for (const q of dbState.queryLog) {
        const hasOrgFilter = q.eqFilters.some((f) => f.col === 'org_id' && f.val === ORG_A);
        assert.equal(hasOrgFilter, true, `Consulta sin filtro org_id en tabla ${q.table}`);
      }

      const [concurrentA, concurrentB] = await Promise.all([
        DashboardService.obtenerDashboard(ORG_A, { desde: '2026-05-01', hasta: '2026-05-20' }, REF_DATE),
        DashboardService.obtenerDashboard(ORG_B, { desde: '2026-05-01', hasta: '2026-05-20' }, REF_DATE),
      ]);

      assert.deepEqual(concurrentA.totales, { ingresos: 300, egresos: 50, balance: 250 });
      assert.equal(concurrentA.meta.items, 2);
      assert.equal(concurrentA.recientes[0].pedido_folio, null);

      assert.deepEqual(concurrentB.totales, { ingresos: 999999, egresos: 500000, balance: 499999 });
      assert.equal(concurrentB.meta.items, 2);
      assert.equal(concurrentB.recientes[0].pedido_folio, 'FOLIO-SECRETO-B-999');
      assert.equal(concurrentB.recientes[1].pedido_folio, 'FOLIO-B-200');
      assert.equal(JSON.stringify(concurrentB).includes('Org A'), false);
    });

    it('rechaza org_id vacio o solo espacios con DashboardValidationError 400', async () => {
      await assert.rejects(
        () => DashboardService.obtenerDashboard('', {}, REF_DATE),
        (err) => err instanceof DashboardValidationError && err.status === 400
      );
      await assert.rejects(
        () => DashboardService.obtenerDashboard('   ', {}, REF_DATE),
        (err) => err instanceof DashboardValidationError && err.status === 400
      );
      assert.equal(dbState.queryLog.length, 0);
    });
  });

  describe('Caso 4: Integracion HTTP, validacion 400, vacios y propagacion de errores', () => {
    let server;

    before(async () => {
      const app = express();
      app.use(express.json());
      app.use('/dashboard', dashboardRouter);
      app.use(globalErrorHandler);
      await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
      });
    });

    after(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('responde 400 con rango invalido cuando desde > hasta', async () => {
      const res = await requestJson(
        server,
        '/dashboard?desde=2026-05-10&hasta=2026-05-01',
        { authorization: 'Bearer valid-token' }
      );

      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: 'rango inválido: desde > hasta' });

      const domainQueries = dbState.queryLog.filter((q) => q.table !== 'organizacion_miembros');
      assert.equal(domainQueries.length, 0);
    });

    it('responde 400 para fechas con formato o calendario invalido y 200 para fecha bisiesta valida', async () => {
      const authHeaders = { authorization: 'Bearer valid-token' };
      const invalidPaths = [
        '/dashboard?desde=2026-02-30&hasta=2026-03-05',
        '/dashboard?desde=2026-02-29&hasta=2026-03-05',
        '/dashboard?desde=2026-04-01&hasta=2026-04-31',
        '/dashboard?desde=01-05-2026&hasta=2026-05-10',
        '/dashboard?desde=2026-05-01&hasta=not-a-date',
        '/dashboard?desde=2026-13-01&hasta=2026-13-10',
      ];

      for (const path of invalidPaths) {
        const res = await requestJson(server, path, authHeaders);
        assert.equal(res.status, 400, `Expected 400 for ${path}`);
        assert.equal(typeof res.body.error, 'string');
        assert.ok(res.body.error.length > 0);
      }

      const leapOk = await requestJson(
        server,
        '/dashboard?desde=2024-02-29&hasta=2024-02-29&include=none',
        authHeaders
      );
      assert.equal(leapOk.status, 200);
      assert.deepEqual(leapOk.body.range, { desde: '2024-02-29', hasta: '2024-02-29', dias: 1 });
    });

    it('devuelve respuesta limpia en ceros para org sin movimientos ni pedidos sin consultar pedidos', async () => {
      dbState.categorias = [];
      dbState.sucursales = [];
      dbState.movimientos = [];
      dbState.pedidos = [];

      const res = await requestJson(
        server,
        '/dashboard?desde=2026-05-01&hasta=2026-05-03',
        { authorization: 'Bearer valid-token' }
      );

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        range: { desde: '2026-05-01', hasta: '2026-05-03', dias: 3 },
        totales: { ingresos: 0, egresos: 0, balance: 0 },
        por_dia: [
          { fecha: '2026-05-01', ingresos: 0, egresos: 0, balance: 0 },
          { fecha: '2026-05-02', ingresos: 0, egresos: 0, balance: 0 },
          { fecha: '2026-05-03', ingresos: 0, egresos: 0, balance: 0 },
        ],
        por_categoria: { ingreso: [], egreso: [] },
        kpis_mes: { ingresos: 0, egresos: 0, balance: 0 },
        por_categoria_mes: { ingreso: [], egreso: [] },
        por_sucursal_mes: [],
        recientes: [],
        meta: { items: 0 },
      });

      const pedidosQueries = dbState.queryLog.filter((q) => q.table === 'pedidos');
      assert.equal(pedidosQueries.length, 0);

      dbState.categorias = null;
      dbState.sucursales = null;
      dbState.movimientos = null;
      dbState.pedidos = null;
      const nullDataRes = await DashboardService.obtenerDashboard(
        ORG_A,
        { desde: '2026-05-01', hasta: '2026-05-01' },
        REF_DATE
      );
      assert.deepEqual(nullDataRes.totales, { ingresos: 0, egresos: 0, balance: 0 });
      assert.deepEqual(nullDataRes.recientes, []);
      assert.equal(nullDataRes.meta.items, 0);
    });

    it('responde 200 con contrato completo en GET /dashboard y aplica guards 401/403', async () => {
      const todayISO = obtenerHoyLocalISO(new Date());
      dbState.pedidos = [{ id: 'ped-http-1', org_id: ORG_A, folio: 'NC-HTTP-01' }];
      dbState.movimientos = [
        buildMovimiento(1, {
          fecha: todayISO,
          created_at: `${todayISO}T08:30:00.000Z`,
          tipo: 'ingreso',
          monto: 420.5,
          categoria_id: 'cat-1',
          sucursal_id: 'suc-1',
          pedido_id: 'ped-http-1',
        }),
        buildMovimiento(2, {
          fecha: todayISO,
          created_at: `${todayISO}T09:15:00.000Z`,
          tipo: 'egreso',
          monto: 120.25,
          categoria_id: 'cat-3',
          sucursal_id: 'suc-2',
          pedido_id: null,
        }),
      ];

      const noAuth = await requestJson(server, `/dashboard?desde=${todayISO}&hasta=${todayISO}`);
      assert.equal(noAuth.status, 401);

      const badAuth = await requestJson(server, `/dashboard?desde=${todayISO}&hasta=${todayISO}`, {
        authorization: 'Bearer invalid-token',
      });
      assert.equal(badAuth.status, 401);

      const forbiddenOrg = await requestJson(
        server,
        `/dashboard?desde=${todayISO}&hasta=${todayISO}&org_id=${ORG_B}`,
        { authorization: 'Bearer valid-token' }
      );
      assert.equal(forbiddenOrg.status, 403);

      const okRes = await requestJson(
        server,
        `/dashboard?desde=${todayISO}&hasta=${todayISO}&limit_recientes=2`,
        { authorization: 'Bearer valid-token' }
      );
      assert.equal(okRes.status, 200);
      assert.deepEqual(okRes.body.totales, { ingresos: 420.5, egresos: 120.25, balance: 300.25 });
      assert.deepEqual(okRes.body.kpis_mes, { ingresos: 420.5, egresos: 120.25, balance: 300.25 });
      assert.equal(okRes.body.meta.items, 2);
      assert.equal(okRes.body.recientes.length, 2);
      assert.equal(okRes.body.recientes[0].monto, -120.25);
      assert.equal(okRes.body.recientes[1].pedido_folio, 'NC-HTTP-01');
    });

    it('propaga errores de Supabase en servicio y responde 500 en la ruta HTTP', async () => {
      dbState.movimientos = [
        buildMovimiento(1, { fecha: '2026-05-10', pedido_id: 'ped-err-1' }),
      ];

      const failingScenarios = [
        { label: 'categorias', match: (q) => q.table === 'categorias' },
        { label: 'sucursales', match: (q) => q.table === 'sucursales' },
        {
          label: 'movimientos_rango',
          match: (q) =>
            q.table === 'movimientos' && q.selectCols === 'tipo, monto, categoria_id, sucursal_id, fecha',
        },
        {
          label: 'movimientos_mes',
          match: (q) =>
            q.table === 'movimientos' && q.selectCols === 'tipo, monto, categoria_id, sucursal_id',
        },
        {
          label: 'movimientos_recientes',
          match: (q) => q.table === 'movimientos' && q.limitVal !== null,
        },
        { label: 'pedidos', match: (q) => q.table === 'pedidos' },
      ];
      for (const scenario of failingScenarios) {
        dbState.injectedError = (q) =>
          scenario.match(q) ? new Error(`Supabase failure on ${scenario.label}`) : null;

        await assert.rejects(
          () =>
            DashboardService.obtenerDashboard(
              ORG_A,
              { desde: '2026-05-01', hasta: '2026-05-20' },
              REF_DATE
            ),
          { message: `Supabase failure on ${scenario.label}` }
        );

        const httpRes = await requestJson(
          server,
          '/dashboard?desde=2026-05-01&hasta=2026-05-20',
          { authorization: 'Bearer valid-token' }
        );
        assert.equal(httpRes.status, 500, `Expected 500 when ${scenario.label} fails`);
        assert.deepEqual(httpRes.body, { error: 'Error interno del servidor' });
      }

      // Error en el segundo lote (>1000 filas) tambien debe propagarse sin devolver totales parciales
      const rows1100 = [];
      for (let i = 1; i <= 1100; i++) {
        rows1100.push(buildMovimiento(i, { fecha: '2026-05-10' }));
      }
      dbState.movimientos = rows1100;
      dbState.injectedError = (q) =>
        q.table === 'movimientos' && q.rangeFrom === 1000
          ? new Error('Batch 2 timeout')
          : null;

      await assert.rejects(
        () =>
          DashboardService.obtenerDashboard(
            ORG_A,
            { desde: '2026-05-01', hasta: '2026-05-20' },
            REF_DATE
          ),
        { message: 'Batch 2 timeout' }
      );

      const httpBatchRes = await requestJson(
        server,
        '/dashboard?desde=2026-05-01&hasta=2026-05-20',
        { authorization: 'Bearer valid-token' }
      );
      assert.equal(httpBatchRes.status, 500);
      assert.deepEqual(httpBatchRes.body, { error: 'Error interno del servidor' });
    });
  });

  describe('Caso 5: Filtro opcional sucursal_id en GET /dashboard y DashboardService', () => {
    const SUC_UUID_A = '11111111-1111-4111-8111-111111111111';
    const SUC_UUID_B = '22222222-2222-4222-8222-222222222222';
    const SUC_UUID_EMPTY = '33333333-3333-4333-8333-333333333333';
    const SUC_UUID_OTHER_ORG = '44444444-4444-4444-8444-444444444444';
    const SUC_UUID_MISSING = '99999999-9999-4999-8999-999999999999';

    let server;

    before(async () => {
      const app = express();
      app.use(express.json());
      app.use('/dashboard', dashboardRouter);
      app.use(globalErrorHandler);
      await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
      });
    });

    after(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('filtra rango, mes actual (>1000 filas en lotes) y recientes exclusivamente por sucursal_id valido en GET /dashboard', async () => {
      dbState.sucursales = [
        { id: SUC_UUID_A, org_id: ORG_A, nombre: 'Sucursal Centro UUID' },
        { id: SUC_UUID_B, org_id: ORG_A, nombre: 'Sucursal Norte UUID' },
        { id: SUC_UUID_EMPTY, org_id: ORG_A, nombre: 'Sucursal Sin Movimientos' },
        { id: SUC_UUID_OTHER_ORG, org_id: ORG_B, nombre: 'Sucursal Secreta Org B' },
      ];
      dbState.pedidos = [
        { id: 'ped-suc-a-1', org_id: ORG_A, folio: 'NC-SUC-A-01' },
        { id: 'ped-suc-b-1', org_id: ORG_A, folio: 'NC-SUC-B-99' },
      ];

      const catMap = new Map(dbState.categorias.map((c) => [c.id, c.nombre]));
      const sucMap = new Map(
        dbState.sucursales
          .filter((s) => s.org_id === ORG_A)
          .map((s) => [s.id, s.nombre])
      );

      // Fechas ancladas al dia local actual para coincidir con mesDesde/mesHasta del handler HTTP.
      const now = new Date();
      const todayISO = obtenerHoyLocalISO(now);
      const mesDesdeISO = obtenerHoyLocalISO(new Date(now.getFullYear(), now.getMonth(), 1));
      const prevMonthISO = obtenerHoyLocalISO(new Date(now.getFullYear(), now.getMonth(), 0));
      const outOfRangeEarlyISO = obtenerHoyLocalISO(new Date(now.getFullYear(), now.getMonth(), -5));
      const todayDay = now.getDate();
      const monthPrefix = todayISO.slice(0, 8);

      const sucAPrevRows = [];
      for (let i = 1; i <= 80; i++) {
        sucAPrevRows.push(
          buildMovimiento(i, {
            org_id: ORG_A,
            sucursal_id: SUC_UUID_A,
            fecha: prevMonthISO,
            created_at: `${prevMonthISO}T09:${String(i % 60).padStart(2, '0')}:00.000Z`,
            monto: roundTwo(60 + (i % 15) + 0.25),
          })
        );
      }

      const sucAMesRows = [];
      for (let i = 1; i <= 1120; i++) {
        const idx = 80 + i;
        const dayNum = ((i - 1) % todayDay) + 1;
        const fecha = i === 1120 ? todayISO : `${monthPrefix}${String(dayNum).padStart(2, '0')}`;
        const extraWeight = i > 1000 ? 300 : 0;
        const min = String(Math.floor(i / 60) % 60).padStart(2, '0');
        const sec = String(i % 60).padStart(2, '0');
        sucAMesRows.push(
          buildMovimiento(idx, {
            org_id: ORG_A,
            sucursal_id: SUC_UUID_A,
            tipo: i === 1120 ? 'ingreso' : idx % 3 !== 0 ? 'ingreso' : 'egreso',
            fecha,
            created_at: i === 1120 ? `${todayISO}T22:30:00.000Z` : `${fecha}T10:${min}:${sec}.000Z`,
            monto: i === 1120 ? 321.45 : roundTwo(40 + extraWeight + (i % 13) + 0.1),
            pedido_id: i === 1120 ? 'ped-suc-a-1' : null,
          })
        );
      }

      const sucBRows = [];
      for (let i = 1; i <= 600; i++) {
        const idx = 2000 + i;
        sucBRows.push(
          buildMovimiento(idx, {
            org_id: ORG_A,
            sucursal_id: SUC_UUID_B,
            tipo: i % 2 === 0 ? 'ingreso' : 'egreso',
            fecha: todayISO,
            created_at: `${todayISO}T23:59:${String(i % 60).padStart(2, '0')}.000Z`,
            monto: 50000,
            pedido_id: i === 600 ? 'ped-suc-b-1' : null,
          })
        );
      }

      const nullSucRows = [];
      for (let i = 1; i <= 50; i++) {
        nullSucRows.push(
          buildMovimiento(3000 + i, {
            org_id: ORG_A,
            sucursal_id: null,
            fecha: todayISO,
            created_at: `${todayISO}T23:40:00.000Z`,
            monto: 25000,
          })
        );
      }

      const otherOrgRows = [
        buildMovimiento(4001, {
          org_id: ORG_B,
          sucursal_id: SUC_UUID_OTHER_ORG,
          tipo: 'ingreso',
          fecha: todayISO,
          created_at: `${todayISO}T23:59:59.000Z`,
          monto: 99999,
        }),
      ];

      const outOfRangeEarlyRows = [
        buildMovimiento(5001, {
          org_id: ORG_A,
          sucursal_id: SUC_UUID_A,
          tipo: 'ingreso',
          fecha: outOfRangeEarlyISO,
          created_at: `${outOfRangeEarlyISO}T08:00:00.000Z`,
          monto: 88888,
        }),
      ];

      const sucARangeRows = [...sucAPrevRows, ...sucAMesRows];
      dbState.movimientos = [
        ...sucARangeRows,
        ...sucBRows,
        ...nullSucRows,
        ...otherOrgRows,
        ...outOfRangeEarlyRows,
      ];

      const expectedRange = computeExpectedAgregados(sucARangeRows, catMap, sucMap);
      const expectedMes = computeExpectedAgregados(sucAMesRows, catMap, sucMap);

      const res = await requestJson(
        server,
        `/dashboard?desde=${prevMonthISO}&hasta=${todayISO}&include=mes,recientes&limit_recientes=5&sucursal_id=${SUC_UUID_A}`,
        { authorization: 'Bearer valid-token' }
      );

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.range, {
        desde: prevMonthISO,
        hasta: todayISO,
        dias: todayDay + 1,
      });
      assert.equal(res.body.meta.items, 1200);
      assert.deepEqual(res.body.totales, expectedRange.totales);
      assert.deepEqual(res.body.por_categoria, expectedRange.porCategoria);

      assert.equal(res.body.por_dia.length, todayDay + 1);
      let sumaDiasIng = 0;
      let sumaDiasEgr = 0;
      for (const diaItem of res.body.por_dia) {
        const expectedNode = expectedRange.byDay.get(diaItem.fecha);
        const expIng = roundTwo(expectedNode?.ingresos ?? 0);
        const expEgr = roundTwo(expectedNode?.egresos ?? 0);
        assert.deepEqual(diaItem, {
          fecha: diaItem.fecha,
          ingresos: expIng,
          egresos: expEgr,
          balance: roundTwo(expIng - expEgr),
        });
        sumaDiasIng += diaItem.ingresos;
        sumaDiasEgr += diaItem.egresos;
      }
      assert.equal(roundTwo(sumaDiasIng), res.body.totales.ingresos);
      assert.equal(roundTwo(sumaDiasEgr), res.body.totales.egresos);

      assert.deepEqual(res.body.kpis_mes, expectedMes.totales);
      assert.notEqual(res.body.kpis_mes.ingresos, res.body.totales.ingresos);
      assert.deepEqual(res.body.por_categoria_mes, expectedMes.porCategoria);
      assert.deepEqual(res.body.por_sucursal_mes, expectedMes.porSucursal);
      assert.equal(res.body.por_sucursal_mes.length, 1);
      assert.equal(res.body.por_sucursal_mes[0].sucursal_id, SUC_UUID_A);
      assert.equal(res.body.por_sucursal_mes[0].nombre, 'Sucursal Centro UUID');

      assert.equal(res.body.recientes.length, 5);
      for (const item of res.body.recientes) {
        assert.equal(item.sucursal_id, SUC_UUID_A);
        assert.equal(item.sucursal_nombre, 'Sucursal Centro UUID');
      }
      assert.equal(res.body.recientes[0].id, 'mov-01200');
      assert.equal(res.body.recientes[0].monto, 321.45);
      assert.equal(res.body.recientes[0].pedido_id, 'ped-suc-a-1');
      assert.equal(res.body.recientes[0].pedido_folio, 'NC-SUC-A-01');

      const serialized = JSON.stringify(res.body);
      assert.equal(serialized.includes('NC-SUC-B-99'), false);
      assert.equal(serialized.includes('Sucursal Norte UUID'), false);
      assert.equal(serialized.includes('Sucursal Secreta Org B'), false);

      const rangeQueries = dbState.queryLog.filter(
        (q) => q.table === 'movimientos' && q.selectCols === 'tipo, monto, categoria_id, sucursal_id, fecha'
      );
      const mesQueries = dbState.queryLog.filter(
        (q) => q.table === 'movimientos' && q.selectCols === 'tipo, monto, categoria_id, sucursal_id'
      );
      const recientesQueries = dbState.queryLog.filter(
        (q) => q.table === 'movimientos' && q.limitVal === 5
      );

      assert.equal(rangeQueries.length, 2);
      assert.deepEqual(
        rangeQueries.map((q) => [q.rangeFrom, q.rangeTo]),
        [
          [0, 999],
          [1000, 1999],
        ]
      );
      for (const q of rangeQueries) {
        assert.deepEqual(q.orders, [{ col: 'id', ascending: true }]);
        assert.deepEqual(q.eqFilters, [
          { col: 'org_id', val: ORG_A },
          { col: 'sucursal_id', val: SUC_UUID_A },
        ]);
        assert.deepEqual(q.gteFilters, [{ col: 'fecha', val: prevMonthISO }]);
        assert.deepEqual(q.lteFilters, [{ col: 'fecha', val: todayISO }]);
      }

      assert.equal(mesQueries.length, 2);
      assert.deepEqual(
        mesQueries.map((q) => [q.rangeFrom, q.rangeTo]),
        [
          [0, 999],
          [1000, 1999],
        ]
      );
      for (const q of mesQueries) {
        assert.deepEqual(q.orders, [{ col: 'id', ascending: true }]);
        assert.deepEqual(q.eqFilters, [
          { col: 'org_id', val: ORG_A },
          { col: 'sucursal_id', val: SUC_UUID_A },
        ]);
        assert.deepEqual(q.gteFilters, [{ col: 'fecha', val: mesDesdeISO }]);
        assert.deepEqual(q.lteFilters, [{ col: 'fecha', val: todayISO }]);
      }

      assert.equal(recientesQueries.length, 1);
      assert.deepEqual(recientesQueries[0].eqFilters, [
        { col: 'org_id', val: ORG_A },
        { col: 'sucursal_id', val: SUC_UUID_A },
      ]);

      // UUID en mayusculas se normaliza al id canonico de la sucursal en BD.
      dbState.queryLog = [];
      const upperRes = await requestJson(
        server,
        `/dashboard?desde=${prevMonthISO}&hasta=${todayISO}&include=none&sucursal_id=${SUC_UUID_A.toUpperCase()}`,
        { authorization: 'Bearer valid-token' }
      );
      assert.equal(upperRes.status, 200);
      assert.equal(upperRes.body.meta.items, 1200);
      const upperMovQueries = dbState.queryLog.filter((q) => q.table === 'movimientos');
      assert.equal(upperMovQueries.length, 2);
      for (const q of upperMovQueries) {
        assert.deepEqual(q.eqFilters, [
          { col: 'org_id', val: ORG_A },
          { col: 'sucursal_id', val: SUC_UUID_A },
        ]);
      }

      // Consultas concurrentes sobre distintas sucursales no mezclan resultados.
      const [concA, concB, concEmpty] = await Promise.all([
        requestJson(
          server,
          `/dashboard?desde=${prevMonthISO}&hasta=${todayISO}&include=mes,recientes&limit_recientes=2&sucursal_id=${SUC_UUID_A}`,
          { authorization: 'Bearer valid-token' }
        ),
        requestJson(
          server,
          `/dashboard?desde=${prevMonthISO}&hasta=${todayISO}&include=mes,recientes&limit_recientes=2&sucursal_id=${SUC_UUID_B}`,
          { authorization: 'Bearer valid-token' }
        ),
        requestJson(
          server,
          `/dashboard?desde=${prevMonthISO}&hasta=${todayISO}&include=mes,recientes&limit_recientes=2&sucursal_id=${SUC_UUID_EMPTY}`,
          { authorization: 'Bearer valid-token' }
        ),
      ]);

      assert.equal(concA.status, 200);
      assert.equal(concA.body.meta.items, 1200);
      assert.equal(concB.status, 200);
      assert.equal(concB.body.meta.items, 600);
      assert.equal(concB.body.por_sucursal_mes.length, 1);
      assert.equal(concB.body.por_sucursal_mes[0].sucursal_id, SUC_UUID_B);
      assert.equal(concEmpty.status, 200);
      assert.equal(concEmpty.body.meta.items, 0);
      assert.deepEqual(concEmpty.body.totales, { ingresos: 0, egresos: 0, balance: 0 });
      assert.deepEqual(concEmpty.body.kpis_mes, { ingresos: 0, egresos: 0, balance: 0 });
      assert.deepEqual(concEmpty.body.por_sucursal_mes, []);
      assert.deepEqual(concEmpty.body.recientes, []);
    });

    it('responde 400 con mensaje claro para sucursal_id con UUID invalido sin consultar tablas de dominio', async () => {
      const invalidIds = [
        'no-es-uuid',
        'suc-1',
        '12345',
        '11111111-1111-4111-8111-11111111111',
        '11111111-1111-4111-8111-11111111111z',
        '11111111-1111-4111-8111-111111111111-extra',
      ];

      for (const badId of invalidIds) {
        dbState.queryLog = [];
        const res = await requestJson(
          server,
          `/dashboard?desde=2026-05-01&hasta=2026-05-20&sucursal_id=${encodeURIComponent(badId)}`,
          { authorization: 'Bearer valid-token' }
        );

        assert.equal(res.status, 400, `Expected 400 for sucursal_id=${badId}`);
        assert.deepEqual(res.body, { error: 'El parámetro sucursal_id debe ser un UUID válido' });

        const domainQueries = dbState.queryLog.filter((q) => q.table !== 'organizacion_miembros');
        assert.equal(domainQueries.length, 0, `No domain queries expected for sucursal_id=${badId}`);
      }

      dbState.queryLog = [];
      await assert.rejects(
        () =>
          DashboardService.obtenerDashboard(
            ORG_A,
            { desde: '2026-05-01', hasta: '2026-05-20', sucursal_id: 'invalid-uuid' },
            REF_DATE
          ),
        (err) =>
          err instanceof DashboardValidationError &&
          err.status === 400 &&
          err.message === 'El parámetro sucursal_id debe ser un UUID válido'
      );
      assert.equal(dbState.queryLog.length, 0);
    });

    it('responde 404 Sucursal no encontrada cuando sucursal_id pertenece a otra org o no existe sin consultar movimientos', async () => {
      dbState.sucursales = [
        { id: SUC_UUID_A, org_id: ORG_A, nombre: 'Sucursal Org A' },
        { id: SUC_UUID_OTHER_ORG, org_id: ORG_B, nombre: 'Sucursal Org B' },
      ];
      dbState.movimientos = [
        buildMovimiento(1, { org_id: ORG_A, sucursal_id: SUC_UUID_A, fecha: '2026-05-10' }),
        buildMovimiento(2, { org_id: ORG_B, sucursal_id: SUC_UUID_OTHER_ORG, fecha: '2026-05-10' }),
      ];

      for (const targetSucId of [SUC_UUID_OTHER_ORG, SUC_UUID_MISSING]) {
        dbState.queryLog = [];
        const res = await requestJson(
          server,
          `/dashboard?desde=2026-05-01&hasta=2026-05-20&include=mes,recientes&sucursal_id=${targetSucId}`,
          { authorization: 'Bearer valid-token' }
        );

        assert.equal(res.status, 404, `Expected 404 for sucursal_id=${targetSucId}`);
        assert.deepEqual(res.body, { error: 'Sucursal no encontrada' });

        const sucursalesQueries = dbState.queryLog.filter((q) => q.table === 'sucursales');
        const movQueries = dbState.queryLog.filter((q) => q.table === 'movimientos');
        const catQueries = dbState.queryLog.filter((q) => q.table === 'categorias');
        const pedidoQueries = dbState.queryLog.filter((q) => q.table === 'pedidos');

        assert.equal(sucursalesQueries.length, 1);
        assert.deepEqual(sucursalesQueries[0].eqFilters, [{ col: 'org_id', val: ORG_A }]);
        assert.equal(movQueries.length, 0);
        assert.equal(catQueries.length, 0);
        assert.equal(pedidoQueries.length, 0);

        await assert.rejects(
          () =>
            DashboardService.obtenerDashboard(
              ORG_A,
              { desde: '2026-05-01', hasta: '2026-05-20', sucursal_id: targetSucId },
              REF_DATE
            ),
          (err) =>
            err instanceof DashboardValidationError &&
            err.status === 404 &&
            err.message === 'Sucursal no encontrada'
        );
      }

      dbState.queryLog = [];
      dbState.injectedError = (q) =>
        q.table === 'sucursales' ? new Error('Sucursales lookup failed') : null;
      const errRes = await requestJson(
        server,
        `/dashboard?desde=2026-05-01&hasta=2026-05-20&sucursal_id=${SUC_UUID_A}`,
        { authorization: 'Bearer valid-token' }
      );
      assert.equal(errRes.status, 500);
      assert.deepEqual(errRes.body, { error: 'Error interno del servidor' });
      assert.equal(dbState.queryLog.filter((q) => q.table === 'movimientos').length, 0);
    });

    it('mantiene comportamiento 100% retrocompatible al omitir sucursal_id o enviarlo vacio', async () => {
      const todayISO = obtenerHoyLocalISO(new Date());
      dbState.sucursales = [
        { id: SUC_UUID_A, org_id: ORG_A, nombre: 'Sucursal Centro UUID' },
        { id: SUC_UUID_B, org_id: ORG_A, nombre: 'Sucursal Norte UUID' },
        { id: SUC_UUID_OTHER_ORG, org_id: ORG_B, nombre: 'Sucursal Org B' },
      ];
      dbState.movimientos = [
        buildMovimiento(1, {
          org_id: ORG_A,
          sucursal_id: SUC_UUID_A,
          tipo: 'ingreso',
          monto: 300,
          fecha: todayISO,
          created_at: `${todayISO}T10:00:00.000Z`,
        }),
        buildMovimiento(2, {
          org_id: ORG_A,
          sucursal_id: SUC_UUID_B,
          tipo: 'egreso',
          monto: 120,
          fecha: todayISO,
          created_at: `${todayISO}T11:00:00.000Z`,
        }),
        buildMovimiento(3, {
          org_id: ORG_A,
          sucursal_id: null,
          tipo: 'ingreso',
          monto: 50,
          fecha: todayISO,
          created_at: `${todayISO}T12:00:00.000Z`,
        }),
        buildMovimiento(4, {
          org_id: ORG_B,
          sucursal_id: SUC_UUID_OTHER_ORG,
          tipo: 'ingreso',
          monto: 9999,
          fecha: todayISO,
          created_at: `${todayISO}T13:00:00.000Z`,
        }),
      ];

      const paths = [
        `/dashboard?desde=${todayISO}&hasta=${todayISO}&include=mes,recientes`,
        `/dashboard?desde=${todayISO}&hasta=${todayISO}&include=mes,recientes&sucursal_id=`,
        `/dashboard?desde=${todayISO}&hasta=${todayISO}&include=mes,recientes&sucursal_id=%20%20%20`,
      ];

      let baselineBody = null;
      for (const path of paths) {
        dbState.queryLog = [];
        const res = await requestJson(server, path, { authorization: 'Bearer valid-token' });
        assert.equal(res.status, 200, `Expected 200 for ${path}`);
        assert.equal(res.body.meta.items, 3);
        assert.deepEqual(res.body.totales, { ingresos: 350, egresos: 120, balance: 230 });
        assert.deepEqual(res.body.kpis_mes, { ingresos: 350, egresos: 120, balance: 230 });
        assert.deepEqual(res.body.por_sucursal_mes, [
          {
            sucursal_id: SUC_UUID_A,
            nombre: 'Sucursal Centro UUID',
            ingresos: 300,
            egresos: 0,
            balance: 300,
          },
          {
            sucursal_id: SUC_UUID_B,
            nombre: 'Sucursal Norte UUID',
            ingresos: 0,
            egresos: 120,
            balance: -120,
          },
          {
            sucursal_id: null,
            nombre: 'Sin sucursal',
            ingresos: 50,
            egresos: 0,
            balance: 50,
          },
        ]);
        assert.equal(res.body.recientes.length, 3);

        const movQueries = dbState.queryLog.filter((q) => q.table === 'movimientos');
        assert.ok(movQueries.length >= 3);
        for (const q of movQueries) {
          const hasSucFilter = q.eqFilters.some((f) => f.col === 'sucursal_id');
          assert.equal(hasSucFilter, false, `Unexpected sucursal_id filter for ${path}`);
        }

        if (baselineBody === null) {
          baselineBody = res.body;
        } else {
          assert.deepEqual(res.body, baselineBody);
        }
      }
    });
  });
});
