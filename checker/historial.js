// checker/historial.js — Fase 3: historial de incidentes y % de uptime.
//
// history.json guarda un append de TRANSICIONES de estado (cambios), no una muestra por
// corrida: es compacto y permite reconstruir cuanto tiempo estuvo cada proyecto en cada
// estado. A partir de eso se calcula el % de uptime sobre una ventana movil.
//
// Todas las funciones son PURAS e importables (se testean sin I/O).

// Estados que cuentan como "online" (el servicio respondio / el batch corrio).
export const ESTADOS_UP = new Set(['OK', 'LENTO', 'DESPERTANDO']);

const DIA_MS = 24 * 3600_000;

/**
 * Devuelve los eventos a registrar: un evento por cada proyecto cuyo estado cambio
 * respecto del status anterior (o que aparece por primera vez).
 *
 * @returns {Array<{nombre:string, estado:string, timestamp:string}>}
 */
export function detectarTransiciones(nuevo, anterior, ahoraISO) {
  const eventos = [];
  for (const p of nuevo?.proyectos ?? []) {
    const prev = anterior?.proyectos?.find((x) => x.nombre === p.nombre);
    if (!prev || prev.estado !== p.estado) {
      eventos.push({ nombre: p.nombre, estado: p.estado, timestamp: ahoraISO });
    }
  }
  return eventos;
}

/**
 * % de tiempo "up" de un proyecto dentro de la ventana [ahora - ventana, ahora].
 * Reconstruye los tramos a partir de sus eventos (el estado vigente en cada instante es
 * el del ultimo evento <= ese instante).
 *
 * @param {Array<{estado:string, timestamp:string}>} eventosProyecto eventos de UN proyecto
 * @returns {number|null} porcentaje 0..100 (1 decimal) o null si no hay datos en la ventana
 */
export function calcularUptime(eventosProyecto, { ahora = Date.now(), ventanaDias = 30 } = {}) {
  const evs = eventosProyecto
    .map((e) => ({ estado: e.estado, ts: Date.parse(e.timestamp) }))
    .filter((e) => Number.isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts);
  if (evs.length === 0) return null;

  const inicio = ahora - ventanaDias * DIA_MS;

  // Estado vigente al instante `inicio` (ultimo evento <= inicio), si lo hay.
  let estadoEnInicio = null;
  for (const e of evs) {
    if (e.ts <= inicio) estadoEnInicio = e.estado;
    else break;
  }

  // Punto de arranque de la observacion.
  let cursor, estado;
  if (estadoEnInicio !== null) {
    cursor = inicio;
    estado = estadoEnInicio;
  } else {
    const primero = evs.find((e) => e.ts > inicio);
    if (!primero) return null; // sin datos dentro de la ventana
    cursor = primero.ts;
    estado = primero.estado;
  }

  let upMs = 0;
  let totalMs = 0;
  for (const e of evs) {
    if (e.ts <= cursor) continue;
    const fin = Math.min(e.ts, ahora);
    if (fin > cursor) {
      const dur = fin - cursor;
      totalMs += dur;
      if (ESTADOS_UP.has(estado)) upMs += dur;
      cursor = fin;
    }
    estado = e.estado;
    if (cursor >= ahora) break;
  }
  if (ahora > cursor) {
    const dur = ahora - cursor;
    totalMs += dur;
    if (ESTADOS_UP.has(estado)) upMs += dur;
  }

  if (totalMs <= 0) return null;
  return Math.round((upMs / totalMs) * 1000) / 10;
}

/**
 * Recorta el historial a `retencionDias`, pero conserva por proyecto el ultimo evento
 * anterior al limite (ancla) para no perder el estado de arranque del calculo de uptime.
 */
export function podarHistorial(eventos, { ahora = Date.now(), retencionDias = 90 } = {}) {
  const limite = ahora - retencionDias * DIA_MS;
  const recientes = [];
  const ancla = new Map();
  for (const e of eventos) {
    const ts = Date.parse(e.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (ts >= limite) {
      recientes.push(e);
    } else {
      const a = ancla.get(e.nombre);
      if (!a || Date.parse(a.timestamp) < ts) ancla.set(e.nombre, e);
    }
  }
  return [...ancla.values(), ...recientes].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
}
