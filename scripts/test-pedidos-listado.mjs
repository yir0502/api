import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

// Variables dummy requeridas antes de importar dist/lib/supabase.js
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
process.env.SUPABASE_ANON_KEY = 'dummy-anon-key';

const supabaseMod = await import('../dist/lib/supabase.js');
const pedidosServiceMod = await import('../dist/services/pedidos.service.js');
const pedidosRouteMod = await import('../dist/routes/pedidos.js');
const errorMod = await import('../dist/lib/error.js');

const supabaseAdmin = supabaseMod.supabaseAdmin ?? supabaseMod.default.supabaseAdmin;
const supabaseAnon = supabaseMod.supabaseAnon ?? supabaseMod.default.supabaseAnon;
const SUPABASE_BATCH_SIZE = pedidosServiceMod.SUPABASE_BATCH_SIZE ?? pedidosServiceMod.default.SUPABASE_BATCH_SIZE;
const pedidosRouter = pedidosRouteMod.default?.default ?? pedidosRouteMod.default;
const globalErrorHandler = errorMod.globalErrorHandler ?? errorMod.default.globalErrorHandler;

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUC_1 = '11111111-1111-4111-8111-111111111111';
const SUC_2 = '22222222-2222-4222-8222-222222222222';
const USER_A = { id: 'user-qa-pedidos', email: 'qa@nanoclean.local' };
const AUTH_HEADERS = { authorization: 'Bearer valid-token' };
const POSTGREST_MAX_ROWS = 1000;
const dbState = { pedidos: [], clientes: [], membresias: [], injectedError: null, queryLog: [] };

const cloneRel = (rel) =>
  Array.isArray(rel) ? rel.map((i) => ({ ...i })) : rel && typeof rel === 'object' ? { ...rel } : rel;
const porEstado = (overrides = {}) => ({
  recibido: 0, lavando: 0, secando: 0, doblando: 0, listo: 0, entregado: 0, cancelado: 0, ...overrides,
});
const getPedidosQueries = () => dbState.queryLog.filter((q) => q.table === 'pedidos');
const idsOf = (res) => res.body.data.map((p) => p.id);

function createSupabaseBuilder(tableName) {
  const s = { table: tableName, eqFilters: [], inFilters: [], gtFilters: [], orders: [], limitVal: null, rangeFrom: null, rangeTo: null };

  function runQuery(singleMode) {
    dbState.queryLog.push({
      table: s.table, eqFilters: s.eqFilters.map((f) => ({ ...f })), inFilters: s.inFilters.map((f) => ({ col: f.col, values: [...f.values] })),
      gtFilters: s.gtFilters.map((f) => ({ ...f })), orders: s.orders.map((o) => ({ ...o })), limitVal: s.limitVal, rangeFrom: s.rangeFrom, rangeTo: s.rangeTo,
    });
    if (dbState.injectedError) return { data: null, error: dbState.injectedError };

    const sources = { pedidos: dbState.pedidos, organizacion_miembros: dbState.membresias, clientes: dbState.clientes };
    let rows = (sources[s.table] ?? []).filter((row) => {
      if (s.eqFilters.some((f) => row[f.col] !== f.val)) return false;
      if (s.inFilters.some((f) => !f.values.includes(row[f.col]))) return false;
      return !s.gtFilters.some((f) => row[f.col] == null || !(Number(row[f.col]) > Number(f.val)));
    });

    if (s.orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const ord of s.orders) {
          const av = a[ord.col] ?? '';
          const bv = b[ord.col] ?? '';
          if (av !== bv) return ord.ascending ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
        }
        return 0;
      });
    }

    if (s.rangeFrom !== null && s.rangeTo !== null) rows = rows.slice(s.rangeFrom, s.rangeTo + 1);
    else if (s.limitVal !== null) rows = rows.slice(0, s.limitVal);

    const cloned = rows.slice(0, POSTGREST_MAX_ROWS).map((r) => ({ ...r, clientes: cloneRel(r.clientes), sucursales: cloneRel(r.sucursales) }));
    return { data: singleMode === 'maybeSingle' ? (cloned[0] ?? null) : cloned, error: null };
  }

  const builder = {
    select() { return builder; },
    eq(col, val) { s.eqFilters.push({ col, val }); return builder; },
    in(col, values) { s.inFilters.push({ col, values: [...values] }); return builder; },
    gt(col, val) { s.gtFilters.push({ col, val }); return builder; },
    or() { return builder; },
    order(col, opts) { s.orders.push({ col, ascending: opts?.ascending ?? true }); return builder; },
    limit(n) { s.limitVal = n; return builder; },
    range(from, to) { s.rangeFrom = from; s.rangeTo = to; return builder; },
    maybeSingle() { return Promise.resolve(runQuery('maybeSingle')); },
    then(onFulfilled, onRejected) { return Promise.resolve(runQuery('many')).then(onFulfilled, onRejected); },
  };
  return builder;
}

