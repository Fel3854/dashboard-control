// checker/check.js — Fase 1 del Dashboard de Control (Master Bus)
//
// Lee `proyectos.json`, pinguea cada target tipo "pull" con timeout y reintentos
// (backoff), calcula estado + latencia, y escribe `public/status.json`.
//
// Sin dependencias: usa `fetch` nativo, `AbortSignal.timeout` y `node:fs` (Node 20+).
// La logica de DECISION de estado (`decidirEstado`) es PURA e importable para testearla
// sin red (ver checker/check.test.js).

import { readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chequearHeartbeat } from './heartbeat.js';
import { detectarTransiciones, calcularUptime, podarHistorial } from './historial.js';
import { obtenerSalud } from './salud.js';
import { ejecutarFuncion } from './funcion.js';
import { obtenerCertificado, hostHttps } from './tls.js';
import { enMantenimiento, leerVentanas } from './mantenimiento.js';

const UPTIME_VENTANA_DIAS = 30; // ventana principal que muestra la fila
const UPTIME_VENTANAS = [7, 30, 90]; // ventanas extra para el detalle por proyecto

// ── Constantes de la logica de chequeo ───────────────────────────────────────
export const TIMEOUT_MS = 10_000; // corte por request
export const LENTO_MS = 3_000; // umbral OK vs LENTO
export const DELAYS = [0, 2_000, 5_000]; // 3 intentos; delay ANTES de cada intento (0s, 2s, 5s)

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(__dirname, '..');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pausa `ms` milisegundos. Inyectable en tests con un no-op para no esperar. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True si la URL ya esta configurada (no es un placeholder del proyectos.json). */
export function urlConfigurada(url) {
  return (
    typeof url === 'string' &&
    /^https?:\/\//i.test(url) &&
    !url.includes('COMPLETAR') &&
    !url.includes('<')
  );
}

// ── Un intento de GET ───────────────────────────────────────────────────────

/**
 * Hace UN GET y mide la latencia. No lanza: cualquier error/timeout se devuelve
 * como `{ ok: false }`.
 *
 * @returns {{ ok: boolean, http_code: number|null, latencia_ms: number, error?: string }}
 *   ok = respondio con status 2xx/3xx.
 */
export async function intentarUna(url, { timeout = TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const inicio = performance.now();
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
    const latencia_ms = Math.round(performance.now() - inicio);
    const http_code = res.status;
    return { ok: http_code >= 200 && http_code < 400, http_code, latencia_ms };
  } catch (err) {
    const latencia_ms = Math.round(performance.now() - inicio);
    return { ok: false, http_code: null, latencia_ms, error: String(err?.message ?? err) };
  }
}

// ── Decision de estado (PURA — el corazon testeable) ──────────────────────────

/**
 * Decide el estado a partir de los resultados de los intentos. Pura, sin red.
 *
 * Estados:
 *  - OK          : respondio 2xx/3xx con latencia < lentoMs.
 *  - LENTO       : respondio pero la latencia supera lentoMs.
 *  - CAIDO       : ningun intento respondio 2xx/3xx.
 *  - DESPERTANDO : fallo el 1er intento pero respondio en un reintento,
 *                  SOLO si el target tolera cold start.
 *
 * Nota: un target SIN tolera_cold_start que falla el 1er intento pero responde en un
 * reintento queda OK/LENTO segun latencia (el reintento "lo salva"). DESPERTANDO solo
 * aparece con toleraColdStart: true.
 *
 * @param {Array<{ok:boolean, latencia_ms:number}>} intentos
 * @param {{toleraColdStart?:boolean, lentoMs?:number}} opciones
 * @returns {'OK'|'LENTO'|'CAIDO'|'DESPERTANDO'}
 */
export function decidirEstado(intentos, { toleraColdStart = false, lentoMs = LENTO_MS } = {}) {
  const exitosos = intentos.filter((i) => i.ok);
  if (exitosos.length === 0) return 'CAIDO';

  const primerFallo = !intentos[0].ok;
  const exitoso = exitosos[0];

  if (toleraColdStart && primerFallo) return 'DESPERTANDO';
  if (exitoso.latencia_ms >= lentoMs) return 'LENTO';
  return 'OK';
}

// ── Chequeo completo de un target (con reintentos) ────────────────────────────

/**
 * Pinguea un target con reintentos/backoff y devuelve estado + metricas.
 * Corte temprano: si un intento responde ok, no reintenta mas.
 *
 * @returns {{estado:string, latencia_ms:number, http_code:number|null, intentos:number}}
 */
