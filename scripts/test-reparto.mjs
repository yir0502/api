import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

// Dummy env vars must exist before importing dist/lib/supabase.js
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
process.env.SUPABASE_ANON_KEY = 'dummy-anon-key';

const supabaseMod = await import('../dist/lib/supabase.js');
const repartoServiceMod = await import('../dist/services/reparto.service.js');
const sucursalesRouteMod = await import('../dist/routes/sucursales.js');
const errorMod = await import('../dist/lib/error.js');

const supabaseAdmin = supabaseMod.supabaseAdmin ?? supabaseMod.default.supabaseAdmin;
const supabaseAnon = supabaseMod.supabaseAnon ?? supabaseMod.default.supabaseAnon;
const RepartoService =
  repartoServiceMod.RepartoService ?? repartoServiceMod.default.RepartoService;
const RepartoValidationError =
  repartoServiceMod.RepartoValidationError ?? repartoServiceMod.default.RepartoValidationError;
const sucursalesRouter = sucursalesRouteMod.default?.default ?? sucursalesRouteMod.default;
const globalErrorHandler = errorMod.globalErrorHandler ?? errorMod.default.globalErrorHandler;

const ORG_A = 'aaaa0000-0000-4000-8000-000000000001';
const ORG_B = 'bbbb0000-0000-4000-8000-000000000002';

const SUC_A1 = '11111111-1111-4111-8111-111111111111';
const SUC_A2 = '22222222-2222-4222-8222-222222222222';
const SUC_B1 = '33333333-3333-4333-8333-333333333333';
const SUC_MISSING = '99999999-9999-4999-8999-999999999999';

const USER_A = { id: 'user-qa-rep-a', email: 'qa-rep-a@nanoclean.local' };
const USER_MULTI = { id: 'user-qa-rep-multi', email: 'qa-rep-multi@nanoclean.local' };
const USER_NO_ORG = { id: 'user-qa-rep-noorg', email: 'qa-rep-noorg@nanoclean.local' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dbState = {
  sucursales: [],
  sucursalRepartoConfig: [],
  membresias: [],
  injectedError: null,
  queryLog: [],
  upsertLog: [],
};

function cloneValue(val) {
  if (val === undefined) return undefined;
  return structuredClone(val);
}

function projectRow(row, selectCols) {
  if (!selectCols || selectCols.trim() === '*') {
    return cloneValue(row);
  }
  const cols = selectCols
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const projected = {};
  for (const col of cols) {
    projected[col] = col in row ? cloneValue(row[col]) : undefined;
  }
  return projected;
}

function getTableSource(tableName) {
  if (tableName === 'sucursales') return dbState.sucursales;
  if (tableName === 'sucursal_reparto_config') return dbState.sucursalRepartoConfig;
  if (tableName === 'organizacion_miembros') return dbState.membresias;
  return [];
}

function createSupabaseBuilder(tableName) {
  const state = {
    table: tableName,
    operation: 'select',
    selectCols: null,
    eqFilters: [],
    upsertPayload: null,
    upsertOptions: null,
  };

  function runQuery(singleMode) {
    const queryEntry = {
      table: state.table,
      operation: state.operation,
      selectCols: state.selectCols,
      eqFilters: state.eqFilters.map((f) => ({ ...f })),
      upsertPayload: cloneValue(state.upsertPayload),
      upsertOptions: state.upsertOptions ? { ...state.upsertOptions } : null,
    };
    dbState.queryLog.push(queryEntry);

    if (state.operation === 'upsert') {
      dbState.upsertLog.push({
        table: state.table,
        payload: cloneValue(state.upsertPayload),
        options: state.upsertOptions ? { ...state.upsertOptions } : null,
      });
    }

    if (typeof dbState.injectedError === 'function') {
      const err = dbState.injectedError(queryEntry);
      if (err) {
        return { data: null, error: err };
      }
    } else if (dbState.injectedError) {
      return { data: null, error: dbState.injectedError };
    }

    const source = getTableSource(state.table);

    if (state.operation === 'upsert') {
      const rowToSave = cloneValue(state.upsertPayload);
      const conflictCols = String(state.upsertOptions?.onConflict || '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);

      let existingIndex = -1;
      if (conflictCols.length > 0) {
        existingIndex = source.findIndex((existing) =>
          conflictCols.every((col) => existing[col] === rowToSave[col])
        );
      }

      if (existingIndex >= 0) {
        source[existingIndex] = rowToSave;
      } else {
        source.push(rowToSave);
      }

      const projected = projectRow(rowToSave, state.selectCols);
      if (singleMode === 'single' || singleMode === 'maybeSingle') {
        return { data: projected, error: null };
      }
      return { data: [projected], error: null };
    }

    const rows = source.filter((row) =>
      state.eqFilters.every((f) => row[f.col] === f.val)
    );
    const projected = rows.map((row) => projectRow(row, state.selectCols));

    if (singleMode === 'maybeSingle') {
      return { data: projected[0] ?? null, error: null };
    }
    if (singleMode === 'single') {
      if (projected.length === 0) {
        return { data: null, error: { code: 'PGRST116', message: 'Row not found' } };
      }
      return { data: projected[0], error: null };
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
    upsert(payload, options) {
      state.operation = 'upsert';
      state.upsertPayload = cloneValue(payload);
      state.upsertOptions = options ? { ...options } : null;
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(runQuery('maybeSingle'));
    },
    single() {
      return Promise.resolve(runQuery('single'));
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve(runQuery('many')).then(onFulfilled, onRejected);
    },
  };

  return builder;
}

async function requestJson(server, method, pathWithQuery, { headers = {}, body } = {}) {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const serializedBody = body !== undefined ? JSON.stringify(body) : null;
  const reqHeaders = { ...headers };
  if (serializedBody !== null) {
    reqHeaders['content-type'] = 'application/json';
    reqHeaders['content-length'] = Buffer.byteLength(serializedBody);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathWithQuery,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : null,
          });
        });
      }
    );
    req.on('error', reject);
    if (serializedBody !== null) {
      req.write(serializedBody);
    }
    req.end();
  });
}

