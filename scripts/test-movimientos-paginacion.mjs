import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

// Dummy env vars must exist before importing dist/lib/supabase.js
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
process.env.SUPABASE_ANON_KEY = 'dummy-anon-key';

const supabaseMod = await import('../dist/lib/supabase.js');
const movimientosServiceMod = await import('../dist/services/movimientos.service.js');
const movimientosRouteMod = await import('../dist/routes/movimientos.js');
const errorMod = await import('../dist/lib/error.js');

const supabaseAdmin = supabaseMod.supabaseAdmin ?? supabaseMod.default.supabaseAdmin;
const supabaseAnon = supabaseMod.supabaseAnon ?? supabaseMod.default.supabaseAnon;
const MovimientosService =
  movimientosServiceMod.MovimientosService ?? movimientosServiceMod.default.MovimientosService;
const normalizarPaginacion =
  movimientosServiceMod.normalizarPaginacion ?? movimientosServiceMod.default.normalizarPaginacion;
const calcularTotalesMovimientos =
  movimientosServiceMod.calcularTotalesMovimientos ?? movimientosServiceMod.default.calcularTotalesMovimientos;
const movimientosRouter = movimientosRouteMod.default?.default ?? movimientosRouteMod.default;
const globalErrorHandler = errorMod.globalErrorHandler ?? errorMod.default.globalErrorHandler;

const ORG_A = 'org-alpha-1111';
const ORG_B = 'org-beta-2222';
const USER_A = { id: 'user-qa-1', email: 'qa@nanoclean.local' };

const dbState = {
  movimientos: [],
  membresias: [],
  injectedError: null,
  queryLog: [],
};

function cloneRow(row) {
  const copy = { ...row };
  if (Array.isArray(row.categorias)) {
    copy.categorias = row.categorias.map((c) => ({ ...c }));
  } else if (row.categorias && typeof row.categorias === 'object') {
    copy.categorias = { ...row.categorias };
  }
  if (Array.isArray(row.sucursales)) {
    copy.sucursales = row.sucursales.map((s) => ({ ...s }));
  } else if (row.sucursales && typeof row.sucursales === 'object') {
    copy.sucursales = { ...row.sucursales };
  }
  return copy;
}

