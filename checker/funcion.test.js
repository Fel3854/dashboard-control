// checker/funcion.test.js — tests del chequeo FUNCIONAL, SIN RED.
// `fetch` se mockea: ningun test toca la red. Correr con: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cumpleEspera, evaluarFuncion, ejecutarFuncion, interpolar, esTransitorio, extraerValor, mensajeError } from './funcion.js';

const noopSleep = async () => {}; // anula el backoff de reintentos en los tests

// Fabrica una respuesta tipo fetch a partir de { status, body, setCookie, location }.
function respuesta({ status = 200, body = '', setCookie = [], location = null } = {}) {
  const texto = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      getSetCookie: () => setCookie,
      get: (name) => (String(name).toLowerCase() === 'location' ? location : null),
    },
    text: async () => texto,
  };
}

// fetchImpl mockeado: una respuesta por llamada (en orden). { throw:true } simula red caida.
// Guarda cada request en `fn.requests` para inspeccionar headers/body enviados.
function fetchMock(secuencia) {
  let i = 0;
  const fn = async (url, opciones) => {
    fn.requests.push({ url, opciones });
    const paso = secuencia[Math.min(i, secuencia.length - 1)];
    i++;
    if (paso.throw) throw new Error('simulado: timeout/red caida');
    return respuesta(paso);
  };
  fn.requests = [];
  fn.llamadas = () => i;
  return fn;
}

// ── interpolar (puro) ─────────────────────────────────────────────────────────

test('interpolar: env:/var: se reemplazan; literal queda igual', () => {
  assert.equal(interpolar('env:USER', { env: { USER: 'tester' } }), 'tester');
  assert.equal(interpolar('var:csrf', { vars: { csrf: 'abc123' } }), 'abc123');
  assert.equal(interpolar('literal', { env: { USER: 'x' } }), 'literal');
  assert.equal(interpolar('env:FALTA', { env: {} }), '');
});

test('extraerValor: devuelve el grupo 1 del regex, o null si no matchea', () => {
  assert.equal(extraerValor('<input name="_token" value="abc">', 'name="_token" value="([^"]+)"'), 'abc');
  assert.equal(extraerValor('nada que ver', 'value="([^"]+)"'), null);
});

// ── cumpleEspera (puro) ───────────────────────────────────────────────────────

test('cumpleEspera: status en la lista + json con el campo -> ok', () => {
  const r = cumpleEspera({ status: [200, 302], json_tiene: ['sugerido'] }, { status: 200, json: { sugerido: '1001' } });
  assert.equal(r.ok, true);
});

test('cumpleEspera: status fuera de la lista -> falla con motivo', () => {
  const r = cumpleEspera({ status: 200 }, { status: 401, json: null });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /401/);
});

test('cumpleEspera: status inesperado con error_description en el body -> el motivo lo incluye', () => {
  const r = cumpleEspera({ status: 200 }, { status: 400, json: { error_description: 'Invalid login credentials' } });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /status 400 \(esperaba 200\): Invalid login credentials/);
});

test('cumpleEspera: status inesperado sin body JSON -> motivo queda como antes (compat)', () => {
  const r = cumpleEspera({ status: 200 }, { status: 400, json: null });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'status 400 (esperaba 200)');
});

test('mensajeError: toma el 1er campo de error legible; recorta a 120; null si no hay', () => {
  assert.equal(mensajeError({ error_description: 'Invalid login credentials' }), 'Invalid login credentials');
  assert.equal(mensajeError({ msg: 'Email not confirmed' }), 'Email not confirmed');
  assert.equal(mensajeError({ message: 'Unauthenticated.' }), 'Unauthenticated.');
  assert.equal(mensajeError({ error_description: 'X'.repeat(200) }).length, 120);
  assert.equal(mensajeError({ otro: 'campo' }), null);
  assert.equal(mensajeError(null), null);
});

test('cumpleEspera: falta el campo JSON esperado -> falla', () => {
  const r = cumpleEspera({ status: 200, json_tiene: ['sugerido'] }, { status: 200, json: { otra: 1 } });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /sugerido/);
});

test('cumpleEspera: respuesta HTML cuando se esperaba JSON -> falla', () => {
  const r = cumpleEspera({ json_tiene: ['x'] }, { status: 200, json: null, texto: '<html>' });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no es JSON/);
});

