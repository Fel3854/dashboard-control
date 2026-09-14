// checker/funcion.js — Chequeo FUNCIONAL (mas alla del ping).
//
// El ping (check.js) solo dice "el servidor responde". Esto va un paso mas: EJECUTA una
// funcion real del servicio via HTTP (ej. login + una consulta que toca la base) y VALIDA
// la respuesta. Asi se detectan fallas que un 200 OK no ve (login roto, DB caida detras de
// un front que igual carga, deploy que rompio la logica).
//
// Sin dependencias: usa `fetch` nativo (Node 20+). Best-effort: nunca lanza; si falla la
// red o faltan secrets, devuelve un estado, no rompe el checker. La logica de DECISION
// (`cumpleEspera`, `evaluarFuncion`) es PURA e importable para testearla sin red
// (ver checker/funcion.test.js).
//
// Config declarativa (en proyectos.json, bloque `funcion`): una lista de `pasos`, cada uno
// un request HTTP con una `espera` (aserciones). Soporta flujos con login: jar de cookies
// (se capturan y reenvian todas, browser-like) y extraccion de valores del cuerpo de un paso
// (ej. token CSRF) para usarlos en el siguiente. Secretos via `env:NOMBRE` (GitHub Secrets);
// valores extraidos via `var:NOMBRE`. Sumar otro servicio = solo agregar su bloque `funcion`.

const TIMEOUT_MS = 10_000; // corte por request
// Hasta 3 intentos por paso (delay ANTES de cada uno). Se reintenta SOLO si la falla parece
// transitoria (cold start / blip de red): asi un servicio que escala a cero (ej. Modal/Render)
// no genera falsos FUNCION_FALLA. Una falla real (401, campo faltante) no se reintenta.
const DELAYS_FUNCION = [0, 1_500, 3_500];

/** Pausa `ms` milisegundos. Inyectable en tests con un no-op para no esperar el backoff. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ¿La falla del paso parece transitoria (cold start / gateway) y conviene reintentar? */
export function esTransitorio(resultado) {
  if (resultado.error) return true; // red caida / connection reset / timeout
  if (typeof resultado.status === 'number' && resultado.status >= 500) return true; // 502/503/504
  return false;
}

// ── Interpolacion de secretos / variables ─────────────────────────────────────

/**
 * Resuelve referencias en un valor de config:
 *  - "env:NOMBRE" -> proceso/Secret (`ctx.env`).
 *  - "var:NOMBRE" -> valor extraido de un paso anterior (`ctx.vars`, ej. token CSRF).
 * Cualquier otro valor se devuelve tal cual.
 */
export function interpolar(valor, { env = {}, vars = {} } = {}) {
  if (typeof valor === 'string') {
    if (valor.startsWith('env:')) return env[valor.slice(4)] ?? '';
    if (valor.startsWith('var:')) return vars[valor.slice(4)] ?? '';
  }
  return valor;
}

/** Aplica un regex al texto y devuelve el 1er grupo (o el match completo). null si no matchea. */
export function extraerValor(texto, regex) {
  try {
    const m = String(texto).match(new RegExp(regex));
    if (!m) return null;
    return m[1] ?? m[0];
  } catch {
    return null;
  }
}

/**
 * Extrae un mensaje de error LEGIBLE del cuerpo JSON de una respuesta fallida, para anexarlo al
 * motivo y hacer el diagnostico autoexplicativo (ej. un 400 de Supabase pasa de "status 400" a
 * "status 400: Invalid login credentials"). Prueba los campos que usan las APIs mas comunes:
 * Supabase/GoTrue (`error_description`, `msg`), Laravel/genericas (`message`, `error`). Devuelve el
 * primero que sea un string no vacio, recortado; null si el body no es objeto o no trae ninguno.
 */
export function mensajeError(json) {
  if (!json || typeof json !== 'object') return null;
  for (const clave of ['error_description', 'msg', 'message', 'error']) {
    const v = json[clave];
    if (typeof v === 'string' && v.trim()) {
      const limpio = v.trim();
      return limpio.length > 120 ? `${limpio.slice(0, 117)}...` : limpio;
    }
  }
  return null;
}

