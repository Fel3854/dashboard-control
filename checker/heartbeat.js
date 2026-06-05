// checker/heartbeat.js — Fase 3: soporte de targets "heartbeat" (push).
//
// Para procesos que NO se pueden pinguear (ej. Rotacion, Streamlit local): el proceso
// reporta su "ultima corrida" escribiendo heartbeats/<slug>.json en el repo (ver
// heartbeat/ping.py). El checker lee esa señal y, si pasaron mas de `max_silencio_horas`
// sin novedad (o la corrida reporto fallo), marca CAIDO.
//
// `evaluarHeartbeat` es PURA e importable: se testea sin tocar el filesystem.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(__dirname, '..');

const MAX_SILENCIO_HORAS_DEFAULT = 26;

/** Convierte un nombre en slug de archivo: "Rotación" -> "rotacion". */
export function slug(nombre) {
  return String(nombre)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Decide el estado de un heartbeat a partir de la señal reportada. Pura.
 *
 * Estados:
 *  - OK        : reporto hace <= max_silencio_horas y la corrida fue exitosa.
 *  - CAIDO     : silencio mayor al permitido, o la ultima corrida reporto `ok: false`.
 *  - SIN_DATOS : nunca reporto (no hay señal todavia).
 *
 * @param {{ultima_corrida?:string, ok?:boolean}|null} senal
 * @returns {{estado:string, ultima_corrida:string|null, antiguedad_ms:number|null}}
 */
export function evaluarHeartbeat(senal, { ahora = Date.now(), maxSilencioHoras = MAX_SILENCIO_HORAS_DEFAULT } = {}) {
  if (!senal || !senal.ultima_corrida) {
    return { estado: 'SIN_DATOS', ultima_corrida: null, antiguedad_ms: null };
  }
  const ts = Date.parse(senal.ultima_corrida);
  if (!Number.isFinite(ts)) {
    return { estado: 'SIN_DATOS', ultima_corrida: senal.ultima_corrida, antiguedad_ms: null };
  }
  const antiguedad_ms = ahora - ts;
  let estado;
  if (senal.ok === false) estado = 'CAIDO';
  else if (antiguedad_ms > maxSilencioHoras * 3600_000) estado = 'CAIDO';
  else estado = 'OK';
  return { estado, ultima_corrida: senal.ultima_corrida, antiguedad_ms };
}

/** Lee heartbeats/<slug>.json del repo. Devuelve null si no existe / no es valido. */
export async function leerSenal(s) {
  try {
    return JSON.parse(await readFile(resolve(RAIZ, 'heartbeats', `${s}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Chequea un target heartbeat: lee su señal y la evalua.
 * @returns {{estado:string, ultima_corrida:string|null, latencia_ms:null, http_code:null}}
 */
export async function chequearHeartbeat(target, { ahora = Date.now(), leerSenalImpl = leerSenal } = {}) {
  const senal = await leerSenalImpl(target.slug || slug(target.nombre));
  const { estado, ultima_corrida } = evaluarHeartbeat(senal, {
    ahora,
    maxSilencioHoras: target.max_silencio_horas ?? MAX_SILENCIO_HORAS_DEFAULT,
  });
  return { estado, ultima_corrida, latencia_ms: null, http_code: null };
}
