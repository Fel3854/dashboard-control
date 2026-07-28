// checker/tls.test.js — tests del chequeo de vencimiento TLS (Parte C).
// La logica pura (diasParaVencer, hostHttps) se testea sin red; obtenerCertificado con un
// connect mockeado. Correr con: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diasParaVencer, hostHttps, obtenerCertificado } from './tls.js';

const AHORA = Date.parse('2026-01-01T00:00:00.000Z');

// ── diasParaVencer (pura) ──────────────────────────────────────────────────────

test('diasParaVencer: cert que vence en 30 dias', () => {
  assert.equal(diasParaVencer('2026-01-31T00:00:00Z', AHORA), 30);
});

test('diasParaVencer: cert que vence en 5 dias', () => {
  assert.equal(diasParaVencer('2026-01-06T00:00:00Z', AHORA), 5);
});

test('diasParaVencer: cert YA vencido -> negativo', () => {
  assert.ok(diasParaVencer('2025-12-01T00:00:00Z', AHORA) < 0);
});

test('diasParaVencer: acepta el formato OpenSSL del cert real', () => {
  const d = diasParaVencer('Jan 31 00:00:00 2026 GMT', AHORA);
  assert.equal(d, 30);
});

test('diasParaVencer: fecha invalida -> null', () => {
  assert.equal(diasParaVencer('no-es-fecha', AHORA), null);
  assert.equal(diasParaVencer(undefined, AHORA), null);
});

// ── hostHttps (pura) ───────────────────────────────────────────────────────────

test('hostHttps: extrae el host de una URL https', () => {
  assert.equal(hostHttps('https://example.com/health'), 'example.com');
  assert.equal(hostHttps('https://sub.dominio.com:443/x?y=1'), 'sub.dominio.com');
});

test('hostHttps: http o basura -> null', () => {
  assert.equal(hostHttps('http://example.com'), null);
  assert.equal(hostHttps('no es una url'), null);
});

// ── obtenerCertificado (I/O, con connect mockeado) ─────────────────────────────

const connectOK = (cert) => (_opts, cb) => {
  const socket = { getPeerCertificate: () => cert, end() {}, destroy() {}, on() { return socket; } };
  queueMicrotask(() => cb());
  return socket;
};

const connectError = () => (_opts, _cb) => {
  const handlers = {};
  const socket = {
    getPeerCertificate: () => ({}),
    end() {}, destroy() {},
    on(ev, h) { handlers[ev] = h; return socket; },
  };
  queueMicrotask(() => handlers.error && handlers.error(new Error('boom')));
  return socket;
};

test('obtenerCertificado: devuelve valido_hasta y dias_para_vencer', async () => {
  const r = await obtenerCertificado('example.com', {
    ahora: AHORA,
    connectImpl: connectOK({ valid_to: '2026-01-31T00:00:00Z' }),
  });
  assert.deepEqual(r, { valido_hasta: '2026-01-31T00:00:00Z', dias_para_vencer: 30 });
});

test('obtenerCertificado: sin cert utilizable -> null', async () => {
  const r = await obtenerCertificado('example.com', { ahora: AHORA, connectImpl: connectOK({}) });
  assert.equal(r, null);
});

test('obtenerCertificado: error de conexion -> null (best-effort, no rompe)', async () => {
  const r = await obtenerCertificado('example.com', { ahora: AHORA, connectImpl: connectError() });
  assert.equal(r, null);
});