describe('RepartoService y rutas HTTP /sucursales/:id/reparto', () => {
  let originalFrom;
  let originalGetUser;
  let server;

  before(async () => {
    originalFrom = supabaseAdmin.from;
    originalGetUser = supabaseAnon.auth.getUser;

    supabaseAdmin.from = (tableName) => createSupabaseBuilder(tableName);
    supabaseAnon.auth.getUser = async (token) => {
      if (token === 'valid-token-a') {
        return { data: { user: USER_A }, error: null };
      }
      if (token === 'valid-token-multi') {
        return { data: { user: USER_MULTI }, error: null };
      }
      if (token === 'valid-token-no-org') {
        return { data: { user: USER_NO_ORG }, error: null };
      }
      return { data: { user: null }, error: { message: 'Invalid token' } };
    };

    const app = express();
    app.use(express.json());
    app.use('/sucursales', sucursalesRouter);
    app.use(globalErrorHandler);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    supabaseAdmin.from = originalFrom;
    supabaseAnon.auth.getUser = originalGetUser;
  });

  beforeEach(() => {
    dbState.sucursales = [
      { id: SUC_A1, org_id: ORG_A, nombre: 'Sucursal Centro' },
      { id: SUC_A2, org_id: ORG_A, nombre: 'Sucursal Norte' },
      { id: SUC_B1, org_id: ORG_B, nombre: 'Sucursal Org B' },
    ];
    dbState.sucursalRepartoConfig = [];
    dbState.membresias = [
      { user_id: USER_A.id, org_id: ORG_A },
      { user_id: USER_MULTI.id, org_id: ORG_A },
      { user_id: USER_MULTI.id, org_id: ORG_B },
    ];
    dbState.injectedError = null;
    dbState.queryLog = [];
    dbState.upsertLog = [];
  });

  describe('Caso 1: GET /sucursales/:id/reparto sin registro previo y normalizacion desde BD', () => {
    it('retorna 200 con configuracion por defecto y configurado false cuando no existe registro previo', async () => {
      const res = await requestJson(server, 'GET', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
      });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        sucursal_id: SUC_A1,
        capital_pct: 0,
        socios: [],
        updated_at: null,
        configurado: false,
      });

      const sucQueries = dbState.queryLog.filter((q) => q.table === 'sucursales');
      const repQueries = dbState.queryLog.filter((q) => q.table === 'sucursal_reparto_config');
      assert.equal(sucQueries.length, 1);
      assert.deepEqual(sucQueries[0].eqFilters, [
        { col: 'id', val: SUC_A1 },
        { col: 'org_id', val: ORG_A },
      ]);
      assert.equal(repQueries.length, 1);
      assert.deepEqual(repQueries[0].eqFilters, [
        { col: 'org_id', val: ORG_A },
        { col: 'sucursal_id', val: SUC_A1 },
      ]);
      assert.equal(dbState.upsertLog.length, 0);
    });

    it('normaliza valores numeric en texto provenientes de PostgreSQL al leer configuracion existente', async () => {
      dbState.sucursalRepartoConfig.push({
        org_id: ORG_A,
        sucursal_id: SUC_A1,
        capital_pct: '25.50',
        socios: [
          { id: 'soc-1', nombre: '  Socio Alfa  ', pct: '37.25' },
          { id: '', nombre: 'Socio Beta', pct: 37.25 },
        ],
        updated_at: '2026-05-15T12:00:00.000Z',
      });

      const res = await requestJson(server, 'GET', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
      });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        sucursal_id: SUC_A1,
        capital_pct: 25.5,
        socios: [
          { id: 'soc-1', nombre: 'Socio Alfa', pct: 37.25 },
          { id: 'socio-2', nombre: 'Socio Beta', pct: 37.25 },
        ],
        updated_at: '2026-05-15T12:00:00.000Z',
        configurado: true,
      });
    });
  });

  describe('Caso 2: PUT /sucursales/:id/reparto valido con upsert atomico y lectura subsecuente', () => {
    it('guarda capital_pct > 0 y socios sumando 100% con onConflict org_id,sucursal_id y persiste para GET posterior', async () => {
      const putRes = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
        body: {
          capital_pct: 20,
          socios: [
            { id: 'socio-principal', nombre: '  Ana Perez  ', pct: 40 },
            { id: 'socio-principal', nombre: 'Luis Gomez', pct: 40 },
          ],
        },
      });

      assert.equal(putRes.status, 200);
      assert.equal(putRes.body.sucursal_id, SUC_A1);
      assert.equal(putRes.body.capital_pct, 20);
      assert.equal(putRes.body.configurado, true);
      assert.equal(typeof putRes.body.updated_at, 'string');
      assert.equal(Number.isNaN(Date.parse(putRes.body.updated_at)), false);
      assert.equal(putRes.body.socios.length, 2);
      assert.deepEqual(putRes.body.socios[0], {
        id: 'socio-principal',
        nombre: 'Ana Perez',
        pct: 40,
      });
      assert.equal(putRes.body.socios[1].nombre, 'Luis Gomez');
      assert.equal(putRes.body.socios[1].pct, 40);
      assert.notEqual(putRes.body.socios[1].id, 'socio-principal');
      assert.match(putRes.body.socios[1].id, UUID_RE);

      assert.equal(dbState.upsertLog.length, 1);
      assert.equal(dbState.upsertLog[0].table, 'sucursal_reparto_config');
      assert.deepEqual(dbState.upsertLog[0].options, { onConflict: 'org_id,sucursal_id' });
      assert.equal(dbState.upsertLog[0].payload.org_id, ORG_A);
      assert.equal(dbState.upsertLog[0].payload.sucursal_id, SUC_A1);
      assert.equal(dbState.upsertLog[0].payload.capital_pct, 20);

      const getRes = await requestJson(server, 'GET', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
      });

      assert.equal(getRes.status, 200);
      assert.deepEqual(getRes.body, putRes.body);
    });

    it('soporta decimales exactos (33.33 + 33.33 + 33.34) y actualiza en sitio mediante upsert sin duplicar filas', async () => {
      const firstPut = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
        body: {
          capital_pct: 12.5,
          socios: [
            { nombre: 'Socio Uno', pct: 43.75 },
            { nombre: 'Socio Dos', pct: 43.75 },
          ],
        },
      });
      assert.equal(firstPut.status, 200);
      assert.equal(firstPut.body.configurado, true);
      assert.equal(firstPut.body.capital_pct, 12.5);
      assert.match(firstPut.body.socios[0].id, UUID_RE);
      assert.match(firstPut.body.socios[1].id, UUID_RE);
      assert.notEqual(firstPut.body.socios[0].id, firstPut.body.socios[1].id);

      const secondPut = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
        body: {
          capital_pct: 0,
          socios: [
            { id: 's-1', nombre: 'Socio A', pct: 33.33 },
            { id: 's-2', nombre: 'Socio B', pct: 33.33 },
            { id: 's-3', nombre: 'Socio C', pct: 33.34 },
          ],
        },
      });

      assert.equal(secondPut.status, 200);
      assert.equal(secondPut.body.sucursal_id, SUC_A1);
      assert.equal(secondPut.body.capital_pct, 0);
      assert.equal(secondPut.body.configurado, true);
      assert.deepEqual(secondPut.body.socios, [
        { id: 's-1', nombre: 'Socio A', pct: 33.33 },
        { id: 's-2', nombre: 'Socio B', pct: 33.33 },
        { id: 's-3', nombre: 'Socio C', pct: 33.34 },
      ]);

      assert.equal(dbState.upsertLog.length, 2);
      assert.deepEqual(dbState.upsertLog[1].options, { onConflict: 'org_id,sucursal_id' });
      assert.equal(dbState.sucursalRepartoConfig.length, 1);

      const getRes = await requestJson(server, 'GET', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
      });
      assert.equal(getRes.status, 200);
      assert.deepEqual(getRes.body, secondPut.body);
    });

    it('acepta el limite exacto de 20 socios con nombre de hasta 60 caracteres', async () => {
      const nombre60 = 'A'.repeat(60);
      const socios20 = Array.from({ length: 20 }, (_, i) => ({
        id: `soc-${i + 1}`,
        nombre: i === 0 ? nombre60 : `Socio ${i + 1}`,
        pct: 5,
      }));

      const res = await requestJson(server, 'PUT', `/sucursales/${SUC_A2}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
        body: { capital_pct: 0, socios: socios20 },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.configurado, true);
      assert.equal(res.body.socios.length, 20);
      assert.equal(res.body.socios[0].nombre, nombre60);
    });
  });

  describe('Caso 3: PUT /sucursales/:id/reparto con capital_pct 100 y socios vacio', () => {
    it('guarda 100% de capital sin socios y GET subsecuente retorna configurado true', async () => {
      const putRes = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
        body: { capital_pct: 100, socios: [] },
      });

      assert.equal(putRes.status, 200);
      assert.equal(putRes.body.sucursal_id, SUC_A1);
      assert.equal(putRes.body.capital_pct, 100);
      assert.deepEqual(putRes.body.socios, []);
      assert.equal(putRes.body.configurado, true);
      assert.equal(typeof putRes.body.updated_at, 'string');

      assert.equal(dbState.upsertLog.length, 1);
      assert.deepEqual(dbState.upsertLog[0].options, { onConflict: 'org_id,sucursal_id' });
      assert.deepEqual(dbState.upsertLog[0].payload.socios, []);

      const getRes = await requestJson(server, 'GET', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
      });
      assert.equal(getRes.status, 200);
      assert.deepEqual(getRes.body, putRes.body);
    });
  });

  describe('Caso 4: Validaciones 400 sin ejecutar upsert', () => {
    it('rechaza sumas distintas de 100% (99, 101 y fuera de tolerancia 0.01)', async () => {
      const invalidSums = [
        {
          label: 'suma 99',
          body: { capital_pct: 19, socios: [{ nombre: 'Socio A', pct: 40 }, { nombre: 'Socio B', pct: 40 }] },
        },
        {
          label: 'suma 101',
          body: { capital_pct: 21, socios: [{ nombre: 'Socio A', pct: 40 }, { nombre: 'Socio B', pct: 40 }] },
        },
        {
          label: 'suma 99.98 fuera de tolerancia',
          body: {
            capital_pct: 0,
            socios: [
              { nombre: 'Socio A', pct: 33.32 },
              { nombre: 'Socio B', pct: 33.33 },
              { nombre: 'Socio C', pct: 33.33 },
            ],
          },
        },
        {
          label: 'suma 100.02 fuera de tolerancia',
          body: {
            capital_pct: 0.02,
            socios: [
              { nombre: 'Socio A', pct: 50 },
              { nombre: 'Socio B', pct: 50 },
            ],
          },
        },
        {
          label: 'suma 0 sin socios',
          body: { capital_pct: 0, socios: [] },
        },
      ];

      for (const scenario of invalidSums) {
        dbState.upsertLog = [];
        const res = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
          headers: { authorization: 'Bearer valid-token-a' },
          body: scenario.body,
        });

        assert.equal(res.status, 400, `Expected 400 for ${scenario.label}`);
        assert.deepEqual(res.body, {
          error: 'La suma del capital del negocio y los socios debe ser exactamente 100%',
        });
        assert.equal(dbState.upsertLog.length, 0);
      }
    });

    it('rechaza capital_pct fuera de rango o no numerico y payload/socios con tipos invalidos', async () => {
      const invalidPayloads = [
        { label: 'capital negativo', body: { capital_pct: -1, socios: [{ nombre: 'Socio A', pct: 100 }] } },
        { label: 'capital > 100', body: { capital_pct: 101, socios: [] } },
        { label: 'capital string', body: { capital_pct: '20', socios: [{ nombre: 'Socio A', pct: 80 }] } },
        { label: 'capital null', body: { capital_pct: null, socios: [{ nombre: 'Socio A', pct: 100 }] } },
        { label: 'capital faltante', body: { socios: [{ nombre: 'Socio A', pct: 100 }] } },
        { label: 'socios no array (null)', body: { capital_pct: 100, socios: null } },
        { label: 'socios no array (objeto)', body: { capital_pct: 100, socios: {} } },
        { label: 'body arreglo', body: [] },
      ];

      for (const scenario of invalidPayloads) {
        dbState.upsertLog = [];
        const res = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
          headers: { authorization: 'Bearer valid-token-a' },
          body: scenario.body,
        });

        assert.equal(res.status, 400, `Expected 400 for ${scenario.label}`);
        assert.equal(typeof res.body.error, 'string');
        assert.ok(res.body.error.length > 0);
        assert.equal(dbState.upsertLog.length, 0);
      }
    });

    it('rechaza socio con nombre vacio, solo espacios, > 60 caracteres, pct invalido o mas de 20 socios', async () => {
      const socios21 = Array.from({ length: 21 }, (_, i) => ({
        nombre: `Socio ${i + 1}`,
        pct: i < 20 ? 5 : 0,
      }));

      const invalidCases = [
        {
          label: 'nombre vacio',
          body: { capital_pct: 50, socios: [{ nombre: '', pct: 50 }] },
        },
        {
          label: 'nombre solo espacios',
          body: { capital_pct: 50, socios: [{ nombre: '    ', pct: 50 }] },
        },
        {
          label: 'nombre no string',
          body: { capital_pct: 50, socios: [{ nombre: 123, pct: 50 }] },
        },
        {
          label: 'nombre > 60 caracteres',
          body: { capital_pct: 50, socios: [{ nombre: 'X'.repeat(61), pct: 50 }] },
        },
        {
          label: 'pct negativo',
          body: {
            capital_pct: 50,
            socios: [
              { nombre: 'Socio Negativo', pct: -5 },
              { nombre: 'Socio Positivo', pct: 55 },
            ],
          },
        },
        {
          label: 'pct > 100',
          body: { capital_pct: 0, socios: [{ nombre: 'Socio Excedido', pct: 101 }] },
        },
        {
          label: 'pct no numerico',
          body: { capital_pct: 50, socios: [{ nombre: 'Socio Texto', pct: '50' }] },
        },
        {
          label: 'item socio null',
          body: { capital_pct: 100, socios: [null] },
        },
        {
          label: '21 socios (> 20)',
          body: { capital_pct: 0, socios: socios21 },
          expectedError: 'No se permiten más de 20 socios por sucursal',
        },
      ];

      for (const scenario of invalidCases) {
        dbState.upsertLog = [];
        const res = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
          headers: { authorization: 'Bearer valid-token-a' },
          body: scenario.body,
        });

        assert.equal(res.status, 400, `Expected 400 for ${scenario.label}`);
        if (scenario.expectedError) {
          assert.deepEqual(res.body, { error: scenario.expectedError });
        } else {
          assert.equal(typeof res.body.error, 'string');
          assert.ok(res.body.error.length > 0);
        }
        assert.equal(dbState.upsertLog.length, 0);
      }
    });

    it('rechaza UUID invalido en :id tanto en GET como en PUT sin consultar sucursales ni reparto', async () => {
      const invalidIds = [
        'no-es-uuid',
        '123',
        '11111111-1111-4111-8111-11111111111z',
        '11111111-1111-4111-8111-11111111111',
      ];

      for (const badId of invalidIds) {
        dbState.queryLog = [];
        const getRes = await requestJson(
          server,
          'GET',
          `/sucursales/${encodeURIComponent(badId)}/reparto`,
          { headers: { authorization: 'Bearer valid-token-a' } }
        );
        assert.equal(getRes.status, 400, `Expected 400 on GET for id=${badId}`);
        assert.deepEqual(getRes.body, {
          error: 'El identificador de sucursal debe ser un UUID válido',
        });
        assert.equal(
          dbState.queryLog.filter((q) => q.table !== 'organizacion_miembros').length,
          0
        );

        dbState.queryLog = [];
        dbState.upsertLog = [];
        const putRes = await requestJson(
          server,
          'PUT',
          `/sucursales/${encodeURIComponent(badId)}/reparto`,
          {
            headers: { authorization: 'Bearer valid-token-a' },
            body: { capital_pct: 100, socios: [] },
          }
        );
        assert.equal(putRes.status, 400, `Expected 400 on PUT for id=${badId}`);
        assert.deepEqual(putRes.body, {
          error: 'El identificador de sucursal debe ser un UUID válido',
        });
        assert.equal(
          dbState.queryLog.filter((q) => q.table !== 'organizacion_miembros').length,
          0
        );
        assert.equal(dbState.upsertLog.length, 0);
      }
    });
  });

  describe('Caso 5: Aislamiento multi-tenant y guards de autenticacion y membresia', () => {
    it('retorna 404 en GET y PUT cuando la sucursal pertenece a otra org_id o no existe sin tocar reparto', async () => {
      dbState.sucursalRepartoConfig.push({
        org_id: ORG_B,
        sucursal_id: SUC_B1,
        capital_pct: 70,
        socios: [{ id: 'soc-b', nombre: 'Socio Confidencial B', pct: 30 }],
        updated_at: '2026-05-10T10:00:00.000Z',
      });

      for (const targetSucId of [SUC_B1, SUC_MISSING]) {
        dbState.queryLog = [];
        const getRes = await requestJson(server, 'GET', `/sucursales/${targetSucId}/reparto`, {
          headers: { authorization: 'Bearer valid-token-a' },
        });
        assert.equal(getRes.status, 404);
        assert.deepEqual(getRes.body, { error: 'Sucursal no encontrada' });
        assert.equal(
          dbState.queryLog.filter((q) => q.table === 'sucursal_reparto_config').length,
          0
        );

        dbState.queryLog = [];
        dbState.upsertLog = [];
        const putRes = await requestJson(server, 'PUT', `/sucursales/${targetSucId}/reparto`, {
          headers: { authorization: 'Bearer valid-token-a' },
          body: { capital_pct: 100, socios: [] },
        });
        assert.equal(putRes.status, 404);
        assert.deepEqual(putRes.body, { error: 'Sucursal no encontrada' });
        assert.equal(
          dbState.queryLog.filter((q) => q.table === 'sucursal_reparto_config').length,
          0
        );
        assert.equal(dbState.upsertLog.length, 0);
      }

      // La configuracion de ORG_B debe permanecer intacta.
      assert.equal(dbState.sucursalRepartoConfig.length, 1);
      assert.equal(dbState.sucursalRepartoConfig[0].org_id, ORG_B);
      assert.equal(dbState.sucursalRepartoConfig[0].capital_pct, 70);

      await assert.rejects(
        () => RepartoService.obtenerRepartoPorSucursal(ORG_A, SUC_B1),
        (err) =>
          err instanceof RepartoValidationError &&
          err.status === 404 &&
          err.message === 'Sucursal no encontrada'
      );
      await assert.rejects(
        () => RepartoService.guardarRepartoPorSucursal(ORG_A, SUC_B1, { capital_pct: 100, socios: [] }),
        (err) =>
          err instanceof RepartoValidationError &&
          err.status === 404 &&
          err.message === 'Sucursal no encontrada'
      );
    });

    it('retorna 401 sin header Authorization o con token invalido en GET y PUT', async () => {
      const authErrorHeaders = [
        {},
        { authorization: 'Token formato-invalido' },
        { authorization: 'Bearer token-invalido' },
      ];

      for (const headers of authErrorHeaders) {
        dbState.queryLog = [];
        const getRes = await requestJson(server, 'GET', `/sucursales/${SUC_A1}/reparto`, { headers });
        assert.equal(getRes.status, 401);
        assert.equal(dbState.queryLog.length, 0);

        const putRes = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
          headers,
          body: { capital_pct: 100, socios: [] },
        });
        assert.equal(putRes.status, 401);
        assert.equal(dbState.queryLog.length, 0);
      }
    });

    it('retorna 403 cuando el usuario autenticado no tiene membresia en la org_id solicitada o no tiene orgs', async () => {
      const getForbiddenOrg = await requestJson(
        server,
        'GET',
        `/sucursales/${SUC_B1}/reparto`,
        { headers: { authorization: 'Bearer valid-token-a', 'x-org-id': ORG_B } }
      );
      assert.equal(getForbiddenOrg.status, 403);
      assert.deepEqual(getForbiddenOrg.body, { error: 'Sin membresía en la organización' });

      const putForbiddenOrg = await requestJson(
        server,
        'PUT',
        `/sucursales/${SUC_B1}/reparto?org_id=${ORG_B}`,
        {
          headers: { authorization: 'Bearer valid-token-a' },
          body: { capital_pct: 100, socios: [] },
        }
      );
      assert.equal(putForbiddenOrg.status, 403);
      assert.deepEqual(putForbiddenOrg.body, { error: 'Sin membresía en la organización' });

      const getNoOrg = await requestJson(server, 'GET', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-no-org' },
      });
      assert.equal(getNoOrg.status, 403);
      assert.deepEqual(getNoOrg.body, { error: 'Usuario sin organización asignada' });

      const putNoOrg = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-no-org' },
        body: { capital_pct: 100, socios: [] },
      });
      assert.equal(putNoOrg.status, 403);
      assert.deepEqual(putNoOrg.body, { error: 'Usuario sin organización asignada' });

      assert.equal(dbState.upsertLog.length, 0);
    });

    it('aisla operaciones concurrentes entre distintas organizaciones sin cruzar configuraciones', async () => {
      const [putA, putB] = await Promise.all([
        requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
          headers: { authorization: 'Bearer valid-token-multi', 'x-org-id': ORG_A },
          body: { capital_pct: 30, socios: [{ id: 'sa', nombre: 'Socio Org A', pct: 70 }] },
        }),
        requestJson(server, 'PUT', `/sucursales/${SUC_B1}/reparto`, {
          headers: { authorization: 'Bearer valid-token-multi', 'x-org-id': ORG_B },
          body: { capital_pct: 60, socios: [{ id: 'sb', nombre: 'Socio Org B', pct: 40 }] },
        }),
      ]);

      assert.equal(putA.status, 200);
      assert.equal(putB.status, 200);

      const [getA, getB] = await Promise.all([
        requestJson(server, 'GET', `/sucursales/${SUC_A1}/reparto`, {
          headers: { authorization: 'Bearer valid-token-multi', 'x-org-id': ORG_A },
        }),
        requestJson(server, 'GET', `/sucursales/${SUC_B1}/reparto`, {
          headers: { authorization: 'Bearer valid-token-multi', 'x-org-id': ORG_B },
        }),
      ]);

      assert.equal(getA.status, 200);
      assert.equal(getA.body.capital_pct, 30);
      assert.equal(getA.body.socios[0].nombre, 'Socio Org A');
      assert.equal(JSON.stringify(getA.body).includes('Org B'), false);

      assert.equal(getB.status, 200);
      assert.equal(getB.body.capital_pct, 60);
      assert.equal(getB.body.socios[0].nombre, 'Socio Org B');
      assert.equal(JSON.stringify(getB.body).includes('Org A'), false);
    });
  });

  describe('Caso 6: Propagacion limpia de errores inesperados de Supabase (HTTP 500)', () => {
    it('responde 500 Error interno del servidor en GET cuando falla sucursales o sucursal_reparto_config', async () => {
      dbState.injectedError = (q) =>
        q.table === 'sucursales' ? new Error('DB timeout en sucursales') : null;
      const resSucErr = await requestJson(server, 'GET', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
      });
      assert.equal(resSucErr.status, 500);
      assert.deepEqual(resSucErr.body, { error: 'Error interno del servidor' });
      assert.equal(
        dbState.queryLog.filter((q) => q.table === 'sucursal_reparto_config').length,
        0
      );

      dbState.queryLog = [];
      dbState.injectedError = (q) =>
        q.table === 'sucursal_reparto_config' ? new Error('DB error en reparto GET') : null;
      const resRepErr = await requestJson(server, 'GET', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
      });
      assert.equal(resRepErr.status, 500);
      assert.deepEqual(resRepErr.body, { error: 'Error interno del servidor' });

      await assert.rejects(
        () => RepartoService.obtenerRepartoPorSucursal(ORG_A, SUC_A1),
        { message: 'DB error en reparto GET' }
      );
    });

    it('responde 500 Error interno del servidor en PUT cuando falla sucursales o upsert sin corromper estado', async () => {
      dbState.injectedError = (q) =>
        q.table === 'sucursales' ? new Error('DB error validando sucursal') : null;
      const resSucErr = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
        body: { capital_pct: 100, socios: [] },
      });
      assert.equal(resSucErr.status, 500);
      assert.deepEqual(resSucErr.body, { error: 'Error interno del servidor' });
      assert.equal(dbState.upsertLog.length, 0);

      dbState.injectedError = (q) =>
        q.table === 'sucursal_reparto_config' && q.operation === 'upsert'
          ? new Error('DB error en upsert reparto')
          : null;
      const resUpsertErr = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
        body: { capital_pct: 100, socios: [] },
      });
      assert.equal(resUpsertErr.status, 500);
      assert.deepEqual(resUpsertErr.body, { error: 'Error interno del servidor' });
      assert.equal(dbState.sucursalRepartoConfig.length, 0);

      await assert.rejects(
        () => RepartoService.guardarRepartoPorSucursal(ORG_A, SUC_A1, { capital_pct: 100, socios: [] }),
        { message: 'DB error en upsert reparto' }
      );
    });

    it('responde 500 Error interno del servidor cuando falla la verificacion de membresia', async () => {
      dbState.injectedError = (q) =>
        q.table === 'organizacion_miembros' ? new Error('DB error en membresias') : null;

      const getRes = await requestJson(server, 'GET', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
      });
      assert.equal(getRes.status, 500);
      assert.deepEqual(getRes.body, { error: 'Error interno del servidor' });

      const putRes = await requestJson(server, 'PUT', `/sucursales/${SUC_A1}/reparto`, {
        headers: { authorization: 'Bearer valid-token-a' },
        body: { capital_pct: 100, socios: [] },
      });
      assert.equal(putRes.status, 500);
      assert.deepEqual(putRes.body, { error: 'Error interno del servidor' });
    });
  });
});
