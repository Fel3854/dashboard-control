// checker/notify.test.js — tests de la logica de alertas (Fase 2), SIN red ni email.
// Correr con: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectarEventos, construirEmail, notify, severidadEvento } from './notify.js';

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

// ── detectarEventos: sub-estado FUNCIONAL (ping verde, funcion rota) ──────────

// Helper: proyecto con ping OK pero con bloque funcion.
const proyF = (nombre, estadoF, extra = {}) =>
  proy(nombre, 'OK', { funcion: { estado: estadoF, descripcion: 'login + consulta', desde: new Date(T0).toISOString(), ...extra } });

test('detectarEventos: FUNCION_OK -> FUNCION_FALLA dispara funcion_caida (ping en verde)', () => {
  const anterior = status([proyF('A', 'FUNCION_OK')]);
  const nuevo = status([proyF('A', 'FUNCION_FALLA', { paso_fallo: 'consulta', motivo: "falta el campo 'sugerido'" })]);
  const { eventos, alertasEstado } = detectarEventos(nuevo, anterior, {}, { ahora: T0 });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'funcion_caida');
  assert.ok(alertasEstado['funcion:A'], 'usa clave de cooldown separada para la funcion');
  assert.equal(alertasEstado['A'], undefined, 'no toca el cooldown del servicio');
});

test('detectarEventos: FUNCION_FALLA -> FUNCION_OK dispara funcion_recuperada y limpia', () => {
  const anterior = status([proyF('A', 'FUNCION_FALLA')]);
  const nuevo = status([proyF('A', 'FUNCION_OK')]);
  const registro = { 'funcion:A': new Date(T0 - 1 * HORA).toISOString() };
  const { eventos, alertasEstado } = detectarEventos(nuevo, anterior, registro, { ahora: T0 });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'funcion_recuperada');
  assert.equal(alertasEstado['funcion:A'], undefined);
});

test('detectarEventos: funcion sigue fallando sin cumplir cooldown -> sin eventos', () => {
  const anterior = status([proyF('A', 'FUNCION_FALLA')]);
  const nuevo = status([proyF('A', 'FUNCION_FALLA')]);
  const registro = { 'funcion:A': new Date(T0 - 1 * HORA).toISOString() };
  const { eventos } = detectarEventos(nuevo, anterior, registro, { ahora: T0, cooldownMs: 6 * HORA });
  assert.equal(eventos.length, 0);
});

test('detectarEventos: FUNCION_OMITIDA no genera eventos', () => {
  const anterior = status([proyF('A', 'FUNCION_OK')]);
  const nuevo = status([proyF('A', 'FUNCION_OMITIDA')]);
  const { eventos } = detectarEventos(nuevo, anterior, {}, { ahora: T0 });
  assert.equal(eventos.length, 0);
});

// ── detectarEventos: avisos blandos (cert por vencer, lento sostenido) ─────────

test('detectarEventos: cert por vencer (<= umbral) dispara aviso y registra cooldown', () => {
  const nuevo = status([proy('A', 'OK', { tls: { dias_para_vencer: 10, valido_hasta: '2026-06-14' } })]);
  const { eventos, alertasEstado } = detectarEventos(nuevo, null, {}, { ahora: T0 });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'cert_por_vencer');
  assert.ok(alertasEstado['cert:A'], 'usa clave de cooldown cert:<nombre>');
});

test('detectarEventos: cert por vencer respeta el cooldown diario', () => {
  const nuevo = status([proy('A', 'OK', { tls: { dias_para_vencer: 10 } })]);
  const registro = { 'cert:A': new Date(T0 - 5 * HORA).toISOString() }; // aviso hace 5h (< 24h)
  const { eventos } = detectarEventos(nuevo, null, registro, { ahora: T0 });
  assert.equal(eventos.length, 0);
});

test('detectarEventos: cert con margen (> umbral) no avisa y limpia el registro', () => {
  const nuevo = status([proy('A', 'OK', { tls: { dias_para_vencer: 60 } })]);
  const registro = { 'cert:A': new Date(T0 - 48 * HORA).toISOString() };
  const { eventos, alertasEstado } = detectarEventos(nuevo, null, registro, { ahora: T0 });
  assert.equal(eventos.length, 0);
  assert.equal(alertasEstado['cert:A'], undefined);
});

test('detectarEventos: LENTO sostenido (continuo >= umbral) dispara aviso', () => {
  const desde = new Date(T0 - 60 * 60_000).toISOString(); // LENTO desde hace 60 min
  const nuevo = status([proy('A', 'LENTO', { desde, latencia_ms: 4000 })]);
  const anterior = status([proy('A', 'LENTO', { desde })]);
  const { eventos } = detectarEventos(nuevo, anterior, {}, { ahora: T0 });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'lento_sostenido');
});