test('cumpleEspera: json_array_no_vacio con array de filas -> ok', () => {
  const r = cumpleEspera({ status: 200, json_array_no_vacio: true }, { status: 200, json: [{ id: 1, nombre: 'Base A' }] });
  assert.equal(r.ok, true);
});

test('cumpleEspera: json_array_no_vacio con array vacío -> falla', () => {
  const r = cumpleEspera({ json_array_no_vacio: true }, { status: 200, json: [] });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /vacío/);
});

test('cumpleEspera: json_array_no_vacio cuando no es array -> falla', () => {
  const r = cumpleEspera({ json_array_no_vacio: true }, { status: 200, json: { error: 'x' } });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no es un array/);
});

test('cumpleEspera: texto_incluye encuentra el substring -> ok', () => {
  const r = cumpleEspera({ texto_incluye: 'Bienvenido' }, { status: 200, texto: '<h1>Bienvenido</h1>' });
  assert.equal(r.ok, true);
});

test('cumpleEspera: error de red -> falla con motivo', () => {
  const r = cumpleEspera({ status: 200 }, { error: 'timeout' });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /red/);
});

test('cumpleEspera: texto_no_incluye detecta el form de login (no autenticado) -> falla', () => {
  const r = cumpleEspera({ texto_no_incluye: 'name="password"' }, { status: 200, texto: '<input name="password">' });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no debería/);
});

test('cumpleEspera: location_no_incluye cuando el login redirige a /login -> falla', () => {
  const r = cumpleEspera({ status: 302, location_no_incluye: '/login' }, { status: 302, location: 'https://erp/login' });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /login/);
});

test('cumpleEspera: location_no_incluye cuando redirige al home -> ok', () => {
  const r = cumpleEspera({ status: 302, location_no_incluye: '/login' }, { status: 302, location: 'https://erp/home' });
  assert.equal(r.ok, true);
});

// ── evaluarFuncion (puro) ─────────────────────────────────────────────────────

test('evaluarFuncion: todos los pasos ok -> FUNCION_OK', () => {
  const r = evaluarFuncion([{ nombre: 'login', ok: true }, { nombre: 'consulta', ok: true }]);
  assert.equal(r.estado, 'FUNCION_OK');
});

test('evaluarFuncion: primer paso roto -> FUNCION_FALLA con paso_fallo y motivo', () => {
  const r = evaluarFuncion([{ nombre: 'login', ok: false, motivo: 'status 401' }]);
  assert.equal(r.estado, 'FUNCION_FALLA');
  assert.equal(r.paso_fallo, 'login');
  assert.match(r.motivo, /401/);
});

// ── ejecutarFuncion (con fetch mockeado) ──────────────────────────────────────

const funcionCubiertas = {
  descripcion: 'Login + consulta de ultimo fuego',
  requiere_secrets: ['U', 'P'],
  pasos: [
    {
      nombre: 'login',
      url: 'https://x.test/login',
      metodo: 'POST',
      cuerpo_form: { usr: 'env:U', pass: 'env:P' },
      guardar_cookie: 'token',
      espera: { status: [200, 302] },
    },
    {
      nombre: 'consulta',
      url: 'https://x.test/ajax/ultimo_fuego',
      metodo: 'GET',
      usar_cookie: true,
      espera: { status: 200, json_tiene: ['sugerido'] },
    },
  ],
};

test('ejecutarFuncion: login 302 + consulta 200 con sugerido -> FUNCION_OK', async () => {
  const fetchImpl = fetchMock([
    { status: 302, setCookie: ['token=eyJabc; Path=/; HttpOnly'] },
    { status: 200, body: { sugerido: '1001' } },
  ]);
  const r = await ejecutarFuncion(funcionCubiertas, { fetchImpl, env: { U: 'tester', P: 'secret' } });
  assert.equal(r.estado, 'FUNCION_OK');
  assert.equal(fetchImpl.llamadas(), 2);
  assert.ok(typeof r.duracion_ms === 'number');
});

test('ejecutarFuncion: login 401 -> FUNCION_FALLA en paso login y NO consulta', async () => {
  const fetchImpl = fetchMock([{ status: 401 }, { status: 200, body: { sugerido: '1' } }]);
  const r = await ejecutarFuncion(funcionCubiertas, { fetchImpl, env: { U: 'x', P: 'mal' } });
  assert.equal(r.estado, 'FUNCION_FALLA');
  assert.equal(r.paso_fallo, 'login');
  assert.equal(fetchImpl.llamadas(), 1, 'corta tras el login fallido');
});

