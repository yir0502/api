'use strict';
// Verificación de la lógica de requireMembership v2 (Sprint 1 hardening).
// No toca src/, no hace red: monkey-pcha supabaseAdmin.from con un stub encadenable.
// Uso: node scripts/verify-org-guard.js   (tras `npm run build`)

// ─── Env dummy ANTES de requerir nada (si no, dist/lib/supabase.js lanza) ───
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';

const assert = require('assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'dist', 'lib');

// ─── Estado global que cada caso setea ───
let MEMBERSHIPS = [];   // array de { org_id }
let SB_ERROR = null;    // si no es null, el stub resuelve { data: null, error }

const { supabaseAdmin } = require(path.join(LIB, 'supabase.js'));

// ─── Monkey-patch: stub encadenable .from().select().eq() ───
let queryLog = [];
supabaseAdmin.from = function from(tabla) {
  let cols = null;
  const stub = {
    select(c) { cols = c; return stub; },
    eq(col, val) {
      queryLog.push({ tabla, cols, eq: [col, val] });
      if (SB_ERROR) return Promise.resolve({ data: null, error: SB_ERROR });
      return Promise.resolve({ data: MEMBERSHIPS.map((m) => Object.assign({}, m)), error: null });
    },
  };
  return stub;
};

const { requireMembership } = require(path.join(LIB, 'guard.js'));

// ─── Mocks ───
function makeReq(opts) {
  opts = opts || {};
  return {
    user: 'user' in opts ? opts.user : { id: 'u1' },
    query: opts.query || {},
    body: opts.body || {},
    headers: opts.headers || {},
  };
}
function makeRes() {
  const r = {
    statusCode: null,
    body: null,
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; return r; },
  };
  return r;
}
function makeNext() {
  const n = { called: false, fn() { n.called = true; } };
  return n;
}

// ─── Helpers de aserción ───
function assertBlocked(name, res, next, code, errorMsg) {
  assert.strictEqual(res.statusCode, code, `${name}: esperaba HTTP ${code}, obtuvo ${res.statusCode}`);
  if (errorMsg !== undefined) {
    assert.strictEqual(res.body && res.body.error, errorMsg,
      `${name}: esperaba error "${errorMsg}", obtuvo "${res.body && res.body.error}"`);
  }
  assert.strictEqual(next.called, false, `${name}: next() NO debe llamarse en un bloqueo`);
}
function assertAllowed(name, req, res, next, expectedOrg) {
  assert.strictEqual(next.called, true, `${name}: next() debe llamarse`);
  assert.strictEqual(req.org_id, expectedOrg, `${name}: req.org_id esperado "${expectedOrg}", obtuvo "${req.org_id}"`);
  assert.strictEqual(res.statusCode, null, `${name}: no debe escribirse statusCode en ruta permitida`);
}