/**
 * ¿El cuerpo es HTML? Se usa para que "no es JSON" diga TAMBIEN de que se trata: cuando un
 * endpoint JSON devuelve HTML, casi siempre es la app rebotando la request a una pantalla
 * (login por sesion vencida, o la home por falta de permisos) y el fetch siguio el redirect.
 * Sin esta pista el motivo es un callejon sin salida ("la respuesta no es JSON" a secas).
 */
export function pareceHtml(texto) {
  if (typeof texto !== 'string') return false;
  const cabeza = texto.trimStart().slice(0, 200).toLowerCase();
  return cabeza.startsWith('<!doctype html') || cabeza.startsWith('<html') || cabeza.includes('<head');
}

// ── Aserciones (PURA — sin red) ───────────────────────────────────────────────

/**
 * Evalua la `espera` de un paso contra el resultado del fetch. Pura.
 *
 * Vocabulario de `espera`:
 *  - status            : numero o lista de status HTTP aceptados.
 *  - json_tiene        : lista de claves que deben existir en el body JSON (objeto).
 *  - json_array_no_vacio: true si el body debe ser un array JSON con al menos un elemento
 *                         (ej. un listado que toca la DB: confirma que trajo filas reales).
 *  - texto_incluye     : substring que debe aparecer en el body (para respuestas HTML).
 *  - texto_no_incluye  : substring que NO debe aparecer (ej. el form de login => no autenticado).
 *  - location_incluye / location_no_incluye : substring (que debe / no debe) estar en el header
 *                         Location del redirect (ej. login OK redirige fuera de "/login").
 *
 * @param {object} espera
 * @param {{status:number|null, json:object|null, texto:string|null, location:string|null, error?:string}} resultado
 * @returns {{ ok: boolean, motivo?: string }}
 */
export function cumpleEspera(espera = {}, resultado) {
  if (resultado?.error) return { ok: false, motivo: `error de red: ${resultado.error}` };

  if (espera.status != null) {
    const aceptados = Array.isArray(espera.status) ? espera.status : [espera.status];
    if (!aceptados.includes(resultado.status)) {
      // Si el cuerpo trae un mensaje de error (ej. Supabase "Invalid login credentials"), se anexa
      // para que el motivo diga QUE fallo, no solo el codigo. Sin body util, queda como antes.
      const detalle = mensajeError(resultado.json);
      const base = `status ${resultado.status ?? '-'} (esperaba ${aceptados.join('/')})`;
      if (detalle) return { ok: false, motivo: `${base}: ${detalle}` };
      // Un redirect inesperado se explica solo con su destino: "302 -> /login" es sesion caida,
      // "302 -> /" suele ser el middleware de permisos rebotando al usuario del monitoreo.
      if (resultado.status >= 300 && resultado.status < 400 && resultado.location) {
        return { ok: false, motivo: `${base} → redirige a '${resultado.location}'` };
      }
      return { ok: false, motivo: base };
    }
  }

  if (espera.json_array_no_vacio) {
    if (!Array.isArray(resultado.json)) return { ok: false, motivo: 'la respuesta no es un array JSON' };
    if (resultado.json.length === 0) return { ok: false, motivo: 'el array JSON vino vacío' };
  }

  if (Array.isArray(espera.json_tiene) && espera.json_tiene.length > 0) {
    if (!resultado.json || typeof resultado.json !== 'object') {
      const motivo = pareceHtml(resultado.texto)
        ? 'la respuesta no es JSON: vino HTML (la app rebotó a una pantalla — ¿sesión vencida o sin permiso?)'
        : 'la respuesta no es JSON';
      return { ok: false, motivo };
    }
    for (const clave of espera.json_tiene) {
      if (!(clave in resultado.json)) return { ok: false, motivo: `falta el campo '${clave}'` };
    }
  }

  if (typeof espera.texto_incluye === 'string') {
    if (!resultado.texto || !resultado.texto.includes(espera.texto_incluye)) {
      return { ok: false, motivo: `no contiene '${espera.texto_incluye}'` };
    }
  }

  if (typeof espera.texto_no_incluye === 'string') {
    if (resultado.texto && resultado.texto.includes(espera.texto_no_incluye)) {
      return { ok: false, motivo: `contiene '${espera.texto_no_incluye}' (no debería)` };
    }
  }

  if (typeof espera.location_incluye === 'string') {
    if (!resultado.location || !resultado.location.includes(espera.location_incluye)) {
      return { ok: false, motivo: `redirige a '${resultado.location ?? '-'}' (esperaba que incluya '${espera.location_incluye}')` };
    }
  }

  if (typeof espera.location_no_incluye === 'string') {
    if (resultado.location && resultado.location.includes(espera.location_no_incluye)) {
      return { ok: false, motivo: `redirige a '${resultado.location}' (no debería incluir '${espera.location_no_incluye}')` };
    }
  }

  return { ok: true };
}