test('ejecutarFuncion: consulta sin campo sugerido -> FUNCION_FALLA en paso consulta', async () => {
  const fetchImpl = fetchMock([
    { status: 302, setCookie: ['token=abc'] },
    { status: 200, body: { otro: 1 } },
  ]);
  const r = await ejecutarFuncion(funcionCubiertas, { fetchImpl, env: { U: 'x', P: 'y' } });
  assert.equal(r.estado, 'FUNCION_FALLA');
  assert.equal(r.paso_fallo, 'consulta');
  assert.match(r.motivo, /sugerido/);
});

// ── Flujos con login: jar de cookies + extraccion de token CSRF (estilo Laravel) ──

test('cookie jar: captura varias cookies del login y las reenvía al paso siguiente', async () => {
  const fn = fetchMock([
    { status: 302, setCookie: ['laravel_session=sess123; HttpOnly; Path=/', 'XSRF-TOKEN=xsrf456; Path=/'] },
    { status: 200, body: { ok: 1 } },
  ]);
  const funcion = {
    pasos: [
      { nombre: 'login', url: 'https://x/login', metodo: 'POST', guardar_cookie: 'x', espera: { status: 302 } },
      { nombre: 'home', url: 'https://x/', metodo: 'GET', espera: { status: 200 } },
    ],
  };
  await ejecutarFuncion(funcion, { fetchImpl: fn, env: {}, sleep: noopSleep });
  const cookie = fn.requests[1].opciones.headers['cookie'];
  assert.match(cookie, /laravel_session=sess123/);
  assert.match(cookie, /XSRF-TOKEN=xsrf456/);
});

test('extraer CSRF: lo saca del HTML y lo manda en el POST -> FUNCION_OK', async () => {
  const fn = fetchMock([
    { status: 200, body: '<input type="hidden" name="_token" value="TOK-789">' },
    { status: 302, location: 'https://erp/home' }, // login OK redirige fuera de /login
  ]);
  const funcion = {
    descripcion: 'login Laravel',
    requiere_secrets: ['E', 'P'],
    pasos: [
      {
        nombre: 'abrir-login',
        url: 'https://erp/login',
        metodo: 'GET',
        extraer: { var: 'csrf', regex: 'name="_token" value="([^"]+)"' },
        espera: { status: 200 },
      },
      {
        nombre: 'login',
        url: 'https://erp/login',
        metodo: 'POST',
        cuerpo_form: { _token: 'var:csrf', email: 'env:E', password: 'env:P' },
        no_seguir_redirect: true,
        espera: { status: 302, location_no_incluye: '/login' },
      },
    ],
  };
  const r = await ejecutarFuncion(funcion, { fetchImpl: fn, env: { E: 'a', P: 'b' }, sleep: noopSleep });
  assert.equal(r.estado, 'FUNCION_OK');
  assert.match(fn.requests[1].opciones.body, /_token=TOK-789/);
  assert.match(fn.requests[1].opciones.body, /email=a/);
});

test('login con credenciales malas: redirige a /login -> FUNCION_FALLA', async () => {
  const fn = fetchMock([
    { status: 200, body: 'name="_token" value="T"' },
    { status: 302, location: 'https://erp/login?error=1' }, // creds malas: vuelve al login
  ]);
  const funcion = {
    requiere_secrets: ['E', 'P'],
    pasos: [
      { nombre: 'abrir-login', url: 'https://erp/login', metodo: 'GET', extraer: { var: 'csrf', regex: 'value="([^"]+)"' }, espera: { status: 200 } },
      { nombre: 'login', url: 'https://erp/login', metodo: 'POST', cuerpo_form: { _token: 'var:csrf' }, no_seguir_redirect: true, espera: { status: 302, location_no_incluye: '/login' } },
    ],
  };
  const r = await ejecutarFuncion(funcion, { fetchImpl: fn, env: { E: 'a', P: 'mal' }, sleep: noopSleep });
  assert.equal(r.estado, 'FUNCION_FALLA');
  assert.equal(r.paso_fallo, 'login');
});