function buildPedido(index, overrides = {}) {
  const padded = String(index).padStart(4, '0');
  const day = String(((index - 1) % 28) + 1).padStart(2, '0');
  const hour = String(index % 24).padStart(2, '0');
  const min = String(index % 60).padStart(2, '0');
  return {
    id: `ped-${padded}`, org_id: ORG_A, folio: `LAV-${padded}`, cliente_id: `cli-${padded}`, sucursal_id: SUC_1,
    estado: 'recibido', descripcion: `Servicio base ${index}`, monto_total: 100, saldo_pendiente: 0,
    fecha_entrega_estimada: `2026-11-${day}T${hour}:${min}:00.000Z`, fecha_entregado: null,
    created_at: `2026-11-${day}T08:${min}:00.000Z`,
    clientes: { nombre: `Cliente ${index}`, telefono: `550000${padded}` },
    sucursales: { nombre: 'Sucursal Centro' },
    ...overrides,
  };
}

function requestJson(server, pathWithQuery, headers = {}) {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathWithQuery, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /pedidos listado paginado, filtros y retrocompatibilidad', () => {
  let originalFrom;
  let originalGetUser;
  let server;
  const get = (path, headers = AUTH_HEADERS) => requestJson(server, path, headers);

  before(async () => {
    originalFrom = supabaseAdmin.from;
    originalGetUser = supabaseAnon.auth.getUser;
    supabaseAdmin.from = (tableName) => createSupabaseBuilder(tableName);
    supabaseAnon.auth.getUser = async (token) =>
      token === 'valid-token' ? { data: { user: USER_A }, error: null } : { data: { user: null }, error: { message: 'Invalid token' } };

    const app = express();
    app.use(express.json());
    app.use('/pedidos', pedidosRouter);
    app.use(globalErrorHandler);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    supabaseAdmin.from = originalFrom;
    supabaseAnon.auth.getUser = originalGetUser;
  });

  beforeEach(() => {
    Object.assign(dbState, { pedidos: [], clientes: [], membresias: [{ user_id: USER_A.id, org_id: ORG_A }], injectedError: null, queryLog: [] });
  });

  describe('1) Retrocompatibilidad sin paginated', () => {
    it('retorna arreglo plano sin paginated y con paginated=0 o false mapeando relaciones', async () => {
      dbState.pedidos = [
        buildPedido(1, { created_at: '2026-11-10T10:00:00.000Z', clientes: { nombre: 'Ana Perez', telefono: '5511223344' }, sucursales: { nombre: 'Matriz' } }),
        buildPedido(2, { created_at: '2026-11-11T10:00:00.000Z', clientes: [{ nombre: 'Luis Mora', telefono: '5544332211' }], sucursales: [{ nombre: 'Norte' }] }),
        buildPedido(3, { created_at: '2026-11-12T10:00:00.000Z', clientes: null, sucursales: null }),
        buildPedido(4, { org_id: ORG_B, created_at: '2026-11-13T10:00:00.000Z' }),
      ];

      for (const path of ['/pedidos', '/pedidos?paginated=0', '/pedidos?paginated=false']) {
        const res = await get(path);
        assert.equal(res.status, 200);
        assert.equal(Array.isArray(res.body), true);
        assert.deepEqual(res.body.map((p) => p.id), ['ped-0003', 'ped-0002', 'ped-0001']);
        assert.equal(res.body[0].cliente_nombre, 'Cliente Manual');
        assert.equal(res.body[0].cliente_telefono, '');
        assert.equal(res.body[0].sucursal_nombre, 'Sin sucursal');
        assert.equal(res.body[1].cliente_nombre, 'Luis Mora');
        assert.equal(res.body[1].sucursal_nombre, 'Norte');
        assert.equal(typeof res.body[0].whatsapp_automatico, 'boolean');
      }
    });

    it('mantiene compatibilidad con filtros legacy deuda=true y activo=true', async () => {
      dbState.pedidos = [
        buildPedido(1, { estado: 'lavando', saldo_pendiente: 50 }),
        buildPedido(2, { estado: 'entregado', saldo_pendiente: 120 }),
        buildPedido(3, { estado: 'entregado', saldo_pendiente: 0 }),
        buildPedido(4, { estado: 'cancelado', saldo_pendiente: 200 }),
      ];

      const deudas = await get('/pedidos?deuda=true');
      assert.equal(deudas.status, 200);
      assert.equal(Array.isArray(deudas.body), true);
      assert.deepEqual(deudas.body.map((p) => p.id), ['ped-0002']);

      const activos = await get('/pedidos?activo=true');
      assert.equal(activos.status, 200);
      assert.equal(Array.isArray(activos.body), true);
      assert.deepEqual(activos.body.map((p) => p.id), ['ped-0001']);
    });
  });

  describe('2) Activos en lotes (>1000 filas) y ordenamiento por urgencia', () => {
    it('itera lotes de 1000 filas ordenados por id sin truncar activos ni count', async () => {
      const estadosActivos = ['recibido', 'lavando', 'secando', 'doblando', 'listo'];
      dbState.pedidos = [
        ...Array.from({ length: 1250 }, (_, idx) => buildPedido(idx + 1, { estado: estadosActivos[idx % 5] })),
        buildPedido(2001, { estado: 'entregado', fecha_entregado: '2026-11-20T10:00:00.000Z' }),
        buildPedido(2002, { estado: 'cancelado' }),
        buildPedido(2003, { org_id: ORG_B, estado: 'lavando' }),
      ];

      const res = await get('/pedidos?paginated=1&activo=true&limit=20&offset=0');
      assert.equal(SUPABASE_BATCH_SIZE, 1000);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1250);
      assert.equal(res.body.count, 1250);
      assert.equal(res.body.resumen.total, 1250);
      assert.equal(res.body.resumen.en_proceso, 1000);
      assert.equal(res.body.resumen.listos, 250);
      assert.equal(res.body.data.every((p) => p.org_id === ORG_A && p.estado !== 'entregado' && p.estado !== 'cancelado'), true);

      const queries = getPedidosQueries();
      assert.equal(queries.length, 2);
      assert.deepEqual(queries.map((q) => [q.rangeFrom, q.rangeTo]), [[0, 999], [1000, 1999]]);
      for (const q of queries) {
        assert.deepEqual(q.orders, [{ col: 'id', ascending: true }]);
        assert.equal(q.eqFilters.some((f) => f.col === 'org_id' && f.val === ORG_A), true);
      }
    });

    it('ordena activos por fecha_entrega_estimada ASC con nulos y vacios al final y desempate created_at DESC', async () => {
      dbState.pedidos = [
        buildPedido(1, { id: 'ped-empty', fecha_entrega_estimada: '', created_at: '2026-11-27T09:00:00.000Z' }),
        buildPedido(2, { id: 'ped-tie-old', fecha_entrega_estimada: '2026-11-29T10:00:00.000Z', created_at: '2026-11-27T08:00:00.000Z' }),
        buildPedido(3, { id: 'ped-null', fecha_entrega_estimada: null, created_at: '2026-11-27T15:00:00.000Z' }),
        buildPedido(4, { id: 'ped-first', fecha_entrega_estimada: '2026-11-28T10:00:00.000Z', created_at: '2026-11-27T07:00:00.000Z' }),
        buildPedido(5, { id: 'ped-tie-new', fecha_entrega_estimada: '2026-11-29T10:00:00.000Z', created_at: '2026-11-27T12:00:00.000Z' }),
      ];

      const res = await get('/pedidos?paginated=TRUE');
      assert.equal(res.status, 200);
      assert.deepEqual(idsOf(res), ['ped-first', 'ped-tie-new', 'ped-tie-old', 'ped-null', 'ped-empty']);
    });
  });

  describe('3) Estabilidad de resumen en Activos, estado legacy y umbral de cobro', () => {
    it('preserva resumen del universo activo al filtrar estado o solo_por_cobrar e ignora saldo <= 0.005', async () => {
      dbState.pedidos = [
        buildPedido(1, { estado: 'recibido', saldo_pendiente: 100.1 }),
        buildPedido(2, { estado: 'lavando', saldo_pendiente: 0.005 }),
        buildPedido(3, { estado: 'secando', saldo_pendiente: 0.004 }),
        buildPedido(4, { estado: 'doblando', saldo_pendiente: 0 }),
        buildPedido(5, { estado: 'en_proceso', saldo_pendiente: 0 }),
        buildPedido(6, { estado: 'listo', saldo_pendiente: 50.2 }),
      ];
      const expectedResumen = {
        total: 6, en_proceso: 5, listos: 1, por_cobrar_count: 2, por_cobrar_monto: 150.3,
        por_estado: porEstado({ recibido: 1, lavando: 1, secando: 1, doblando: 1, listo: 1 }),
      };

      const base = await get('/pedidos?paginated=1&activo=true');
      assert.equal(base.status, 200);
      assert.equal(base.body.count, 6);
      assert.deepEqual(base.body.resumen, expectedResumen);
      assert.deepEqual(Object.keys(base.body.resumen.por_estado).sort(), Object.keys(porEstado()).sort());

      const soloListos = await get('/pedidos?paginated=1&activo=true&estado=listo');
      assert.equal(soloListos.body.count, 1);
      assert.deepEqual(idsOf(soloListos), ['ped-0006']);
      assert.deepEqual(soloListos.body.resumen, expectedResumen);

      const porCobrar = await get('/pedidos?paginated=1&activo=true&solo_por_cobrar=true');
      assert.equal(porCobrar.body.count, 2);
      assert.deepEqual(idsOf(porCobrar).sort(), ['ped-0001', 'ped-0006']);
      assert.deepEqual(porCobrar.body.resumen, expectedResumen);
    });

    it('acota resumen de activos tras sucursal_id y q manteniendolo estable al filtrar estado', async () => {
      dbState.pedidos = [
        buildPedido(1, { sucursal_id: SUC_1, estado: 'lavando', descripcion: 'Lavado express', saldo_pendiente: 80 }),
        buildPedido(2, { sucursal_id: SUC_1, estado: 'listo', descripcion: 'Planchado express', saldo_pendiente: 40 }),
        buildPedido(3, { sucursal_id: SUC_1, estado: 'listo', descripcion: 'Servicio normal', saldo_pendiente: 200 }),
        buildPedido(4, { sucursal_id: SUC_2, estado: 'listo', descripcion: 'Lavado express', saldo_pendiente: 300 }),
      ];

      const universo = await get(`/pedidos?paginated=1&sucursal_id=${SUC_1}&q=express`);
      assert.equal(universo.status, 200);
      assert.equal(universo.body.count, 2);
      assert.equal(universo.body.resumen.total, 2);
      assert.equal(universo.body.resumen.por_cobrar_monto, 120);

      const filtrado = await get(`/pedidos?paginated=1&sucursal_id=${SUC_1}&q=express&estado=listo`);
      assert.equal(filtrado.body.count, 1);
      assert.deepEqual(idsOf(filtrado), ['ped-0002']);
      assert.deepEqual(filtrado.body.resumen, universo.body.resumen);
      assert.equal(getPedidosQueries().every((q) => q.eqFilters.some((f) => f.col === 'sucursal_id' && f.val === SUC_1)), true);
    });
  });

  describe('4) Historial paginado (activo=false) y cancelados fuera de por_cobrar', () => {
    it('pagina historial con orden fecha_entregado DESC NULLS LAST y excluye cancelados de por_cobrar', async () => {
      dbState.pedidos = [
        buildPedido(1, { id: 'hist-1', estado: 'entregado', fecha_entregado: '2026-11-25T14:00:00.000Z', created_at: '2026-11-20T10:00:00.000Z', saldo_pendiente: 125.1 }),
        buildPedido(2, { id: 'hist-2', estado: 'entregado', fecha_entregado: '2026-11-24T10:00:00.000Z', created_at: '2026-11-22T12:00:00.000Z', saldo_pendiente: 74.2 }),
        buildPedido(3, { id: 'hist-3', estado: 'entregado', fecha_entregado: '2026-11-24T10:00:00.000Z', created_at: '2026-11-21T08:00:00.000Z', saldo_pendiente: 0 }),
        buildPedido(4, { id: 'hist-4', estado: 'cancelado', fecha_entregado: null, created_at: '2026-11-26T18:00:00.000Z', saldo_pendiente: 500 }),
        buildPedido(5, { id: 'hist-5', estado: 'cancelado', fecha_entregado: null, created_at: '2026-11-23T09:00:00.000Z', saldo_pendiente: 200 }),
        buildPedido(6, { id: 'act-1', estado: 'listo', saldo_pendiente: 999 }),
      ];
      const expectedResumen = {
        total: 5, en_proceso: 0, listos: 0, por_cobrar_count: 2, por_cobrar_monto: 199.3,
        por_estado: porEstado({ entregado: 3, cancelado: 2 }),
      };

      const p1 = await get('/pedidos?paginated=1&activo=false&limit=2&offset=0');
      const p2 = await get('/pedidos?paginated=1&activo=false&limit=2&offset=2');
      const p3 = await get('/pedidos?paginated=1&activo=false&limit=2&offset=4');
      const pEmpty = await get('/pedidos?paginated=1&activo=false&limit=2&offset=20');

      assert.deepEqual([...idsOf(p1), ...idsOf(p2), ...idsOf(p3)], ['hist-1', 'hist-2', 'hist-3', 'hist-4', 'hist-5']);
      for (const page of [p1, p2, p3, pEmpty]) {
        assert.equal(page.status, 200);
        assert.equal(page.body.count, 5);
        assert.deepEqual(page.body.resumen, expectedResumen);
      }
      assert.deepEqual(pEmpty.body.data, []);

      const soloDeuda = await get('/pedidos?paginated=1&activo=false&solo_por_cobrar=true');
      assert.deepEqual(idsOf(soloDeuda), ['hist-1', 'hist-2']);
      assert.equal(soloDeuda.body.count, 2);
      assert.equal(soloDeuda.body.resumen.por_estado.cancelado, 0);
    });

    it('acumula >1000 filas de historial en lotes preservando count y resumen paginado', async () => {
      dbState.pedidos = Array.from({ length: 1150 }, (_, idx) => {
        const i = idx + 1;
        const esCancelado = i > 900;
        const day = String((idx % 28) + 1).padStart(2, '0');
        return buildPedido(i, {
          estado: esCancelado ? 'cancelado' : 'entregado',
          fecha_entregado: esCancelado ? null : `2026-11-${day}T12:00:00.000Z`,
          saldo_pendiente: esCancelado ? 999 : i <= 100 ? 25.5 : 0,
        });
      });

      const res = await get('/pedidos?paginated=1&activo=false&limit=20&offset=20');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 20);
      assert.equal(res.body.count, 1150);
      assert.equal(res.body.resumen.total, 1150);
      assert.equal(res.body.resumen.por_estado.entregado, 900);
      assert.equal(res.body.resumen.por_estado.cancelado, 250);
      assert.equal(res.body.resumen.por_cobrar_count, 100);
      assert.equal(res.body.resumen.por_cobrar_monto, 2550);
      assert.deepEqual(getPedidosQueries().map((q) => [q.rangeFrom, q.rangeTo]), [[0, 999], [1000, 1999]]);
    });
  });

  describe('5) Filtros combinados en Historial y Activos', () => {
    it('filtra historial por sucursal_id, estado y desde/hasta sobre fecha_entregado con fallback a created_at', async () => {
      dbState.pedidos = [
        buildPedido(1, { id: 'f-ent-in', sucursal_id: SUC_1, estado: 'entregado', created_at: '2026-10-01T10:00:00.000Z', fecha_entregado: '2026-11-15T14:00:00.000Z' }),
        buildPedido(2, { id: 'f-ent-out', sucursal_id: SUC_1, estado: 'entregado', created_at: '2026-11-12T10:00:00.000Z', fecha_entregado: '2026-11-25T14:00:00.000Z' }),
        buildPedido(3, { id: 'f-can-fb', sucursal_id: SUC_1, estado: 'cancelado', created_at: '2026-11-10T08:00:00.000Z', fecha_entregado: null }),
        buildPedido(4, { id: 'f-ent-end', sucursal_id: SUC_1, estado: 'entregado', created_at: '2026-11-05T08:00:00.000Z', fecha_entregado: '2026-11-20T23:59:59.000Z' }),
        buildPedido(5, { id: 'f-suc2', sucursal_id: SUC_2, estado: 'entregado', created_at: '2026-11-15T08:00:00.000Z', fecha_entregado: '2026-11-16T10:00:00.000Z' }),
        buildPedido(6, { id: 'f-sin-fecha', sucursal_id: SUC_1, estado: 'cancelado', created_at: null, fecha_entregado: null }),
      ];

      const basePath = `/pedidos?paginated=1&activo=false&sucursal_id=${SUC_1}&desde=2026-11-10&hasta=2026-11-20`;
      const rango = await get(basePath);
      assert.equal(rango.status, 200);
      assert.equal(rango.body.count, 3);
      assert.deepEqual(idsOf(rango), ['f-ent-end', 'f-ent-in', 'f-can-fb']);

      assert.deepEqual(idsOf(await get(`${basePath}&estado=entregado`)), ['f-ent-end', 'f-ent-in']);
      assert.deepEqual(idsOf(await get(`${basePath}&estado=cancelado`)), ['f-can-fb']);

      dbState.queryLog = [];
      const estadoActivo = await get('/pedidos?paginated=1&activo=false&estado=listo');
      assert.equal(estadoActivo.status, 200);
      assert.equal(estadoActivo.body.count, 0);
      assert.deepEqual(estadoActivo.body.data, []);
      assert.equal(getPedidosQueries().length, 0);
    });

    it('filtra q por folio, URL QR LAV-XXXX, descripcion, cliente nombre/telefono y sin falso positivo Cliente Manual', async () => {
      dbState.pedidos = [
        buildPedido(1, { id: 'q-1', estado: 'recibido', folio: 'LAV-9K2M', descripcion: 'Traje gris', clientes: { nombre: 'Ana Perez', telefono: '5511223344' } }),
        buildPedido(2, { id: 'q-2', estado: 'lavando', folio: 'LAV-3P4Q', descripcion: 'Edredon king plumas', clientes: [{ nombre: 'Carlos Ruiz', telefono: '5599887766' }] }),
        buildPedido(3, { id: 'q-3', estado: 'listo', folio: 'LAV-7X8Y', descripcion: 'Ropa diaria', clientes: null }),
        buildPedido(4, { id: 'q-4', estado: 'entregado', folio: 'LAV-5Z6W', descripcion: 'Cortinas sala', fecha_entregado: '2026-11-18T10:00:00.000Z', clientes: { nombre: 'Lucia Vega', telefono: '5544332211' } }),
      ];

      const casosActivos = [
        ['lav-9k2m', ['q-1']],
        [encodeURIComponent('https://nano-clean-app.vercel.app/rastreo/org-1/lav-9k2m?from=qr'), ['q-1']],
        ['edredon', ['q-2']],
        ['carlos', ['q-2']],
        ['112233', ['q-1']],
        [encodeURIComponent('Cliente Manual'), []],
      ];
      for (const [qParam, expectedIds] of casosActivos) {
        const res = await get(`/pedidos?paginated=1&activo=true&q=${qParam}`);
        assert.equal(res.status, 200);
        assert.deepEqual(idsOf(res), expectedIds, `Fallo para q=${qParam}`);
      }

      assert.equal((await get('/pedidos?paginated=1&activo=true&q=%20%20%20')).body.count, 3);
      const qrHist = encodeURIComponent('https://nano-clean-app.vercel.app/rastreo/org-1/LAV-5Z6W');
      assert.deepEqual(idsOf(await get(`/pedidos?paginated=1&activo=false&q=${qrHist}`)), ['q-4']);
      assert.deepEqual(idsOf(await get('/pedidos?paginated=1&activo=false&q=554433')), ['q-4']);
    });
  });

  describe('6) Validaciones HTTP 400', () => {
    async function assertInvalidQueries(queries) {
      for (const qs of queries) {
        dbState.queryLog = [];
        const res = await get(`/pedidos?paginated=1&${qs}`);
        assert.equal(res.status, 400, `Se esperaba 400 para ${qs}`);
        assert.equal(typeof res.body?.error, 'string');
        assert.ok(res.body.error.length > 0);
        assert.equal(getPedidosQueries().length, 0);
      }
    }

    it('rechaza con 400 activo, sucursal_id, estado (incluyendo en_proceso) y solo_por_cobrar invalidos', async () => {
      await assertInvalidQueries([
        'activo=si', 'activo=1', 'sucursal_id=no-es-uuid',
        'estado=desconocido', 'estado=en_proceso', 'solo_por_cobrar=yes', 'solo_por_cobrar=2',
      ]);
    });

    it('rechaza con 400 fechas imposibles, desde > hasta y limit/offset invalidos', async () => {
      await assertInvalidQueries([
        'activo=false&desde=2026-02-30', 'activo=false&hasta=2026-13-01', 'activo=false&desde=2026-02-29',
        'activo=false&desde=2026-11-20&hasta=2026-11-10',
        'limit=0', 'limit=101', 'limit=10.5', 'offset=-1', 'offset=1.5',
      ]);
    });
  });

  describe('7) Seguridad y aislamiento multi-tenant', () => {
    it('retorna 401 sin autorizacion o token invalido y 403 sin membresia en la organizacion', async () => {
      assert.equal((await get('/pedidos?paginated=1', {})).status, 401);
      assert.equal((await get('/pedidos?paginated=1', { authorization: 'Bearer invalid-token' })).status, 401);
      assert.equal((await get(`/pedidos?paginated=1&org_id=${ORG_B}`)).status, 403);
      assert.equal((await get('/pedidos?paginated=1', { ...AUTH_HEADERS, 'x-org-id': ORG_B })).status, 403);

      dbState.membresias = [];
      assert.equal((await get('/pedidos?paginated=1')).status, 403);
      assert.equal(getPedidosQueries().length, 0);
    });

    it('aisla estrictamente por org_id en legacy, activos e historial sin filtrar datos de otra organizacion', async () => {
      dbState.pedidos = [
        buildPedido(1, { org_id: ORG_A, estado: 'lavando', saldo_pendiente: 50 }),
        buildPedido(2, { org_id: ORG_A, estado: 'entregado', fecha_entregado: '2026-11-20T10:00:00.000Z', saldo_pendiente: 30 }),
        buildPedido(3, { org_id: ORG_B, estado: 'lavando', saldo_pendiente: 99999 }),
        buildPedido(4, { org_id: ORG_B, estado: 'entregado', fecha_entregado: '2026-11-20T10:00:00.000Z', saldo_pendiente: 88888 }),
      ];

      const legacy = await get('/pedidos');
      assert.equal(legacy.status, 200);
      assert.equal(legacy.body.length, 2);
      assert.equal(legacy.body.every((p) => p.org_id === ORG_A), true);

      const activos = await get('/pedidos?paginated=1&activo=true');
      assert.equal(activos.status, 200);
      assert.deepEqual([activos.body.count, activos.body.data[0].org_id, activos.body.resumen.por_cobrar_monto], [1, ORG_A, 50]);

      const historial = await get('/pedidos?paginated=1&activo=false');
      assert.equal(historial.status, 200);
      assert.deepEqual([historial.body.count, historial.body.data[0].org_id, historial.body.resumen.por_cobrar_monto], [1, ORG_A, 30]);

      const queries = getPedidosQueries();
      assert.equal(queries.length, 3);
      assert.equal(queries.every((q) => q.eqFilters.some((f) => f.col === 'org_id' && f.val === ORG_A)), true);
    });
  });
});
