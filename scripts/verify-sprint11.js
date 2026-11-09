'use strict';
// Verificación ligera del Sprint 1.1 (cross-tenant hardening).
// No toca red ni DB. Uso: node scripts/verify-sprint11.js   (tras `npm run build`)

const assert = require('assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'dist', 'lib');
const { escapeLike, validateRequest } = require(path.join(LIB, 'validate.js'));

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

const CASOS = [
  {
    id: 'escapeLike-1',
    desc: "escapeLike('%foo_') escapa % y _",
    run: async () => {
      assert.strictEqual(escapeLike('%foo_'), '\\%foo\\_');
    },
  },
  {
    id: 'escapeLike-2',
    desc: 'escapeLike escapa backslash antes que % y _',
    run: async () => {
      assert.strictEqual(escapeLike('a\\b'), 'a\\\\b');
      assert.strictEqual(escapeLike('%_\\'), '\\%\\_\\\\');
    },
  },
  {
    id: 'escapeLike-3',
    desc: 'escapeLike no altera texto normal',
    run: async () => {
      assert.strictEqual(escapeLike('LAV-1234'), 'LAV-1234');
    },
  },
  {
    id: 'validate-body',
    desc: 'validateRequest asigna req.body parseado (strip de claves desconocidas)',
    run: async () => {
      const schema = {
        parseAsync: async (input) => ({ body: { a: input.body.a } }),
      };
      const mw = validateRequest(schema);
      const req = { body: { a: 1, evil: true }, query: {}, params: {} };
      const res = makeRes();
      const next = makeNext();
      await mw(req, res, next.fn);
      assert.deepStrictEqual(req.body, { a: 1 }, 'req.body debe quedar con solo las claves del schema');
      assert.strictEqual(next.called, true, 'next() debe llamarse');
      assert.strictEqual(res.statusCode, null, 'no debe responder error');
    },
  },
  {
    id: 'validate-zod-error',
    desc: 'validateRequest responde 400 ante ZodError',
    run: async () => {
      const schema = {
        parseAsync: async () => {
          const e = new Error('invalid');
          e.name = 'ZodError';
          e.issues = [{ path: ['body', 'a'], message: 'required' }];
          throw e;
        },
      };
      const mw = validateRequest(schema);
      const req = { body: {}, query: {}, params: {} };
      const res = makeRes();
      const next = makeNext();
      await mw(req, res, next.fn);
      assert.strictEqual(res.statusCode, 400, 'debe responder 400');
      assert.strictEqual(next.called, false, 'next() NO debe llamarse');
    },
  },
];

async function main() {
  console.log('== Verificación Sprint 1.1 (escapeLike + validateRequest) ==');
  console.log('   lib: ' + path.join(LIB, 'validate.js'));
  console.log('');

  let pass = 0; const fallos = [];
  for (const c of CASOS) {
    try {
      await c.run();
      pass++;
      console.log(`PASS  [${c.id}] ${c.desc}`);
    } catch (e) {
      fallos.push({ id: c.id, err: e });
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