// ── Decision del estado funcional (PURA) ──────────────────────────────────────

/**
 * Decide el estado a partir de las evaluaciones de cada paso. Pura, sin red.
 *
 * Estados:
 *  - FUNCION_OK    : todos los pasos cumplieron su `espera`.
 *  - FUNCION_FALLA : algun paso fallo (devuelve el primero + su motivo).
 *
 * @param {Array<{nombre:string, ok:boolean, motivo?:string}>} evaluaciones
 * @returns {{ estado:'FUNCION_OK'|'FUNCION_FALLA', paso_fallo?:string, motivo?:string }}
 */
export function evaluarFuncion(evaluaciones) {
  const fallo = evaluaciones.find((e) => !e.ok);
  if (!fallo) return { estado: 'FUNCION_OK' };
  return { estado: 'FUNCION_FALLA', paso_fallo: fallo.nombre, motivo: fallo.motivo };
}

// ── Un paso (I/O) ─────────────────────────────────────────────────────────────

/**
 * Hace UN request del paso y devuelve su resultado crudo. No lanza: la red caida / timeout
 * se devuelven como `{ error }`. Mantiene un jar de cookies en `ctx.cookies` (se capturan
 * TODAS las Set-Cookie y se reenvian en cada request, como un navegador) y `ctx.vars` con los
 * valores extraidos (ej. token CSRF) para interpolar en pasos siguientes.
 *
 * Opciones del paso: url, metodo, cuerpo_form|cuerpo_json, headers, no_seguir_redirect,
 * extraer:{var,regex}. (`guardar_cookie` se mantiene por compatibilidad: fuerza redirect manual.)
 *
 * @param {object} paso
 * @param {{env:object, vars:object, cookies:object}} ctx  estado compartido entre pasos
 * @returns {Promise<{nombre:string, status:number|null, json:object|null, texto:string|null, location:string|null, error?:string}>}
 */
