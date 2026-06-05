// checker/check.test.js — tests de la logica de estado SIN RED.
// `fetch` y `sleep` se mockean: ningun test toca la red ni espera el backoff real.
// Correr con: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decidirEstado, chequearTarget, resolverDesde } from './check.js';

const noopSleep = async () => {}; // anula el backoff en los tests

// Fabrica un fetchImpl mockeado a partir de una secuencia de respuestas.
// Cada entrada es { status } (responde) o { throw: true } (simula red caida / timeout).
function fetchMock(secuencia) {
  let i = 0;
  const fn = async () => {
    const paso = secuencia[Math.min(i, secuencia.length - 1)];
    i++;
    if (paso.throw) throw new Error('simulado: timeout/red caida');
    return { status: paso.status };
  };
  fn.llamadas = () => i;
  return fn;
}

// ── decidirEstado: PURA, sin fetch ────────────────────────────────────────────

test('decidirEstado: OK cuando responde rapido', () => {
  const estado = decidirEstado([{ ok: true, latencia_ms: 120 }]);
  assert.equal(estado, 'OK');
});

test('decidirEstado: LENTO cuando supera el umbral de latencia', () => {
  const estado = decidirEstado([{ ok: true, latencia_ms: 3500 }]);
  assert.equal(estado, 'LENTO');
});

test('decidirEstado: CAIDO cuando todos los intentos fallan', () => {
  const estado = decidirEstado([
    { ok: false, latencia_ms: 10000 },
    { ok: false, latencia_ms: 10000 },
    { ok: false, latencia_ms: 10000 },
  ]);
  assert.equal(estado, 'CAIDO');
});

test('decidirEstado: DESPERTANDO si falla el 1er intento y responde luego (tolera cold start)', () => {
  const estado = decidirEstado(
    [
      { ok: false, latencia_ms: 10000 },
      { ok: true, latencia_ms: 800 },
    ],
    { toleraColdStart: true },
  );
  assert.equal(estado, 'DESPERTANDO');
});

test('decidirEstado: sin tolerancia, fallar el 1er intento y recuperar no es DESPERTANDO (queda OK)', () => {
  const estado = decidirEstado(
    [
      { ok: false, latencia_ms: 10000 },
      { ok: true, latencia_ms: 800 },
    ],
    { toleraColdStart: false },
  );
  assert.equal(estado, 'OK');
});

// ── chequearTarget: con fetch + sleep MOCKEADOS ───────────────────────────────

test('chequearTarget: 200 inmediato -> OK y un solo fetch (corte temprano)', async () => {
  const fetchImpl = fetchMock([{ status: 200 }]);
  const r = await chequearTarget(
    { nombre: 'X', url: 'https://x.test', tipo: 'pull' },
    { fetchImpl, sleep: noopSleep },
  );
  assert.equal(r.estado, 'OK');
  assert.equal(r.http_code, 200);
  assert.equal(fetchImpl.llamadas(), 1);
});

test('chequearTarget: falla 1ra, 200 en 2da, tolera cold start -> DESPERTANDO (2 llamadas)', async () => {
  const fetchImpl = fetchMock([{ throw: true }, { status: 200 }]);
  const r = await chequearTarget(
    { nombre: 'Render', url: 'https://r.test/health', tipo: 'pull', tolera_cold_start: true },
    { fetchImpl, sleep: noopSleep },
  );
  assert.equal(r.estado, 'DESPERTANDO');
  assert.equal(fetchImpl.llamadas(), 2);
});

test('chequearTarget: siempre rechaza (timeout) -> CAIDO tras 3 intentos', async () => {
  const fetchImpl = fetchMock([{ throw: true }]);
  const r = await chequearTarget(
    { nombre: 'Down', url: 'https://down.test', tipo: 'pull' },
    { fetchImpl, sleep: noopSleep },
  );
  assert.equal(r.estado, 'CAIDO');
  assert.equal(r.http_code, null);
  assert.equal(fetchImpl.llamadas(), 3);
});

test('chequearTarget: siempre 500 -> CAIDO (no 2xx/3xx)', async () => {
  const fetchImpl = fetchMock([{ status: 500 }]);
  const r = await chequearTarget(
    { nombre: 'Err', url: 'https://err.test', tipo: 'pull' },
    { fetchImpl, sleep: noopSleep },
  );
  assert.equal(r.estado, 'CAIDO');
  assert.equal(r.http_code, 500);
  assert.equal(fetchImpl.llamadas(), 3);
});

test('chequearTarget: 301 cuenta como respuesta valida -> OK', async () => {
  const fetchImpl = fetchMock([{ status: 301 }]);
  const r = await chequearTarget(
    { nombre: 'Redir', url: 'https://redir.test', tipo: 'pull' },
    { fetchImpl, sleep: noopSleep },
  );
  assert.equal(r.estado, 'OK');
  assert.equal(r.http_code, 301);
});

// ── resolverDesde ─────────────────────────────────────────────────────────────

test('resolverDesde: mismo estado conserva el desde anterior', () => {
  const anterior = { proyectos: [{ nombre: 'A', estado: 'CAIDO', desde: '2026-06-01T00:00:00.000Z' }] };
  const desde = resolverDesde('A', 'CAIDO', anterior, '2026-06-04T12:00:00.000Z');
  assert.equal(desde, '2026-06-01T00:00:00.000Z');
});

test('resolverDesde: cambio de estado actualiza el desde a ahora', () => {
  const anterior = { proyectos: [{ nombre: 'A', estado: 'OK', desde: '2026-06-01T00:00:00.000Z' }] };
  const desde = resolverDesde('A', 'CAIDO', anterior, '2026-06-04T12:00:00.000Z');
  assert.equal(desde, '2026-06-04T12:00:00.000Z');
});

test('resolverDesde: proyecto nuevo (sin anterior) usa ahora', () => {
  const desde = resolverDesde('Nuevo', 'OK', null, '2026-06-04T12:00:00.000Z');
  assert.equal(desde, '2026-06-04T12:00:00.000Z');
});
