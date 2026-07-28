// checker/mantenimiento.js — Parte D: ventanas de mantenimiento para silenciar alertas.
//
// mantenimiento.json es una lista de ventanas [{ nombre|"*", desde, hasta, motivo }]. Durante
// una ventana activa, el estado del proyecto se SIGUE registrando (status/history), pero NO se
// emiten alertas: sirve para no recibir avisos de una caida que uno mismo programo (deploy,
// migracion, corte planificado). El panel puede mostrar un badge 🛠.
//
// `enMantenimiento` es PURA e importable: se testea sin I/O.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(__dirname, '..');

/**
 * True si `nombre` esta dentro de alguna ventana de mantenimiento activa en `ahora`. Una
 * ventana con nombre "*" (o sin nombre) aplica a todos los proyectos. Sin `desde` = abierta
 * por izquierda; sin `hasta` = abierta por derecha. Pura.
 *
 * @param {string} nombre
 * @param {number} ahora  Date.now()
 * @param {Array<{nombre?:string, desde?:string, hasta?:string}>} ventanas
 * @returns {boolean}
 */
export function enMantenimiento(nombre, ahora, ventanas = []) {
  for (const v of ventanas ?? []) {
    if (v?.nombre && v.nombre !== '*' && v.nombre !== nombre) continue;
    const desde = v?.desde ? Date.parse(v.desde) : -Infinity;
    const hasta = v?.hasta ? Date.parse(v.hasta) : Infinity;
    if (Number.isNaN(desde) || Number.isNaN(hasta)) continue; // ventana mal escrita: se ignora
    if (ahora >= desde && ahora <= hasta) return true;
  }
  return false;
}

/** Lee mantenimiento.json del repo. Devuelve [] si no existe / no es valido. */
export async function leerVentanas() {
  try {
    const v = JSON.parse(await readFile(resolve(RAIZ, 'mantenimiento.json'), 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
