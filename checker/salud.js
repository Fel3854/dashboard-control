// checker/salud.js — Parte A: chequeo "profundo" opt-in (salud_json).
//
// Para targets `pull` con `"salud_json": true`, ademas del ping (que solo mira 2xx +
// latencia) se hace UNA lectura del cuerpo del endpoint /health y se extraen sus internos
// (version, estado de la base, uptime). Asi el panel muestra si el servicio esta sano POR
// DENTRO, no solo si contesta.
//
// `extraerSalud` es PURA e importable: se testea sin red (ver checker/salud.test.js).

// Whitelist de claves seguras: el panel NUNCA debe guardar/exponer campos arbitrarios ni
// sensibles (connection strings, tokens, etc.) que un /health pudiera incluir por error.
export const CLAVES_PERMITIDAS = ['status', 'version', 'db', 'database', 'uptime_s', 'commit'];

const MAX_STR = 80; // recorte defensivo de strings largos

/**
 * Extrae los internos seguros de un JSON de /health. Pura, sin red.
 *
 * - Solo conserva las claves del whitelist.
 * - Solo acepta valores string/number/boolean (objetos/arrays se descartan).
 * - Recorta strings a MAX_STR.
 * - Normaliza `database` -> `db` si solo vino la primera.
 *
 * @param {unknown} json  cuerpo parseado del endpoint /health
 * @returns {Object|null}  internos seguros, o null si no hay nada util
 */
export function extraerSalud(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  const out = {};
  for (const k of CLAVES_PERMITIDAS) {
    if (!(k in json)) continue;
    let v = json[k];
    if (typeof v === 'string') v = v.slice(0, MAX_STR);
    else if (typeof v !== 'number' && typeof v !== 'boolean') continue; // descarta objetos/arrays/null
    out[k] = v;
  }

  if (out.database != null && out.db == null) {
    out.db = out.database;
  }
  delete out.database;

  return Object.keys(out).length ? out : null;
}

/**
 * Lee el /health de un target y devuelve sus internos seguros. Best-effort: cualquier
 * error (timeout, no-JSON, parseo) devuelve null y NO rompe el checker.
 *
 * @returns {Promise<Object|null>}
 */
export async function obtenerSalud(url, { fetchImpl = globalThis.fetch, timeout = 5_000 } = {}) {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    });
    const ct = res.headers?.get?.('content-type') || '';
    if (!ct.includes('json')) return null; // la home suele ser HTML: no es un /health
    return extraerSalud(await res.json());
  } catch {
    return null;
  }
}