function createSupabaseBuilder(tableName) {
  const state = {
    table: tableName,
    selectCols: null,
    eqFilters: [],
    gteFilters: [],
    lteFilters: [],
    orders: [],
    limitVal: null,
    rangeFrom: null,
    rangeTo: null,
  };

  function runQuery(singleMode) {
    dbState.queryLog.push({
      table: state.table,
      selectCols: state.selectCols,
      eqFilters: state.eqFilters.map((f) => ({ ...f })),
      gteFilters: state.gteFilters.map((f) => ({ ...f })),
      lteFilters: state.lteFilters.map((f) => ({ ...f })),
      orders: state.orders.map((o) => ({ ...o })),
      limitVal: state.limitVal,
      rangeFrom: state.rangeFrom,
      rangeTo: state.rangeTo,
    });

    if (dbState.injectedError) {
      return { data: null, error: dbState.injectedError };
    }

    let source = [];
    if (state.table === 'movimientos') {
      source = dbState.movimientos;
    } else if (state.table === 'organizacion_miembros') {
      source = dbState.membresias;
    }

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

    const cloned = rows.map(cloneRow);
    if (singleMode === 'maybeSingle') {
      return { data: cloned[0] ?? null, error: null };
    }
    return { data: cloned, error: null };
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

function buildMovimiento(index, overrides = {}) {
  const day = String(((index - 1) % 28) + 1).padStart(2, '0');
  const sec = String(index % 60).padStart(2, '0');
  const min = String(Math.floor(index / 60) % 60).padStart(2, '0');
  const isIngreso = index % 2 === 1;
  return {
    id: `mov-${String(index).padStart(3, '0')}`,
    org_id: ORG_A,
    tipo: isIngreso ? 'ingreso' : 'egreso',
    monto: isIngreso ? 100 + index : 40 + index,
    categoria_id: `cat-${(index % 3) + 1}`,
    sucursal_id: `suc-${(index % 2) + 1}`,
    pedido_id: null,
    fecha: `2026-11-${day}`,
    metodo_pago: index % 3 === 0 ? 'Transferencia' : 'Efectivo',
    nota: `Movimiento base ${index}`,
    created_at: `2026-11-${day}T10:${min}:${sec}.000Z`,
    categorias: { id: `cat-${(index % 3) + 1}`, nombre: `Categoria ${(index % 3) + 1}` },
    sucursales: { id: `suc-${(index % 2) + 1}`, nombre: `Sucursal ${(index % 2) + 1}` },
    ...overrides,
  };
}

function roundTwo(value) {
  return Math.round(value * 100) / 100;
}

function computeExpectedTotales(rows) {
  let ingresos = 0;
  let egresos = 0;
  for (const r of rows) {
    if (r.tipo === 'ingreso') ingresos += Number(r.monto);
    if (r.tipo === 'egreso') egresos += Number(r.monto);
  }
  const ing = roundTwo(ingresos);
  const egr = roundTwo(egresos);
  return { ingresos: ing, egresos: egr, balance: roundTwo(ing - egr) };
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

describe('MovimientosService paginacion, filtrado y normalizacion', () => {
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
    dbState.movimientos = [];
    dbState.membresias = [{ user_id: USER_A.id, org_id: ORG_A }];
    dbState.injectedError = null;
    dbState.queryLog = [];
  });

  describe('a) listarMovimientos (sin paginated)', () => {
    it('devuelve arreglo plano normalizado con fallbacks y soporta relaciones objeto y arreglo', async () => {
      dbState.movimientos = [
        buildMovimiento(1, {
          fecha: '2026-11-10',
          created_at: '2026-11-10T09:00:00.000Z',
          categorias: { id: 'cat-1', nombre: 'Lavado' },
          sucursales: { id: 'suc-1', nombre: 'Centro' },
        }),
        buildMovimiento(2, {
          fecha: '2026-11-11',
          created_at: '2026-11-11T09:00:00.000Z',
          categorias: [{ id: 'cat-2', nombre: 'Planchado' }],
          sucursales: [{ id: 'suc-2', nombre: 'Norte' }],
        }),
        buildMovimiento(3, {
          fecha: '2026-11-12',
          created_at: '2026-11-12T09:00:00.000Z',
          categorias: null,
          sucursales: null,
        }),
        buildMovimiento(4, {
          fecha: '2026-11-13',
          created_at: '2026-11-13T09:00:00.000Z',
          categorias: [],
          sucursales: { id: 'suc-x', nombre: '' },
        }),
        buildMovimiento(5, {
          org_id: ORG_B,
          fecha: '2026-11-14',
          categorias: { id: 'cat-b', nombre: 'Otra Org' },
        }),
      ];

      const res = await MovimientosService.listarMovimientos(ORG_A, {});

      assert.equal(Array.isArray(res), true);
      assert.equal(res.length, 4);
      assert.deepEqual(
        res.map((r) => r.id),
        ['mov-004', 'mov-003', 'mov-002', 'mov-001']
      );

      assert.equal(res[0].categoria_nombre, 'Sin categoría');
      assert.equal(res[0].sucursal_nombre, 'Sin sucursal');
      assert.equal(res[1].categoria_nombre, 'Sin categoría');
      assert.equal(res[1].sucursal_nombre, 'Sin sucursal');
      assert.equal(res[2].categoria_nombre, 'Planchado');
      assert.equal(res[2].sucursal_nombre, 'Norte');
      assert.equal(res[3].categoria_nombre, 'Lavado');
      assert.equal(res[3].sucursal_nombre, 'Centro');

      for (const row of res) {
        assert.equal(row.categorias, undefined);
        assert.equal(row.sucursales, undefined);
        assert.equal(row.org_id, ORG_A);
      }
    });

    it('aplica filtros basicos de BD y paginacion range/limit cuando se pasan', async () => {
      dbState.movimientos = [
        buildMovimiento(1, {
          fecha: '2026-11-01',
          tipo: 'ingreso',
          categoria_id: 'cat-1',
          sucursal_id: 'suc-1',
          metodo_pago: 'Efectivo',
          pedido_id: 'ped-1',
        }),
        buildMovimiento(2, {
          fecha: '2026-11-05',
          tipo: 'ingreso',
          categoria_id: 'cat-1',
          sucursal_id: 'suc-1',
          metodo_pago: 'Efectivo',
          pedido_id: 'ped-1',
        }),
        buildMovimiento(3, {
          fecha: '2026-11-06',
          tipo: 'ingreso',
          categoria_id: 'cat-1',
          sucursal_id: 'suc-1',
          metodo_pago: 'Efectivo',
          pedido_id: 'ped-1',
        }),
        buildMovimiento(4, {
          fecha: '2026-11-07',
          tipo: 'egreso',
          categoria_id: 'cat-1',
          sucursal_id: 'suc-1',
          metodo_pago: 'Efectivo',
          pedido_id: 'ped-1',
        }),
      ];

      const res = await MovimientosService.listarMovimientos(ORG_A, {
        desde: '2026-11-02',
        hasta: '2026-11-10',
        tipo: 'ingreso',
        categoria_id: 'cat-1',
        metodo_pago: 'Efectivo',
        sucursal_id: 'suc-1',
        pedido_id: 'ped-1',
        limit: 1,
        offset: 1,
      });

      assert.equal(res.length, 1);
      assert.equal(res[0].id, 'mov-002');
      assert.equal(dbState.queryLog[0].rangeFrom, 1);
      assert.equal(dbState.queryLog[0].rangeTo, 1);
    });

    it('propaga error de Supabase en listarMovimientos', async () => {
      dbState.injectedError = new Error('DB connection lost');
      await assert.rejects(
        () => MovimientosService.listarMovimientos(ORG_A, {}),
        { message: 'DB connection lost' }
      );
    });
  });

  describe('b) listarMovimientosPaginados - dataset de 25 registros', () => {
    it('devuelve pagina 1 (20) y pagina 2 (5) con count 25 y totales globales identicos', async () => {
      const orgARows = [];
      for (let i = 1; i <= 25; i++) {
        orgARows.push(
          buildMovimiento(i, {
            fecha: `2026-11-${String(i).padStart(2, '0')}`,
            created_at: `2026-11-${String(i).padStart(2, '0')}T12:00:00.000Z`,
          })
        );
      }
      const orgBRows = [
        buildMovimiento(901, { org_id: ORG_B, tipo: 'ingreso', monto: 99999 }),
        buildMovimiento(902, { org_id: ORG_B, tipo: 'egreso', monto: 55555 }),
      ];
      dbState.movimientos = [...orgARows, ...orgBRows];

      const expectedTotales = computeExpectedTotales(orgARows);

      const page1 = await MovimientosService.listarMovimientosPaginados(ORG_A, {
        limit: '20',
        offset: '0',
      });
      const page2 = await MovimientosService.listarMovimientosPaginados(ORG_A, {
        limit: 20,
        offset: 20,
      });

      assert.equal(page1.data.length, 20);
      assert.equal(page1.count, 25);
      assert.deepEqual(page1.totales, expectedTotales);

      assert.equal(page2.data.length, 5);
      assert.equal(page2.count, 25);
      assert.deepEqual(page2.totales, page1.totales);

      const idsPage1 = page1.data.map((r) => r.id);
      const idsPage2 = page2.data.map((r) => r.id);
      const allIds = [...idsPage1, ...idsPage2];
      assert.equal(new Set(allIds).size, 25);

      const expectedOrder = [...orgARows]
        .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))
        .map((r) => r.id);
      assert.deepEqual(allIds, expectedOrder);

      assert.equal(dbState.queryLog[0].limitVal, null);
      assert.equal(dbState.queryLog[0].rangeFrom, null);
      assert.equal(dbState.queryLog[1].limitVal, null);
      assert.equal(dbState.queryLog[1].rangeFrom, null);
    });
  });

  describe('c) busqueda textual q en nota, metodo_pago, categoria_nombre y sucursal_nombre', () => {
    it('coincide por los cuatro campos, recalcula count y totales antes de paginar y recorta el slice', async () => {
      const matchingRows = [
        buildMovimiento(1, {
          fecha: '2026-11-25',
          tipo: 'ingreso',
          monto: 150.25,
          nota: 'Pago VIP factura 001',
          metodo_pago: 'Efectivo',
          categorias: { id: 'c1', nombre: 'Tintoreria' },
          sucursales: { id: 's1', nombre: 'Centro' },
        }),
        buildMovimiento(2, {
          fecha: '2026-11-24',
          tipo: 'egreso',
          monto: 40.1,
          nota: 'Compra jabon',
          metodo_pago: 'Transferencia VIP',
          categorias: { id: 'c2', nombre: 'Insumos' },
          sucursales: { id: 's1', nombre: 'Centro' },
        }),
        buildMovimiento(3, {
          fecha: '2026-11-23',
          tipo: 'ingreso',
          monto: 200,
          nota: 'Servicio express',
          metodo_pago: 'Tarjeta',
          categorias: { id: 'c3', nombre: 'Clientes Vip' },
          sucursales: { id: 's2', nombre: 'Norte' },
        }),
        buildMovimiento(4, {
          fecha: '2026-11-22',
          tipo: 'ingreso',
          monto: 50.5,
          nota: 'Entrega domicilio',
          metodo_pago: 'Efectivo',
          categorias: { id: 'c1', nombre: 'Lavado' },
          sucursales: { id: 's3', nombre: 'Plaza vip Sur' },
        }),
        buildMovimiento(5, {
          fecha: '2026-11-21',
          tipo: 'egreso',
          monto: 10.15,
          nota: 'Ajuste vip menor',
          metodo_pago: 'Efectivo',
          categorias: null,
          sucursales: null,
        }),
        buildMovimiento(6, {
          fecha: '2026-11-20',
          tipo: 'ingreso',
          monto: 80,
          nota: 'Abono mensual',
          metodo_pago: 'vip-link',
          categorias: { id: 'c1', nombre: 'Lavado' },
          sucursales: { id: 's1', nombre: 'Centro' },
        }),
        buildMovimiento(7, {
          fecha: '2026-11-19',
          tipo: 'ingreso',
          monto: 20,
          nota: 'Otro servicio',
          metodo_pago: 'Efectivo',
          categorias: { id: 'c4', nombre: 'VIP Especial' },
          sucursales: { id: 's2', nombre: 'Norte' },
        }),
      ];

      const nonMatchingRows = [];
      for (let i = 8; i <= 25; i++) {
        nonMatchingRows.push(
          buildMovimiento(i, {
            fecha: `2026-11-${String(i - 7).padStart(2, '0')}`,
            tipo: 'ingreso',
            monto: 500,
            nota: `Operacion estandar ${i}`,
            metodo_pago: 'Efectivo',
            categorias: { id: 'c-std', nombre: 'General' },
            sucursales: { id: 's-std', nombre: 'Matriz' },
          })
        );
      }

      dbState.movimientos = [...matchingRows, ...nonMatchingRows];
      const expectedFilteredTotales = computeExpectedTotales(matchingRows);

      const resPage2 = await MovimientosService.listarMovimientosPaginados(ORG_A, {
        q: '   vIp  ',
        limit: 4,
        offset: 4,
      });

      assert.equal(resPage2.count, 7);
      assert.equal(resPage2.data.length, 3);
      assert.deepEqual(
        resPage2.data.map((r) => r.id),
        ['mov-005', 'mov-006', 'mov-007']
      );
      assert.deepEqual(resPage2.totales, expectedFilteredTotales);
    });

    it('permite buscar por fallback normalizado y no filtra cuando q solo tiene espacios', async () => {
      dbState.movimientos = [
        buildMovimiento(1, {
          fecha: '2026-11-10',
          categorias: null,
          sucursales: { id: 's1', nombre: 'Centro' },
        }),
        buildMovimiento(2, {
          fecha: '2026-11-09',
          categorias: { id: 'c1', nombre: 'Lavado' },
          sucursales: null,
        }),
      ];

      const byFallbackCat = await MovimientosService.listarMovimientosPaginados(ORG_A, {
        q: '  sin categoría ',
      });
      assert.equal(byFallbackCat.count, 1);
      assert.equal(byFallbackCat.data[0].id, 'mov-001');

      const byFallbackSuc = await MovimientosService.listarMovimientosPaginados(ORG_A, {
        q: ' SIN SUCURSAL ',
      });
      assert.equal(byFallbackSuc.count, 1);
      assert.equal(byFallbackSuc.data[0].id, 'mov-002');

      const blankQ = await MovimientosService.listarMovimientosPaginados(ORG_A, {
        q: '     ',
      });
      assert.equal(blankQ.count, 2);
      assert.equal(blankQ.data.length, 2);
    });
  });

  describe('d) acotado, bordes y precision decimal', () => {
    it('acota limit > 100 a 100 sobre dataset de 120 registros', async () => {
      const rows120 = [];
      for (let i = 1; i <= 120; i++) {
        rows120.push(
          buildMovimiento(i, {
            fecha: `2026-${String(Math.floor((i - 1) / 28) + 1).padStart(2, '0')}-${String(((i - 1) % 28) + 1).padStart(2, '0')}`,
          })
        );
      }
      dbState.movimientos = rows120;
      const expectedTotales = computeExpectedTotales(rows120);

      const page1 = await MovimientosService.listarMovimientosPaginados(ORG_A, {
        limit: 500,
        offset: 0,
      });
      const page2 = await MovimientosService.listarMovimientosPaginados(ORG_A, {
        limit: '999',
        offset: '100',
      });

      assert.equal(page1.data.length, 100);
      assert.equal(page1.count, 120);
      assert.deepEqual(page1.totales, expectedTotales);

      assert.equal(page2.data.length, 20);
      assert.equal(page2.count, 120);
      assert.deepEqual(page2.totales, expectedTotales);
    });

    it('usa default 20 cuando limit <= 0 o no valido y normaliza offset negativo', async () => {
      const rows25 = [];
      for (let i = 1; i <= 25; i++) {
        rows25.push(buildMovimiento(i));
      }
      dbState.movimientos = rows25;

      const invalidLimits = [0, -10, '-5', 'abc', '', null, undefined, Number.NaN, Number.POSITIVE_INFINITY];
      for (const badLimit of invalidLimits) {
        const res = await MovimientosService.listarMovimientosPaginados(ORG_A, {
          limit: badLimit,
          offset: -15,
        });
        assert.equal(res.data.length, 20, `Failed for limit=${String(badLimit)}`);
        assert.equal(res.count, 25);
      }

      assert.deepEqual(normalizarPaginacion('0', '-20'), { limit: 20, offset: 0 });
      assert.deepEqual(normalizarPaginacion('abc', 'xyz'), { limit: 20, offset: 0 });
      assert.deepEqual(normalizarPaginacion(500, -1), { limit: 100, offset: 0 });
    });

    it('devuelve data vacia cuando offset >= count preservando count y totales del periodo', async () => {
      const rows25 = [];
      for (let i = 1; i <= 25; i++) {
        rows25.push(buildMovimiento(i));
      }
      dbState.movimientos = rows25;
      const expectedTotales = computeExpectedTotales(rows25);

      const atBoundary = await MovimientosService.listarMovimientosPaginados(ORG_A, {
        limit: 20,
        offset: 25,
      });
      assert.deepEqual(atBoundary.data, []);
      assert.equal(atBoundary.count, 25);
      assert.deepEqual(atBoundary.totales, expectedTotales);

      const farBeyond = await MovimientosService.listarMovimientosPaginados(ORG_A, {
        limit: 20,
        offset: 500,
      });
      assert.deepEqual(farBeyond.data, []);
      assert.equal(farBeyond.count, 25);
      assert.deepEqual(farBeyond.totales, expectedTotales);
    });

    it('devuelve estructura en ceros para dataset vacio o data null', async () => {
      dbState.movimientos = [];
      const emptyRes = await MovimientosService.listarMovimientosPaginados(ORG_A, {});
      assert.deepEqual(emptyRes, {
        data: [],
        count: 0,
        totales: { ingresos: 0, egresos: 0, balance: 0 },
      });

      dbState.movimientos = null;
      const nullRes = await MovimientosService.listarMovimientosPaginados(ORG_A, {});
      assert.deepEqual(nullRes, {
        data: [],
        count: 0,
        totales: { ingresos: 0, egresos: 0, balance: 0 },
      });
    });

    it('mantiene precision decimal en totales evitando errores IEEE 754 como 0.1 + 0.2', async () => {
      dbState.movimientos = [
        buildMovimiento(1, { tipo: 'ingreso', monto: 0.1 }),
        buildMovimiento(2, { tipo: 'ingreso', monto: 0.2 }),
        buildMovimiento(3, { tipo: 'egreso', monto: 0.1 }),
      ];

      const res = await MovimientosService.listarMovimientosPaginados(ORG_A, {});
      assert.equal(res.totales.ingresos, 0.3);
      assert.equal(res.totales.egresos, 0.1);
      assert.equal(res.totales.balance, 0.2);

      const extraTotales = calcularTotalesMovimientos([
        { ...buildMovimiento(10, { tipo: 'ingreso', monto: 19.99 }), categoria_nombre: 'A', sucursal_nombre: 'B' },
        { ...buildMovimiento(11, { tipo: 'ingreso', monto: 0.01 }), categoria_nombre: 'A', sucursal_nombre: 'B' },
        { ...buildMovimiento(12, { tipo: 'egreso', monto: Number.NaN }), categoria_nombre: 'A', sucursal_nombre: 'B' },
      ]);
      assert.deepEqual(extraTotales, { ingresos: 20, egresos: 0, balance: 20 });
    });

    it('propaga error de Supabase en listarMovimientosPaginados', async () => {
      dbState.injectedError = new Error('Query timeout');
      await assert.rejects(
        () => MovimientosService.listarMovimientosPaginados(ORG_A, { limit: 20, offset: 0 }),
        { message: 'Query timeout' }
      );
    });
  });

  describe('e) integracion HTTP en GET /movimientos (routes/movimientos.js)', () => {
    let server;

    before(async () => {
      const app = express();
      app.use(express.json());
      app.use('/movimientos', movimientosRouter);
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

    it('despacha listado plano sin paginated y estructura paginada con paginated=1 o paginated=TRUE', async () => {
      dbState.movimientos = [
        buildMovimiento(1, { fecha: '2026-11-01', categorias: null, sucursales: null }),
        buildMovimiento(2, { fecha: '2026-11-02' }),
        buildMovimiento(3, { fecha: '2026-11-03' }),
      ];

      const authHeaders = { authorization: 'Bearer valid-token' };

      const flat = await requestJson(server, '/movimientos', authHeaders);
      assert.equal(flat.status, 200);
      assert.equal(Array.isArray(flat.body), true);
      assert.equal(flat.body.length, 3);
      assert.equal(flat.body[2].categoria_nombre, 'Sin categoría');
      assert.equal(flat.body[2].sucursal_nombre, 'Sin sucursal');
      assert.equal('categorias' in flat.body[2], false);
      assert.equal('sucursales' in flat.body[2], false);

      const pag1 = await requestJson(server, '/movimientos?paginated=1&limit=2&offset=0', authHeaders);
      assert.equal(pag1.status, 200);
      assert.equal(pag1.body.count, 3);
      assert.equal(pag1.body.data.length, 2);
      assert.deepEqual(pag1.body.totales, computeExpectedTotales(dbState.movimientos));

      const pagTrue = await requestJson(server, '/movimientos?paginated=TRUE&limit=2&offset=2', authHeaders);
      assert.equal(pagTrue.status, 200);
      assert.equal(pagTrue.body.count, 3);
      assert.equal(pagTrue.body.data.length, 1);
      assert.deepEqual(pagTrue.body.totales, pag1.body.totales);

      const unauth = await requestJson(server, '/movimientos?paginated=1');
      assert.equal(unauth.status, 401);

      const forbiddenOrg = await requestJson(
        server,
        `/movimientos?paginated=1&org_id=${ORG_B}`,
        authHeaders
      );
      assert.equal(forbiddenOrg.status, 403);
    });
  });
});