test('detectarEventos: LENTO recien empezado NO dispara lento_sostenido', () => {
  const nuevo = status([proy('A', 'LENTO')]); // desde = T0 (ahora) -> continuo 0
  const anterior = status([proy('A', 'OK')]);
  const { eventos } = detectarEventos(nuevo, anterior, {}, { ahora: T0 });
  assert.equal(eventos.length, 0);
});

// ── detectarEventos: alertas avanzadas (severidad, escalamiento, flapping, mantenimiento) ──

test('detectarEventos: caida de servicio critico -> severidad CRITICO', () => {
  const anterior = status([proy('A', 'OK', { critico: true })]);
  const nuevo = status([proy('A', 'CAIDO', { critico: true })]);
  const { eventos } = detectarEventos(nuevo, anterior, {}, { ahora: T0 });
  assert.equal(eventos[0].tipo, 'caida');
  assert.equal(eventos[0].severidad, 'CRITICO');
});

test('detectarEventos: critico caido hace rato con cooldown vencido -> escalado', () => {
  const desde = new Date(T0 - 2 * HORA).toISOString(); // caido hace 2h (> umbral escalar 1h)
  const anterior = status([proy('A', 'CAIDO', { critico: true, desde })]);
  const nuevo = status([proy('A', 'CAIDO', { critico: true, desde })]);
  const registro = { A: new Date(T0 - 45 * 60_000).toISOString() }; // aviso hace 45 min (> 30 min)
  const { eventos } = detectarEventos(nuevo, anterior, registro, { ahora: T0 });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'escalado');
  assert.equal(eventos[0].severidad, 'CRITICO');
});

test('detectarEventos: critico usa cooldown corto (recordatorio a los 45 min, aun sin escalar)', () => {
  const desde = new Date(T0 - 40 * 60_000).toISOString(); // caido hace 40 min (< 1h: no escala)
  const anterior = status([proy('A', 'CAIDO', { critico: true, desde })]);
  const nuevo = status([proy('A', 'CAIDO', { critico: true, desde })]);
  const registro = { A: new Date(T0 - 45 * 60_000).toISOString() };
  const { eventos } = detectarEventos(nuevo, anterior, registro, { ahora: T0 });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'recordatorio');
});

test('detectarEventos: flapping suprime la caida y emite un solo aviso de inestable', () => {
  const evs = [5, 15, 25, 35, 45].map((m) => ({ nombre: 'A', estado: 'CAIDO', timestamp: new Date(T0 - m * 60_000).toISOString() }));
  const history = { eventos: evs };
  const anterior = status([proy('A', 'OK')]);
  const nuevo = status([proy('A', 'CAIDO')]);
  const { eventos } = detectarEventos(nuevo, anterior, {}, { ahora: T0, history });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'flapping');
});

test('detectarEventos: proyecto en mantenimiento no genera alertas', () => {
  const anterior = status([proy('A', 'OK')]);
  const nuevo = status([proy('A', 'CAIDO', { mantenimiento: true })]);
  const { eventos } = detectarEventos(nuevo, anterior, {}, { ahora: T0 });
  assert.equal(eventos.length, 0);
});

test('severidadEvento: clasifica CRITICO / AVISO / INFO', () => {
  assert.equal(severidadEvento('caida', { critico: true }), 'CRITICO');
  assert.equal(severidadEvento('escalado', { critico: true }), 'CRITICO');
  assert.equal(severidadEvento('caida', {}), 'AVISO');
  assert.equal(severidadEvento('cert_por_vencer', { critico: true }), 'AVISO');
  assert.equal(severidadEvento('recuperado', { critico: true }), 'INFO');
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

test('construirEmail: evento funcional muestra el paso y el motivo de la falla', () => {
  const eventos = [
    {
      tipo: 'funcion_caida',
      proyecto: proyF('Cubiertas', 'FUNCION_FALLA', { paso_fallo: 'consulta', motivo: "falta el campo 'sugerido'" }),
    },
  ];
  const { asunto, cuerpo } = construirEmail(eventos);
  assert.match(asunto, /1 función\/es fallando/);
  assert.match(cuerpo, /FUNCIÓN FALLA — Cubiertas/);
  assert.match(cuerpo, /falló en "consulta"/);
  assert.match(cuerpo, /sugerido/);
});

test('construirEmail: resume avisos (cert/lento) en el asunto y el cuerpo', () => {
  const eventos = [
    { tipo: 'cert_por_vencer', proyecto: proy('A', 'OK', { tls: { dias_para_vencer: 7, valido_hasta: '2026-06-11' } }) },
  ];
  const { asunto, cuerpo } = construirEmail(eventos);
  assert.match(asunto, /1 aviso/);
  assert.match(cuerpo, /CERT POR VENCER — A/);
  assert.match(cuerpo, /vence en 7 día/);
});

test('construirEmail: un evento CRÍTICO agrega el prefijo al asunto', () => {
  const eventos = [{ tipo: 'caida', severidad: 'CRITICO', proyecto: proy('ERP', 'CAIDO', { critico: true }) }];
  const { asunto } = construirEmail(eventos);
  assert.match(asunto, /🚨 CRÍTICO/);
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
