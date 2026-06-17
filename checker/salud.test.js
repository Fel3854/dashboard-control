// checker/salud.test.js — tests de la extraccion de internos de /health (Parte A), sin red.
// Correr con: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extraerSalud } from './salud.js';

test('extraerSalud: conserva solo el whitelist', () => {
  const r = extraerSalud({ status: 'ok', version: '1.4.2', db: 'ok', uptime_s: 120, secreto: 'x' });
  assert.deepEqual(r, { status: 'ok', version: '1.4.2', db: 'ok', uptime_s: 120 });
});

test('extraerSalud: ignora connection strings / campos sensibles fuera del whitelist', () => {
  const r = extraerSalud({ status: 'ok', DATABASE_URL: 'postgres://user:pass@host/db', token: 'abc' });
  assert.deepEqual(r, { status: 'ok' });
});

test('extraerSalud: descarta valores objeto/array, deja escalares', () => {
  const r = extraerSalud({ db: { connected: true, latency_ms: 5 }, version: '2.0.0' });
  assert.deepEqual(r, { version: '2.0.0' }); // db (objeto) se descarta
});

test('extraerSalud: normaliza database -> db', () => {
  const r = extraerSalud({ database: 'ok', version: '1.0.0' });
  assert.deepEqual(r, { version: '1.0.0', db: 'ok' });
});

test('extraerSalud: db tiene prioridad sobre database', () => {
  const r = extraerSalud({ db: 'ok', database: 'error' });
  assert.deepEqual(r, { db: 'ok' });
});

test('extraerSalud: recorta strings muy largos', () => {
  const largo = 'x'.repeat(200);
  const r = extraerSalud({ version: largo });
  assert.equal(r.version.length, 80);
});

test('extraerSalud: acepta booleanos y numeros', () => {
  const r = extraerSalud({ db: true, uptime_s: 0 });
  assert.deepEqual(r, { db: true, uptime_s: 0 });
});

test('extraerSalud: sin claves utiles -> null', () => {
  assert.equal(extraerSalud({ foo: 1, bar: 2 }), null);
});

test('extraerSalud: entradas no-objeto -> null', () => {
  assert.equal(extraerSalud(null), null);
  assert.equal(extraerSalud('ok'), null);
  assert.equal(extraerSalud(42), null);
  assert.equal(extraerSalud(['ok']), null);
});