export async function chequearPaso(paso, ctx, { fetchImpl = globalThis.fetch } = {}) {
  const headers = {};
  const ent = { env: ctx.env, vars: ctx.vars };
  // Para capturar la cookie de un redirect (login 302) o inspeccionar el Location, no seguirlo.
  const manual = Boolean(paso.guardar_cookie || paso.no_seguir_redirect);
  const opciones = {
    method: paso.metodo || 'GET',
    headers,
    redirect: manual ? 'manual' : 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };

  if (paso.cuerpo_form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(paso.cuerpo_form)) params.set(k, interpolar(v, ent));
    headers['content-type'] = 'application/x-www-form-urlencoded';
    opciones.body = params.toString();
  } else if (paso.cuerpo_json) {
    const obj = {};
    for (const [k, v] of Object.entries(paso.cuerpo_json)) obj[k] = interpolar(v, ent);
    headers['content-type'] = 'application/json';
    opciones.body = JSON.stringify(obj);
  }

  // Headers extra del paso (ej. apikey de Supabase), tambien interpolables.
  if (paso.headers) {
    for (const [k, v] of Object.entries(paso.headers)) headers[k.toLowerCase()] = interpolar(v, ent);
  }

  // Reenviar el jar de cookies acumulado.
  const jar = Object.entries(ctx.cookies || {});
  if (jar.length > 0) headers['cookie'] = jar.map(([k, v]) => `${k}=${v}`).join('; ');

  let res;
  try {
    res = await fetchImpl(paso.url, opciones);
  } catch (err) {
    return { nombre: paso.nombre, status: null, json: null, texto: null, location: null, error: String(err?.message ?? err) };
  }

  // Capturar TODAS las cookies (session, XSRF, token, …) en el jar para los pasos siguientes.
  if (typeof res.headers?.getSetCookie === 'function') {
    for (const c of res.headers.getSetCookie()) {
      const par = c.split(';')[0];
      const idx = par.indexOf('=');
      if (idx > 0) ctx.cookies[par.slice(0, idx).trim()] = par.slice(idx + 1).trim();
    }
  }
  const location = typeof res.headers?.get === 'function' ? res.headers.get('location') : null;

  // Leer el body UNA vez como texto e intentar parsear JSON (para soportar ambas aserciones).
  const texto = await res.text().catch(() => null);
  let json = null;
  if (texto) {
    try {
      json = JSON.parse(texto);
    } catch {
      /* no es JSON: queda null y las aserciones json_tiene fallan con motivo claro */
    }
  }

  // Extraer un valor del cuerpo para pasos siguientes (ej. token CSRF del HTML del login).
  if (paso.extraer && texto) {
    const val = extraerValor(texto, paso.extraer.regex);
    if (val != null) ctx.vars[paso.extraer.var] = val;
  }

  return { nombre: paso.nombre, status: res.status, json, texto, location };
}

// ── Orquestador (I/O) ─────────────────────────────────────────────────────────

/**
 * Corre la secuencia de pasos de una funcion, pasando cookies y variables entre ellos, y
 * decide el estado. Best-effort: nunca lanza.
 *
 * - Si falta algun secret de `requiere_secrets` -> FUNCION_OMITIDA (no toca la red).
 * - Reintenta cada paso ante fallas transitorias (cold start / 5xx); corta en el primer paso
 *   que falla de verdad (no tiene sentido seguir si el login no anduvo).
 *
 * @param {object} funcion  bloque `funcion` del target
 * @param {{ fetchImpl?:Function, env?:object, sleep?:Function }} opciones
 * @returns {Promise<{estado:string, descripcion?:string, paso_fallo?:string, motivo?:string, duracion_ms?:number}>}
 */
export async function ejecutarFuncion(
  funcion,
  { fetchImpl = globalThis.fetch, env = {}, sleep: sleepImpl = sleep } = {},
) {
  const descripcion = funcion?.descripcion ?? null;

  // Secrets faltantes -> se omite (degradacion elegante, como email/Telegram opcionales).
  for (const nombre of funcion?.requiere_secrets ?? []) {
    if (!env[nombre]) {
      return { estado: 'FUNCION_OMITIDA', descripcion, motivo: `falta el secret ${nombre}` };
    }
  }

  const ctx = { env, vars: {}, cookies: {} };
  const evaluaciones = [];
  const inicio = performance.now();
  for (const paso of funcion?.pasos ?? []) {
    let r, e;
    // Reintenta con backoff solo si la falla es transitoria (cold start / blip / 5xx).
    for (const delay of DELAYS_FUNCION) {
      if (delay > 0) await sleepImpl(delay);
      r = await chequearPaso(paso, ctx, { fetchImpl });
      e = cumpleEspera(paso.espera, r);
      if (e.ok || !esTransitorio(r)) break; // exito, o falla REAL (no transitoria): no reintentar
    }
    evaluaciones.push({ nombre: paso.nombre, ok: e.ok, motivo: e.motivo });
    if (!e.ok) break; // un paso roto frena la cadena (ej. sin login no se puede consultar)
  }
  const duracion_ms = Math.round(performance.now() - inicio);

  const { estado, paso_fallo, motivo } = evaluarFuncion(evaluaciones);
  const out = { estado, descripcion, duracion_ms };
  if (paso_fallo) out.paso_fallo = paso_fallo;
  if (motivo) out.motivo = motivo;
  return out;
}