export async function chequearTarget(
  target,
  { fetchImpl = globalThis.fetch, sleep: sleepImpl = sleep, delays = DELAYS, timeout = TIMEOUT_MS } = {},
) {
  const intentos = [];
  for (const delay of delays) {
    if (delay > 0) await sleepImpl(delay);
    const r = await intentarUna(target.url, { timeout, fetchImpl });
    intentos.push(r);
    if (r.ok) break; // ya respondio, no hace falta seguir reintentando
  }

  const estado = decidirEstado(intentos, { toleraColdStart: Boolean(target.tolera_cold_start) });
  // El intento que define el resultado: el exitoso si lo hubo, si no el ultimo.
  const definitorio = intentos.find((i) => i.ok) ?? intentos[intentos.length - 1];

  return {
    estado,
    latencia_ms: definitorio.latencia_ms,
    http_code: definitorio.http_code,
    intentos: intentos.length,
  };
}

// ── Calculo de "desde cuando esta asi" ────────────────────────────────────────

/**
 * Compara contra el status anterior: si el proyecto seguia en el mismo estado,
 * conserva su `desde`; si cambio (o es nuevo), `desde` = ahora.
 */
export function resolverDesde(nombre, estadoNuevo, statusAnterior, ahoraISO) {
  const previo = statusAnterior?.proyectos?.find((p) => p.nombre === nombre);
  if (previo && previo.estado === estadoNuevo && previo.desde) return previo.desde;
  return ahoraISO;
}

/**
 * Igual que resolverDesde pero para el SUB-estado funcional (`proyecto.funcion`): conserva
 * `funcion.desde` si el estado funcional no cambio; si cambio (o es nuevo), `desde` = ahora.
 */
export function resolverDesdeFuncion(nombre, estadoNuevo, statusAnterior, ahoraISO) {
  const previo = statusAnterior?.proyectos?.find((p) => p.nombre === nombre)?.funcion;
  if (previo && previo.estado === estadoNuevo && previo.desde) return previo.desde;
  return ahoraISO;
}

// ── Lectura de archivos ───────────────────────────────────────────────────────

async function leerJSON(ruta) {
  const txt = await readFile(ruta, 'utf8');
  return JSON.parse(txt);
}

