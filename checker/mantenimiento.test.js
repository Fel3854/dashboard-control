// checker/mantenimiento.test.js — tests de las ventanas de mantenimiento (Parte D), sin I/O.
// Correr con: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enMantenimiento } from './mantenimiento.js';

const T = (iso) => Date.parse(iso);
const AHORA = T('2026-08-01T03:00:00Z');

test('enMantenimiento: dentro de la ventana del proyecto -> true', () => {
  const ventanas = [{ nombre: 'ERP Masterbus', desde: '2026-08-01T02:00:00Z', hasta: '2026-08-01T04:00:00Z' }];
  assert.equal(enMantenimiento('ERP Masterbus', AHORA, ventanas), true);
});

test('enMantenimiento: fuera de la ventana -> false', () => {
  const ventanas = [{ nombre: 'ERP Masterbus', desde: '2026-08-01T05:00:00Z', hasta: '2026-08-01T06:00:00Z' }];
  assert.equal(enMantenimiento('ERP Masterbus', AHORA, ventanas), false);
});

test('enMantenimiento: ventana de otro proyecto no aplica', () => {
  const ventanas = [{ nombre: 'Otro', desde: '2026-08-01T02:00:00Z', hasta: '2026-08-01T04:00:00Z' }];
  assert.equal(enMantenimiento('ERP Masterbus', AHORA, ventanas), false);
});

test('enMantenimiento: ventana global "*" aplica a todos', () => {
  const ventanas = [{ nombre: '*', desde: '2026-08-01T02:00:00Z', hasta: '2026-08-01T04:00:00Z' }];
  assert.equal(enMantenimiento('Cualquiera', AHORA, ventanas), true);
});

test('enMantenimiento: sin desde/hasta = abierta por ese lado', () => {
  assert.equal(enMantenimiento('X', AHORA, [{ nombre: 'X', hasta: '2026-08-01T04:00:00Z' }]), true);
  assert.equal(enMantenimiento('X', AHORA, [{ nombre: 'X', desde: '2026-08-01T02:00:00Z' }]), true);
});

test('enMantenimiento: ventana con fechas invalidas se ignora', () => {
  assert.equal(enMantenimiento('X', AHORA, [{ nombre: 'X', desde: 'basura', hasta: 'nada' }]), false);
});

test('enMantenimiento: lista vacia o ausente -> false', () => {
  assert.equal(enMantenimiento('X', AHORA, []), false);
  assert.equal(enMantenimiento('X', AHORA), false);
});
