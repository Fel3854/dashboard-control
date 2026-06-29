// checker/funcion.test.js — tests del chequeo FUNCIONAL, SIN RED.
// `fetch` se mockea: ningun test toca la red. Correr con: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cumpleEspera, evaluarFuncion, ejecutarFuncion, interpolar } from './funcion.js';

// Fabrica una respuesta tipo fetch a partir de { status, body, setCookie }.
function respuesta({ status = 200, body = '', setCookie = [] } = {}) {
  const texto = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: { getSetCookie: () => setCookie },
    text: async () => texto,
  };
}

// fetchImpl mockeado: una respuesta por llamada (en orden). { throw:true } simula red caida.
function fetchMock(secuencia) {
  let i = 0;
  const fn = async () => {
    const paso = secuencia[Math.min(i, secuencia.length - 1)];
    i++;
    if (paso.throw) throw new Error('simulado: timeout/red caida');
    return respuesta(paso);
  };
  fn.llamadas = () => i;
  fn.ultimasOpciones = null;
  return fn;
}

// ── interpolar (puro) ─────────────────────────────────────────────────────────

test('interpolar: env:NOMBRE se reemplaza por el valor del entorno', () => {
  assert.equal(interpolar('env:USER', { USER: 'tester' }), 'tester');
  assert.equal(interpolar('literal', { USER: 'tester' }), 'literal');
  assert.equal(interpolar('env:FALTA', {}), '');
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

test('cumpleEspera: texto_incluye encuentra el substring -> ok', () => {
  const r = cumpleEspera({ texto_incluye: 'Bienvenido' }, { status: 200, texto: '<h1>Bienvenido</h1>' });
  assert.equal(r.ok, true);
});

test('cumpleEspera: error de red -> falla con motivo', () => {
  const r = cumpleEspera({ status: 200 }, { error: 'timeout' });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /red/);
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

test('ejecutarFuncion: secret faltante -> FUNCION_OMITIDA sin tocar la red', async () => {
  const fetchImpl = fetchMock([{ status: 200 }]);
  const r = await ejecutarFuncion(funcionCubiertas, { fetchImpl, env: { U: 'solo-uno' } });
  assert.equal(r.estado, 'FUNCION_OMITIDA');
  assert.match(r.motivo, /P/);
  assert.equal(fetchImpl.llamadas(), 0, 'no debe hacer ningun fetch');
});

test('ejecutarFuncion: red caida en el login -> FUNCION_FALLA con motivo de red', async () => {
  const fetchImpl = fetchMock([{ throw: true }]);
  const r = await ejecutarFuncion(funcionCubiertas, { fetchImpl, env: { U: 'x', P: 'y' } });
  assert.equal(r.estado, 'FUNCION_FALLA');
  assert.equal(r.paso_fallo, 'login');
  assert.match(r.motivo, /red/);
});
