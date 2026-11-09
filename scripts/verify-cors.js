'use strict';
// Verificación de CORS contra el server REAL compilado (dist/server.js).
// No lee .env (dotenv/config queda stubeado antes de cargar el server).
// No toca Supabase (env dummy) ni la red externa (solo localhost).
// Uso: node scripts/verify-cors.js false   -> prueba ALLOW_NO_ORIGIN=false
//      node scripts/verify-cors.js true    -> prueba ALLOW_NO_ORIGIN=true

const path = require('path');
const http = require('http');
const Module = require('module');

const ALLOW_NO_ORIGIN = process.argv[2];
const PORT = 39876 + (ALLOW_NO_ORIGIN === 'true' ? 1 : 0);

// ─── Env dummy (impide uso de credenciales reales) ───
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.ALLOW_NO_ORIGIN = ALLOW_NO_ORIGIN;
process.env.PORT = String(PORT);

const DIST = path.join(__dirname, '..', 'dist');

// ─── Stub de dotenv/config -> .env NO se lee jamás ───
function stubModule(id, exports) {
  const m = new Module(id, null);
  m.filename = id;
  m.loaded = true;
  m.exports = exports;
  require.cache[id] = m;
  return m;
}
const dotenvId = require.resolve('dotenv/config', { paths: [__dirname] });
stubModule(dotenvId, {});
console.log('   dotenv/config stubeado -> .env NO se lee');

// ─── Stub de initWhatsAppJobs -> no se agenda ningún cron ───
const jobId = require.resolve(path.join(DIST, 'jobs', 'whatsapp.job.js'));
stubModule(jobId, { initWhatsAppJobs: () => console.log('   initWhatsAppJobs stubeado -> sin cron') });

require(path.join(DIST, 'server.js'));

function probe(method, urlPath, origin, useOriginHeader) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (useOriginHeader) headers['Origin'] = origin;
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            acao: res.headers['access-control-allow-origin'] || '(sin header ACAO)',
            body: raw.slice(0, 120),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  // Pequeña espera a que app.listen esté listo
  await new Promise((r) => setTimeout(r, 400));

  console.log(`\n== ALLOW_NO_ORIGIN=${ALLOW_NO_ORIGIN} (puerto ${PORT}) ==\n`);

  const casos = [
    { n: 'GET /health SIN header Origin', method: 'GET', p: '/health', o: null, u: false },
    { n: 'GET /health Origin=http://localhost:4200 (permitido)', method: 'GET', p: '/health', o: 'http://localhost:4200', u: true },
    { n: 'GET /health Origin=https://evil.example (no permitido)', method: 'GET', p: '/health', o: 'https://evil.example', u: true },
    { n: 'OPTIONS * SIN header Origin', method: 'OPTIONS', p: '/health', o: null, u: false },
  ];

  let fallos = 0;
  for (const c of casos) {
    let r;
    try {
      r = await probe(c.method, c.p, c.o, c.u);
    } catch (e) {
      console.log(`ERROR [${c.n}] ${e.message}`);
      fallos++;
      continue;
    }
    const sinOrigin = !c.u;
    const evil = c.u && c.o === 'https://evil.example';
    const preflight = c.method === 'OPTIONS';
    let esperado;
    if (sinOrigin) {
      // Estricto: el origin callback lanza -> 500. Permisivo: el preflight
      // lo responde el propio middleware cors con 204 (exito, no 500).
      esperado = ALLOW_NO_ORIGIN === 'true' ? (preflight ? 204 : 200) : 500;
    } else if (evil) esperado = 500;
    else esperado = 200;

    const ok = r.status === esperado;
    if (!ok) fallos++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.n}`);
    console.log(`      esperado=${esperado} obtenido=${r.status}  ACAO=${r.acao}`);
    console.log(`      body=${r.body}`);
  }

  console.log(`\n   Fallos: ${fallos}`);
  process.exit(fallos ? 1 : 0);
}

main().catch((e) => { console.error('Error inesperado:', e); process.exit(1); });