async function existe(ruta) {
  try {
    await access(ruta);
    return true;
  } catch {
    return false;
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

export async function main() {
  const configPath = resolve(RAIZ, process.env.PROYECTOS_FILE || process.argv[2] || 'proyectos.json');
  const statusPath = resolve(RAIZ, process.env.STATUS_FILE || 'public/status.json');
  const historyPath = resolve(RAIZ, process.env.HISTORY_FILE || 'history.json');

  const targets = await leerJSON(configPath);
  const anterior = (await existe(statusPath)) ? await leerJSON(statusPath) : null;
  const history = (await existe(historyPath)) ? await leerJSON(historyPath) : { eventos: [] };
  const ventanas = await leerVentanas(); // ventanas de mantenimiento (silencian alertas)

  const ahora = Date.now();
  const ahoraISO = new Date(ahora).toISOString();

  // Targets "pull" (se pinguean) y "heartbeat" (reportan su ultima corrida). Los pull
  // sin URL configurada (placeholders) se saltean.
  const proyectos = [];
  for (const t of targets) {
    let r;
    if (t.tipo === 'heartbeat') {
      r = await chequearHeartbeat(t, { ahora });
    } else if (t.tipo === 'pull') {
      if (!urlConfigurada(t.url)) {
        console.warn(`↷ Omitido (URL sin configurar): ${t.nombre} -> ${t.url}`);
        continue;
      }
      r = await chequearTarget(t);
    } else {
      console.warn(`↷ Omitido (tipo desconocido "${t.tipo}"): ${t.nombre}`);
      continue;
    }

    const desde = resolverDesde(t.nombre, r.estado, anterior, ahoraISO);
    const proyecto = {
      nombre: t.nombre,
      tipo: t.tipo,
      estado: r.estado,
      latencia_ms: r.latencia_ms ?? null,
      http_code: r.http_code ?? null,
      plataforma: t.plataforma ?? null,
      desde,
    };
    if (t.tipo === 'heartbeat') proyecto.ultima_corrida = r.ultima_corrida ?? null;
    if (t.max_silencio_horas != null) proyecto.max_silencio_horas = t.max_silencio_horas;

    // Criticidad: un servicio critico escala mas rapido en las alertas. Por defecto, una
    // dependencia (es_dependencia) es critica; se puede forzar con "critico": true.
    if (t.critico || t.es_dependencia) proyecto.critico = true;
    // Ventana de mantenimiento activa: el estado se registra igual, pero notify.js NO alerta.
    if (enMantenimiento(t.nombre, ahora, ventanas)) proyecto.mantenimiento = true;

    // Chequeo profundo (opt-in): si el target expone un /health JSON y respondio, leer sus
    // internos (version, base, uptime). Best-effort: si falla, `salud` queda null.
    if (t.tipo === 'pull' && t.salud_json && ['OK', 'LENTO', 'DESPERTANDO'].includes(r.estado)) {
      proyecto.salud = await obtenerSalud(t.url);
    }

    // Chequeo FUNCIONAL (opt-in): ejecuta una funcion real del servicio (ej. login + una
    // consulta que toca la DB) y valida la respuesta. Best-effort: si faltan secrets queda
    // FUNCION_OMITIDA, si falla la red/aserciones queda FUNCION_FALLA; nunca rompe el checker.
    // Solo tiene sentido si el servidor al menos responde.
    if (t.tipo === 'pull' && t.funcion && ['OK', 'LENTO', 'DESPERTANDO'].includes(r.estado)) {
      const f = await ejecutarFuncion(t.funcion, { env: process.env });
      if (f.estado !== 'FUNCION_OMITIDA') {
        f.desde = resolverDesdeFuncion(t.nombre, f.estado, anterior, ahoraISO);
      }
      proyecto.funcion = f;
      console.log(`    ↳ funcion: ${f.estado}${f.paso_fallo ? ` (falla en "${f.paso_fallo}": ${f.motivo})` : ''}`);
    }

    // Vencimiento del certificado TLS (best-effort): para cualquier pull https que responda,
    // leer cuantos dias faltan para que venza el cert. Sirve para avisar ANTES de que caduque
    // (un cert vencido tira el servicio). Si falla, `tls` queda sin setear.
    if (t.tipo === 'pull' && ['OK', 'LENTO', 'DESPERTANDO'].includes(r.estado)) {
      const host = hostHttps(t.url);
      if (host) {
        const cert = await obtenerCertificado(host, { ahora });
        if (cert) {
          proyecto.tls = cert;
          console.log(`    ↳ cert: vence en ${cert.dias_para_vencer} d (${cert.valido_hasta})`);
        }
      }
    }
    proyectos.push(proyecto);

    const metrica =
      t.tipo === 'heartbeat'
        ? `corrida=${r.ultima_corrida ?? '-'}`
        : `${r.latencia_ms}ms  http=${r.http_code ?? '-'}`;
    console.log(`• ${t.nombre.padEnd(32)} ${r.estado.padEnd(11)} ${metrica}`);
  }

  // ── Historial: registrar transiciones (+ sembrar proyectos sin historia) ─────
  const transiciones = detectarTransiciones({ proyectos }, anterior, ahoraISO);
  const conHistoria = new Set(history.eventos.map((e) => e.nombre));
  for (const p of proyectos) {
    if (!conHistoria.has(p.nombre) && !transiciones.some((e) => e.nombre === p.nombre)) {
      transiciones.push({ nombre: p.nombre, estado: p.estado, timestamp: p.desde || ahoraISO });
    }
  }
  history.eventos = podarHistorial([...history.eventos, ...transiciones], { ahora });

  // ── Uptime por proyecto (varias ventanas moviles) ───────────────────────────
  // uptime = ventana principal (fila); uptimes = {7,30,90} para el detalle al click.
  for (const p of proyectos) {
    const eventosP = history.eventos.filter((e) => e.nombre === p.nombre);
    p.uptimes = {};
    for (const dias of UPTIME_VENTANAS) {
      p.uptimes[dias] = calcularUptime(eventosP, { ahora, ventanaDias: dias });
    }
    p.uptime = p.uptimes[UPTIME_VENTANA_DIAS];
  }

  const nuevo = { timestamp: ahoraISO, uptime_ventana_dias: UPTIME_VENTANA_DIAS, proyectos };

  await writeFile(statusPath, JSON.stringify(nuevo, null, 2) + '\n', 'utf8');
  await writeFile(historyPath, JSON.stringify(history, null, 2) + '\n', 'utf8');
  // Copia del historial junto al status (public/) para que el panel (Pages) lo sirva y
  // dibuje el detalle por proyecto. history.json en la raiz sigue siendo la fuente.
  await writeFile(resolve(dirname(statusPath), 'history.json'), JSON.stringify(history, null, 2) + '\n', 'utf8');
  console.log(
    `\n✓ status.json (${proyectos.length} proyecto/s) y history.json (${history.eventos.length} evento/s) escritos.`,
  );

  // ── Hook Fase 2 (alertas por email) ─────────────────────────────────────────
  // notify.js todavia NO existe en Fase 1. Cuando se cree (exportando `notify`),
  // se llamara automaticamente aca, despues de escribir status.json, sin tocar este archivo.
  try {
    const { notify } = await import('./notify.js');
    await notify({ nuevo, anterior, history, dryRun: process.env.DRY_RUN === '1' });
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') {
      console.error('notify.js fallo:', err?.message ?? err);
    }
    // Si no existe el modulo (Fase 1), se ignora en silencio.
  }

  return nuevo;
}

// Solo corre main() si se ejecuta directamente (no al importarlo en tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Error en el checker:', err);
    process.exit(1);
  });
}
