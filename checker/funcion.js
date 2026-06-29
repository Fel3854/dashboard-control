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
// un request HTTP con una `espera` (aserciones). Los secretos se interpolan con `env:NOMBRE`
// y NUNCA viven en el repo. Sumar otro servicio = solo agregar su bloque `funcion`.

const TIMEOUT_MS = 10_000; // corte por request

// ── Interpolacion de secretos ─────────────────────────────────────────────────

/** "env:NOMBRE" -> env.NOMBRE ; cualquier otro valor se devuelve tal cual. */
export function interpolar(valor, env = {}) {
  if (typeof valor === 'string' && valor.startsWith('env:')) {
    return env[valor.slice(4)] ?? '';
  }
  return valor;
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
 *
 * @param {object} espera
 * @param {{status:number|null, json:object|null, texto:string|null, error?:string}} resultado
 * @returns {{ ok: boolean, motivo?: string }}
 */
export function cumpleEspera(espera = {}, resultado) {
  if (resultado?.error) return { ok: false, motivo: `error de red: ${resultado.error}` };

  if (espera.status != null) {
    const aceptados = Array.isArray(espera.status) ? espera.status : [espera.status];
    if (!aceptados.includes(resultado.status)) {
      return { ok: false, motivo: `status ${resultado.status ?? '-'} (esperaba ${aceptados.join('/')})` };
    }
  }

  if (espera.json_array_no_vacio) {
    if (!Array.isArray(resultado.json)) return { ok: false, motivo: 'la respuesta no es un array JSON' };
    if (resultado.json.length === 0) return { ok: false, motivo: 'el array JSON vino vacío' };
  }

  if (Array.isArray(espera.json_tiene) && espera.json_tiene.length > 0) {
    if (!resultado.json || typeof resultado.json !== 'object') {
      return { ok: false, motivo: 'la respuesta no es JSON' };
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
 * se devuelven como `{ error }`. Pasa/guarda la cookie de sesion via `ctx`.
 *
 * @param {object} paso  definicion del paso (url, metodo, cuerpo_form, guardar_cookie, usar_cookie)
 * @param {{env:object, cookie:string|null}} ctx  estado compartido entre pasos
 * @returns {Promise<{nombre:string, status:number|null, json:object|null, texto:string|null, error?:string}>}
 */
export async function chequearPaso(paso, ctx, { fetchImpl = globalThis.fetch } = {}) {
  const headers = {};
  const opciones = {
    method: paso.metodo || 'GET',
    headers,
    // Para capturar la cookie de login hay que ver el Set-Cookie del 302: no seguir el redirect.
    redirect: paso.guardar_cookie ? 'manual' : 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };

  if (paso.cuerpo_form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(paso.cuerpo_form)) params.set(k, interpolar(v, ctx.env));
    headers['content-type'] = 'application/x-www-form-urlencoded';
    opciones.body = params.toString();
  } else if (paso.cuerpo_json) {
    const obj = {};
    for (const [k, v] of Object.entries(paso.cuerpo_json)) obj[k] = interpolar(v, ctx.env);
    headers['content-type'] = 'application/json';
    opciones.body = JSON.stringify(obj);
  }

  if (paso.usar_cookie && ctx.cookie) headers['cookie'] = ctx.cookie;

  let res;
  try {
    res = await fetchImpl(paso.url, opciones);
  } catch (err) {
    return { nombre: paso.nombre, status: null, json: null, texto: null, error: String(err?.message ?? err) };
  }

  // Guardar la cookie pedida (ej. "token") para los pasos siguientes.
  if (paso.guardar_cookie && typeof res.headers?.getSetCookie === 'function') {
    const cookies = res.headers.getSetCookie();
    const buscada = cookies.find((c) => c.startsWith(`${paso.guardar_cookie}=`));
    if (buscada) ctx.cookie = buscada.split(';')[0]; // "token=eyJ..." (sin atributos)
  }

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

  return { nombre: paso.nombre, status: res.status, json, texto };
}

// ── Orquestador (I/O) ─────────────────────────────────────────────────────────

/**
 * Corre la secuencia de pasos de una funcion, pasando la cookie de sesion entre ellos, y
 * decide el estado. Best-effort: nunca lanza.
 *
 * - Si falta algun secret de `requiere_secrets` -> FUNCION_OMITIDA (no toca la red).
 * - Corta en el primer paso que falla (no tiene sentido seguir si el login no anduvo).
 *
 * @param {object} funcion  bloque `funcion` del target
 * @param {{ fetchImpl?:Function, env?:object }} opciones
 * @returns {Promise<{estado:string, descripcion?:string, paso_fallo?:string, motivo?:string, duracion_ms?:number}>}
 */
export async function ejecutarFuncion(funcion, { fetchImpl = globalThis.fetch, env = {} } = {}) {
  const descripcion = funcion?.descripcion ?? null;

  // Secrets faltantes -> se omite (degradacion elegante, como email/Telegram opcionales).
  for (const nombre of funcion?.requiere_secrets ?? []) {
    if (!env[nombre]) {
      return { estado: 'FUNCION_OMITIDA', descripcion, motivo: `falta el secret ${nombre}` };
    }
  }

  const ctx = { env, cookie: null };
  const evaluaciones = [];
  const inicio = performance.now();
  for (const paso of funcion?.pasos ?? []) {
    const r = await chequearPaso(paso, ctx, { fetchImpl });
    const e = cumpleEspera(paso.espera, r);
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
