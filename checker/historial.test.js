// checker/historial.test.js — tests de historial y uptime (Fase 3), funciones puras.
// Correr con: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectarTransiciones, calcularUptime, podarHistorial } from './historial.js';

const DIA = 24 * 3600_000;
const T0 = Date.parse('2026-06-04T12:00:00.000Z');
const haceDias = (d) => new Date(T0 - d * DIA).toISOString();
const status = (proyectos) => ({ proyectos });

// ── detectarTransiciones ──────────────────────────────────────────────────────

test('detectarTransiciones: cambio de estado genera un evento', () => {
  const anterior = status([{ nombre: 'A', estado: 'OK' }]);
  const nuevo = status([{ nombre: 'A', estado: 'CAIDO' }]);
  const evs = detectarTransiciones(nuevo, anterior, haceDias(0));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].estado, 'CAIDO');
});

test('detectarTransiciones: mismo estado no genera evento', () => {
  const anterior = status([{ nombre: 'A', estado: 'OK' }]);
  const nuevo = status([{ nombre: 'A', estado: 'OK' }]);
  assert.equal(detectarTransiciones(nuevo, anterior, haceDias(0)).length, 0);
});

test('detectarTransiciones: proyecto nuevo (sin anterior) genera evento', () => {
  const nuevo = status([{ nombre: 'A', estado: 'OK' }]);
  assert.equal(detectarTransiciones(nuevo, null, haceDias(0)).length, 1);
});

// ── calcularUptime ────────────────────────────────────────────────────────────

test('calcularUptime: siempre OK desde antes de la ventana -> 100%', () => {
  const eventos = [{ estado: 'OK', timestamp: haceDias(60) }];
  assert.equal(calcularUptime(eventos, { ahora: T0, ventanaDias: 30 }), 100);
});

test('calcularUptime: mitad OK, mitad CAIDO dentro de la ventana -> 50%', () => {
  const eventos = [
    { estado: 'OK', timestamp: haceDias(40) }, // ancla previa a la ventana
    { estado: 'CAIDO', timestamp: haceDias(15) }, // cae a mitad de la ventana de 30d
  ];
  assert.equal(calcularUptime(eventos, { ahora: T0, ventanaDias: 30 }), 50);
});

test('calcularUptime: LENTO y DESPERTANDO cuentan como up', () => {
  const eventos = [{ estado: 'LENTO', timestamp: haceDias(40) }];
  assert.equal(calcularUptime(eventos, { ahora: T0, ventanaDias: 30 }), 100);
});

test('calcularUptime: INACTIVO (heartbeat ocioso) cuenta como up, no penaliza', () => {
  const eventos = [
    { estado: 'OK', timestamp: haceDias(40) },
    { estado: 'INACTIVO', timestamp: haceDias(15) }, // dejo de correr, pero no es caida
  ];
  assert.equal(calcularUptime(eventos, { ahora: T0, ventanaDias: 30 }), 100);
});

test('calcularUptime: solo datos parciales dentro de la ventana', () => {
  // Primer dato hace 10 dias (no hay ancla previa): observa 10d, todo OK -> 100%
  const eventos = [{ estado: 'OK', timestamp: haceDias(10) }];
  assert.equal(calcularUptime(eventos, { ahora: T0, ventanaDias: 30 }), 100);
});

test('calcularUptime: sin eventos -> null', () => {
  assert.equal(calcularUptime([], { ahora: T0, ventanaDias: 30 }), null);
});

// ── podarHistorial ────────────────────────────────────────────────────────────

test('podarHistorial: descarta lo viejo pero conserva un ancla por proyecto', () => {
  const eventos = [
    { nombre: 'A', estado: 'OK', timestamp: haceDias(200) }, // muy viejo -> seria descartado
    { nombre: 'A', estado: 'CAIDO', timestamp: haceDias(120) }, // viejo -> ancla (el ultimo < limite)
    { nombre: 'A', estado: 'OK', timestamp: haceDias(10) }, // reciente -> se conserva
  ];
  const poda = podarHistorial(eventos, { ahora: T0, retencionDias: 90 });
  // queda el ancla (120d, ultimo previo al limite) + el reciente (10d) = 2
  assert.equal(poda.length, 2);
  assert.equal(poda[0].timestamp, haceDias(120));
  assert.equal(poda[1].timestamp, haceDias(10));
});