// ─── Casos ───
const CASOS = [
  {
    id: 'a',
    desc: 'sin user -> 401',
    run: async () => {
      MEMBERSHIPS = [{ org_id: 'A' }];
      const req = makeReq({ user: undefined, query: { org_id: 'A' } });
      const res = makeRes(); const next = makeNext();
      await requireMembership(req, res, next.fn);
      assertBlocked('a', res, next, 401, 'No user');
    },
  },
  {
    id: 'b',
    desc: '0 membresías + org solicitado -> 403 "Usuario sin organización asignada"',
    run: async () => {
      MEMBERSHIPS = [];
      const req = makeReq({ query: { org_id: 'A' } });
      const res = makeRes(); const next = makeNext();
      await requireMembership(req, res, next.fn);
      assertBlocked('b', res, next, 403, 'Usuario sin organización asignada');
    },
  },
  {
    id: 'c',
    desc: '1 membresía A, solicita A -> next, req.org_id = A',
    run: async () => {
      MEMBERSHIPS = [{ org_id: 'A' }];
      const req = makeReq({ query: { org_id: 'A' } });
      const res = makeRes(); const next = makeNext();
      await requireMembership(req, res, next.fn);
      assertAllowed('c', req, res, next, 'A');
    },
  },
  {
    id: 'd',
    desc: '1 membresía A, solicita B -> 403 "Sin membresía en la organización"',
    run: async () => {
      MEMBERSHIPS = [{ org_id: 'A' }];
      const req = makeReq({ query: { org_id: 'B' } });
      const res = makeRes(); const next = makeNext();
      await requireMembership(req, res, next.fn);
      assertBlocked('d', res, next, 403, 'Sin membresía en la organización');
      assert.strictEqual(req.org_id, undefined, 'd: req.org_id no debe asignarse');
    },
  },
  {
    id: 'e',
    desc: '1 membresía A, sin org solicitado -> next, req.org_id = A',
    run: async () => {
      MEMBERSHIPS = [{ org_id: 'A' }];
      const req = makeReq({});
      const res = makeRes(); const next = makeNext();
      await requireMembership(req, res, next.fn);
      assertAllowed('e', req, res, next, 'A');
    },
  },
  {
    id: 'f',
    desc: '2 membresías A,B, solicita A -> next, req.org_id = A',
    run: async () => {
      MEMBERSHIPS = [{ org_id: 'A' }, { org_id: 'B' }];
      const req = makeReq({ query: { org_id: 'A' } });
      const res = makeRes(); const next = makeNext();
      await requireMembership(req, res, next.fn);
      assertAllowed('f', req, res, next, 'A');
    },
  },
  {
    id: 'g',
    desc: '2 membresías A,B, solicita C -> 403',
    run: async () => {
      MEMBERSHIPS = [{ org_id: 'A' }, { org_id: 'B' }];
      const req = makeReq({ query: { org_id: 'C' } });
      const res = makeRes(); const next = makeNext();
      await requireMembership(req, res, next.fn);
      assertBlocked('g', res, next, 403, 'Sin membresía en la organización');
    },
  },
  {
    id: 'h',
    desc: '2 membresías A,B, sin org solicitado -> 400',
    run: async () => {
      MEMBERSHIPS = [{ org_id: 'A' }, { org_id: 'B' }];
      const req = makeReq({});
      const res = makeRes(); const next = makeNext();
      await requireMembership(req, res, next.fn);
      assertBlocked('h', res, next, 400);
    },
  },
  // ─── Extras (reglas del spec no cubiertas por a–h) ───
  {
    id: 'x1',
    desc: 'EXTRA: error de Supabase -> 500 genérico (sin filtrar detalle)',
    run: async () => {
      MEMBERSHIPS = [{ org_id: 'A' }];
      SB_ERROR = { message: 'boom-db' };
      const req = makeReq({ query: { org_id: 'A' } });
      const res = makeRes(); const next = makeNext();
      try {
        await requireMembership(req, res, next.fn);
      } finally {
        SB_ERROR = null;
      }
      assertBlocked('x1', res, next, 500, 'Error interno del servidor');
    },
  },
  {
    id: 'x2',
    desc: 'EXTRA: una sola consulta a organizacion_miembros (org_id, eq user_id)',
    run: async () => {
      queryLog = [];
      MEMBERSHIPS = [{ org_id: 'A' }];
      const req = makeReq({ query: { org_id: 'A' } });
      const res = makeRes(); const next = makeNext();
      await requireMembership(req, res, next.fn);
      assert.strictEqual(queryLog.length, 1, `x2: esperaba 1 consulta, obtuvo ${queryLog.length}`);
      assert.strictEqual(queryLog[0].tabla, 'organizacion_miembros', 'x2: tabla incorrecta');
      assert.strictEqual(queryLog[0].cols, 'org_id', 'x2: columnas incorrectas');
      assert.deepStrictEqual(queryLog[0].eq, ['user_id', 'u1'], 'x2: filtro eq incorrecto');
      queryLog = [];
    },
  },
  {
    id: 'x3',
    desc: 'EXTRA: precedencia query.org_id > body.org_id > header x-org-id',
    run: async () => {
      MEMBERSHIPS = [{ org_id: 'A' }];
      const req = makeReq({ query: { org_id: 'A' }, body: { org_id: 'B' }, headers: { 'x-org-id': 'C' } });
      const res = makeRes(); const next = makeNext();
      await requireMembership(req, res, next.fn);
      assertAllowed('x3-query', req, res, next, 'A');

      MEMBERSHIPS = [{ org_id: 'A' }, { org_id: 'B' }];
      const req2 = makeReq({ query: {}, body: { org_id: 'B' }, headers: { 'x-org-id': 'C' } });
      const res2 = makeRes(); const next2 = makeNext();
      await requireMembership(req2, res2, next2.fn);
      assertAllowed('x3-body', req2, res2, next2, 'B');

      MEMBERSHIPS = [{ org_id: 'A' }, { org_id: 'B' }];
      const req3 = makeReq({ query: {}, body: {}, headers: { 'x-org-id': 'B' } });
      const res3 = makeRes(); const next3 = makeNext();
      await requireMembership(req3, res3, next3.fn);
      assertAllowed('x3-header', req3, res3, next3, 'B');
    },
  },
];

async function main() {
  console.log('== Verificación requireMembership v2 ==');
  console.log('   guard:   ' + path.join(LIB, 'guard.js'));
  console.log('');

  let pass = 0; const fallos = [];
  for (const c of CASOS) {
    queryLog = [];
    try {
      await c.run();
      pass++;
      console.log(`PASS  [${c.id}] ${c.desc}`);
    } catch (e) {
      fallos.push({ id: c.id, desc: c.desc, err: e });
      console.log(`FAIL  [${c.id}] ${c.desc}`);
      console.log(`      ${e && e.message ? e.message : e}`);
    }
  }

  console.log('');
  console.log('== Resumen ==');
  console.log(`   Total:  ${CASOS.length}`);
  console.log(`   PASS:   ${pass}`);
  console.log(`   FAIL:   ${fallos.length}`);
  if (fallos.length) {
    console.log('   Casos fallidos: ' + fallos.map((f) => f.id).join(', '));
    process.exitCode = 1;
  } else {
    console.log('   RESULTADO: OK');
  }
}

main().catch((e) => {
  console.error('Error inesperado al ejecutar la verificación:', e);
  process.exitCode = 1;
});