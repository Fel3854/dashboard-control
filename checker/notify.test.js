// checker/notify.test.js — tests de la logica de alertas (Fase 2), SIN red ni email.
// Correr con: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectarEventos, construirEmail, notify } from './notify.js';

const HORA = 3600_000;
const T0 = Date.parse('2026-06-04T12:00:00.000Z');

// Helpers para armar status.json sinteticos.
const status = (proyectos) => ({ timestamp: new Date(T0).toISOString(), proyectos });
const proy = (nombre, estado, extra = {}) => ({
  nombre,
  estado,
  latencia_ms: 100,
  http_code: estado === 'CAIDO' ? null : 200,
  plataforma: 'Test',
  desde: new Date(T0).toISOString(),
  ...extra,
});

// ── detectarEventos (puro) ────────────────────────────────────────────────────

test('detectarEventos: OK -> CAIDO genera una caida y registra la alerta', () => {
  const anterior = status([proy('A', 'OK')]);
  const nuevo = status([proy('A', 'CAIDO')]);
  const { eventos, alertasEstado } = detectarEventos(nuevo, anterior, {}, { ahora: T0 });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'caida');
  assert.equal(eventos[0].proyecto.nombre, 'A');
  assert.ok(alertasEstado['A'], 'debe registrar ultima_alerta para A');
});

test('detectarEventos: sigue CAIDO sin cumplir cooldown -> sin eventos', () => {
  const anterior = status([proy('A', 'CAIDO')]);
  const nuevo = status([proy('A', 'CAIDO')]);
  const registro = { A: new Date(T0 - 1 * HORA).toISOString() }; // alerto hace 1h
  const { eventos } = detectarEventos(nuevo, anterior, registro, { ahora: T0, cooldownMs: 6 * HORA });
  assert.equal(eventos.length, 0);
});

test('detectarEventos: sigue CAIDO con cooldown vencido -> recordatorio', () => {
  const anterior = status([proy('A', 'CAIDO')]);
  const nuevo = status([proy('A', 'CAIDO')]);
  const registro = { A: new Date(T0 - 7 * HORA).toISOString() }; // alerto hace 7h
  const { eventos, alertasEstado } = detectarEventos(nuevo, anterior, registro, {
    ahora: T0,
    cooldownMs: 6 * HORA,
  });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'recordatorio');
  assert.equal(alertasEstado['A'], new Date(T0).toISOString(), 'actualiza la ultima alerta');
});

test('detectarEventos: CAIDO -> OK genera recuperado y limpia el registro', () => {
  const anterior = status([proy('A', 'CAIDO')]);
  const nuevo = status([proy('A', 'OK')]);
  const registro = { A: new Date(T0 - 1 * HORA).toISOString() };
  const { eventos, alertasEstado } = detectarEventos(nuevo, anterior, registro, { ahora: T0 });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'recuperado');
  assert.equal(alertasEstado['A'], undefined, 'limpia el registro al recuperarse');
});

test('detectarEventos: sin cambios (OK -> OK) no genera eventos', () => {
  const anterior = status([proy('A', 'OK')]);
  const nuevo = status([proy('A', 'OK')]);
  const { eventos } = detectarEventos(nuevo, anterior, {}, { ahora: T0 });
  assert.equal(eventos.length, 0);
});

test('detectarEventos: proyecto que arranca CAIDO (sin anterior) -> caida', () => {
  const nuevo = status([proy('A', 'CAIDO')]);
  const { eventos } = detectarEventos(nuevo, null, {}, { ahora: T0 });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'caida');
});

test('detectarEventos: LENTO no dispara alertas', () => {
  const anterior = status([proy('A', 'OK')]);
  const nuevo = status([proy('A', 'LENTO')]);
  const { eventos } = detectarEventos(nuevo, anterior, {}, { ahora: T0 });
  assert.equal(eventos.length, 0);
});

// ── construirEmail ────────────────────────────────────────────────────────────

test('construirEmail: el asunto resume caidos y recuperados', () => {
  const eventos = [
    { tipo: 'caida', proyecto: proy('A', 'CAIDO') },
    { tipo: 'recuperado', proyecto: proy('B', 'OK') },
  ];
  const { asunto, cuerpo } = construirEmail(eventos);
  assert.match(asunto, /1 caído/);
  assert.match(asunto, /1 recuperado/);
  assert.match(cuerpo, /CAÍDO — A/);
  assert.match(cuerpo, /RECUPERADO — B/);
});

// ── notify (dry-run, no persiste ni envia) ────────────────────────────────────

test('notify: en DRY_RUN devuelve los eventos y no toca archivos', async () => {
  const anterior = status([proy('A', 'OK')]);
  const nuevo = status([proy('A', 'CAIDO')]);
  const r = await notify({ nuevo, anterior, dryRun: true });
  assert.equal(r.eventos.length, 1);
  assert.equal(r.eventos[0].tipo, 'caida');
  assert.ok(r.asunto.includes('caído'));
});

test('notify: sin eventos no devuelve asunto', async () => {
  const anterior = status([proy('A', 'OK')]);
  const nuevo = status([proy('A', 'OK')]);
  const r = await notify({ nuevo, anterior, dryRun: true });
  assert.equal(r.eventos.length, 0);
  assert.equal(r.asunto, undefined);
});
