'use strict';

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');

const DIST = path.join(__dirname, '..', 'dist');
const supabaseMod = require(path.join(DIST, 'lib', 'supabase.js'));
const { supabaseAdmin } = supabaseMod;

let mockPedidos = [];
let mockEvidencias = [];
let mockMemberships = [];
let adminQueriedTables = [];

supabaseMod.createEphemeralAnonClient = function () {
  return {
    auth: {
      async signInWithPassword({ email, password }) {
        if (email === 'op@nanoclean.mx' && password === 'secret123') {
          return {
            data: {
              user: { id: 'user-1', email },
              session: { access_token: 'jwt-test-token' },
            },
            error: null,
          };
        }
        return { data: { user: null, session: null }, error: { message: 'Invalid login' } };
      },
    },
  };
};

supabaseAdmin.from = function (table) {
  adminQueriedTables.push(table);
  const filters = { eq: {}, ilike: {}, lim: null };

  const chain = {
    select() {
      return chain;
    },
    eq(col, val) {
      filters.eq[col] = val;
      return chain;
    },
    ilike(col, val) {
      filters.ilike[col] = String(val).toLowerCase();
      return chain;
    },
    limit(n) {
      filters.lim = n;
      return chain;
    },
    maybeSingle() {
      const rows = resolveRows();
      return Promise.resolve({ data: rows[0] || null, error: null });
    },
    single() {
      const rows = resolveRows();
      if (!rows[0]) return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
      return Promise.resolve({ data: rows[0], error: null });
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve({ data: resolveRows(), error: null }).then(onFulfilled, onRejected);
    },
  };

  function resolveRows() {
    if (table === 'organizacion_miembros') {
      return mockMemberships.filter((m) => !filters.eq.user_id || m.user_id === filters.eq.user_id);
    }
    if (table === 'pedido_evidencias') {
      return mockEvidencias.filter((e) => !filters.eq.pedido_id || e.pedido_id === filters.eq.pedido_id);
    }
    if (table === 'pedidos') {
      let rows = mockPedidos.slice();
      if (filters.eq.org_id) {
        rows = rows.filter((p) => p.org_id.toLowerCase() === String(filters.eq.org_id).toLowerCase());
      }
      if (filters.ilike.folio) {
        rows = rows.filter((p) => p.folio.toLowerCase() === filters.ilike.folio);
      }
      if (filters.lim) {
        rows = rows.slice(0, filters.lim);
      }
      return rows;
    }
    return [];
  }

  return chain;
};

const rastreoRouter = require(path.join(DIST, 'routes', 'rastreo.js')).default;
const authRouter = require(path.join(DIST, 'routes', 'auth.js')).default;

const app = express();
app.use(express.json());
app.use('/rastreo', rastreoRouter);
app.use('/auth', authRouter);

function requestJson(server, method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const rawBody = payload ? JSON.stringify(payload) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: rawBody
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
        });
      }
    );
    req.on('error', reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

async function main() {
  const ORG_A = '11111111-2222-3333-4444-555555555555';
  const ORG_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  mockPedidos = [
    {
      id: 'ped-1',
      org_id: ORG_A,
      folio: 'LAV-9001',
      estado: 'lavando',
      descripcion: '2 edredones',
      monto_total: 180,
      saldo_pendiente: 80,
      fecha_entrega_estimada: '2026-11-12',
      descuento_aplicado: 0,
      promo_canjeada: false,
      clientes: { id: 'cli-1', nombre: 'Maria Lopez', apto_promociones: true, monedero: 20, contador_servicios: 2 },
    },
    {
      id: 'ped-2',
      org_id: ORG_A,
      folio: 'LAV-DUP1',
      estado: 'recibido',
      descripcion: 'Ropa general',
      monto_total: 100,
      saldo_pendiente: 100,
      fecha_entrega_estimada: '2026-11-12',
      descuento_aplicado: 0,
      promo_canjeada: false,
      clientes: { id: 'cli-1', nombre: 'Maria Lopez', apto_promociones: false, monedero: 0, contador_servicios: 0 },
    },
    {
      id: 'ped-3',
      org_id: ORG_B,
      folio: 'LAV-DUP1',
      estado: 'listo',
      descripcion: 'Tintoreria',
      monto_total: 250,
      saldo_pendiente: 0,
      fecha_entrega_estimada: '2026-11-12',
      descuento_aplicado: 0,
      promo_canjeada: false,
      clientes: { id: 'cli-2', nombre: 'Pedro Perez', apto_promociones: false, monedero: 0, contador_servicios: 0 },
    },
  ];
  mockEvidencias = [{ pedido_id: 'ped-1', url: 'https://cdn.example/1.webp', tipo: 'ingreso', nota: 'OK' }];
  mockMemberships = [{ user_id: 'user-1', org_id: ORG_A }];

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const r1 = await requestJson(server, 'GET', `/rastreo/${ORG_A.toUpperCase()}/lav-9001`);
    assert.strictEqual(r1.status, 200, 'Debe aceptar UUID en mayusculas y folio en minusculas');
    assert.strictEqual(r1.body.folio, 'LAV-9001');
    assert.strictEqual(r1.body.org_id, ORG_A);
    assert.strictEqual(r1.body.cliente, 'Maria');

    const r2 = await requestJson(server, 'GET', '/rastreo/LAV-9001');
    assert.strictEqual(r2.status, 200, 'Debe resolver enlace legado de 1 segmento cuando el folio es unico');
    assert.strictEqual(r2.body.org_id, ORG_A);
    assert.strictEqual(r2.body.estado, 'lavando');

    const r3 = await requestJson(server, 'GET', '/rastreo/LAV-DUP1');
    assert.strictEqual(r3.status, 409, 'Debe bloquear enlace legado ambiguo entre multiples organizaciones');

    const r4 = await requestJson(server, 'GET', '/rastreo/LAV-NOEXISTE');
    assert.strictEqual(r4.status, 404, 'Debe responder 404 cuando el folio no existe');

    adminQueriedTables = [];
    const r5 = await requestJson(server, 'POST', '/auth/login', {
      email: 'op@nanoclean.mx',
      password: 'secret123',
    });
    assert.strictEqual(r5.status, 200, 'Login exitoso');
    assert.strictEqual(r5.body.org_id, ORG_A, 'Login debe devolver org_id usando supabaseAdmin');
    assert.ok(
      adminQueriedTables.includes('organizacion_miembros'),
      'Login debe consultar organizacion_miembros con supabaseAdmin'
    );

    console.log('== Verificacion rastreo + auth org_id: OK (5/5 casos) ==');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('Fallo en verify-rastreo:', err);
  process.exitCode = 1;
});
