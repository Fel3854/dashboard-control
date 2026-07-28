// checker/heartbeat.test.js — tests de la logica de heartbeat (Fase 3), sin I/O.
// Correr con: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluarHeartbeat, slug } from './heartbeat.js';

const HORA = 3600_000;
const T0 = Date.parse('2026-06-04T12:00:00.000Z');
const haceHoras = (h) => new Date(T0 - h * HORA).toISOString();

test('slug: normaliza acentos y espacios', () => {
  assert.equal(slug('Rotación'), 'rotacion');
  assert.equal(slug('Controles Stock Telegram'), 'controles-stock-telegram');
});

test('evaluarHeartbeat: reporte reciente -> OK', () => {
  const r = evaluarHeartbeat({ ultima_corrida: haceHoras(2) }, { ahora: T0, maxSilencioHoras: 26 });
  assert.equal(r.estado, 'OK');
});

test('evaluarHeartbeat: silencio mayor al permitido -> INACTIVO (no CAIDO)', () => {
  // Un batch de cadencia irregular que hace rato no corre NO es una caida: es INACTIVO.
  const r = evaluarHeartbeat({ ultima_corrida: haceHoras(30) }, { ahora: T0, maxSilencioHoras: 26 });
  assert.equal(r.estado, 'INACTIVO');
});

test('evaluarHeartbeat: silencio largo con ultima corrida OK -> INACTIVO', () => {
  const r = evaluarHeartbeat({ ultima_corrida: haceHoras(24 * 5), ok: true }, { ahora: T0, maxSilencioHoras: 26 });
  assert.equal(r.estado, 'INACTIVO');
});

test('evaluarHeartbeat: justo en el limite (<=) sigue OK', () => {
  const r = evaluarHeartbeat({ ultima_corrida: haceHoras(26) }, { ahora: T0, maxSilencioHoras: 26 });
  assert.equal(r.estado, 'OK');
});

test('evaluarHeartbeat: la ultima corrida reporto ok:false -> CAIDO', () => {
  const r = evaluarHeartbeat({ ultima_corrida: haceHoras(1), ok: false }, { ahora: T0, maxSilencioHoras: 26 });
  assert.equal(r.estado, 'CAIDO');
});

test('evaluarHeartbeat: sin señal -> SIN_DATOS', () => {
  assert.equal(evaluarHeartbeat(null, { ahora: T0 }).estado, 'SIN_DATOS');
  assert.equal(evaluarHeartbeat({}, { ahora: T0 }).estado, 'SIN_DATOS');
});

test('evaluarHeartbeat: timestamp invalido -> SIN_DATOS', () => {
  assert.equal(evaluarHeartbeat({ ultima_corrida: 'no-es-fecha' }, { ahora: T0 }).estado, 'SIN_DATOS');
});