test('header interpolado (ej. apikey de Supabase) se envía en el request', async () => {
  const fn = fetchMock([{ status: 200, body: { access_token: 'jwt' } }]);
  const funcion = {
    requiere_secrets: ['KEY'],
    pasos: [
      {
        nombre: 'token',
        url: 'https://proj.supabase.co/auth/v1/token?grant_type=password',
        metodo: 'POST',
        headers: { apikey: 'env:KEY' },
        cuerpo_json: { email: 'a', password: 'b' },
        espera: { status: 200, json_tiene: ['access_token'] },
      },
    ],
  };
  const r = await ejecutarFuncion(funcion, { fetchImpl: fn, env: { KEY: 'anon-key' }, sleep: noopSleep });
  assert.equal(r.estado, 'FUNCION_OK');
  assert.equal(fn.requests[0].opciones.headers['apikey'], 'anon-key');
});

test('ejecutarFuncion: secret faltante -> FUNCION_OMITIDA sin tocar la red', async () => {
  const fetchImpl = fetchMock([{ status: 200 }]);
  const r = await ejecutarFuncion(funcionCubiertas, { fetchImpl, env: { U: 'solo-uno' } });
  assert.equal(r.estado, 'FUNCION_OMITIDA');
  assert.match(r.motivo, /P/);
  assert.equal(fetchImpl.llamadas(), 0, 'no debe hacer ningun fetch');
});

test('ejecutarFuncion: red caida persistente -> FUNCION_FALLA tras 3 reintentos', async () => {
  const fetchImpl = fetchMock([{ throw: true }]);
  const r = await ejecutarFuncion(funcionCubiertas, { fetchImpl, env: { U: 'x', P: 'y' }, sleep: noopSleep });
  assert.equal(r.estado, 'FUNCION_FALLA');
  assert.equal(r.paso_fallo, 'login');
  assert.match(r.motivo, /red/);
  assert.equal(fetchImpl.llamadas(), 3, 'reintenta la falla transitoria hasta 3 veces');
});

// ── Reintentos ante fallas TRANSITORIAS (cold start / 5xx) ────────────────────

test('esTransitorio: red y 5xx son transitorios; 4xx y assert-fail no', () => {
  assert.equal(esTransitorio({ error: 'fetch failed' }), true);
  assert.equal(esTransitorio({ status: 503 }), true);
  assert.equal(esTransitorio({ status: 401 }), false);
  assert.equal(esTransitorio({ status: 200 }), false);
});

test('ejecutarFuncion: cold start (red falla y luego responde) -> reintenta y FUNCION_OK', async () => {
  const fetchImpl = fetchMock([
    { throw: true }, // 1er intento del login: blip de cold start
    { status: 302, setCookie: ['token=abc'] }, // 2do intento: ya despierto
    { status: 200, body: { sugerido: '1001' } }, // consulta
  ]);
  const r = await ejecutarFuncion(funcionCubiertas, { fetchImpl, env: { U: 'x', P: 'y' }, sleep: noopSleep });
  assert.equal(r.estado, 'FUNCION_OK');
  assert.equal(fetchImpl.llamadas(), 3);
});

test('ejecutarFuncion: 503 y luego 200 -> reintenta el paso y FUNCION_OK', async () => {
  const publica = {
    descripcion: 'consulta pública',
    pasos: [{ nombre: 'lista', url: 'https://x.test/api/cosas', metodo: 'GET', espera: { status: 200, json_array_no_vacio: true } }],
  };
  const fetchImpl = fetchMock([{ status: 503 }, { status: 200, body: [{ id: 1 }] }]);
  const r = await ejecutarFuncion(publica, { fetchImpl, env: {}, sleep: noopSleep });
  assert.equal(r.estado, 'FUNCION_OK');
  assert.equal(fetchImpl.llamadas(), 2);
});

test('ejecutarFuncion: 401 NO se reintenta (falla real, no transitoria)', async () => {
  const fetchImpl = fetchMock([{ status: 401 }, { status: 200, body: { sugerido: '1' } }]);
  const r = await ejecutarFuncion(funcionCubiertas, { fetchImpl, env: { U: 'x', P: 'mal' }, sleep: noopSleep });
  assert.equal(r.estado, 'FUNCION_FALLA');
  assert.equal(r.paso_fallo, 'login');
  assert.equal(fetchImpl.llamadas(), 1, 'una falla real no se reintenta');
});
