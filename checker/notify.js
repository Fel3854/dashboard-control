// checker/notify.js — Fase 2: alertas por email en transiciones de estado.
//
// Se llama AUTOMATICAMENTE desde checker/check.js despues de escribir status.json
// (hook ya presente en Fase 1). No envia el email directamente: sin dependencias
// (no nodemailer), la DECISION vive aca y el ENVIO lo hace un step del workflow con
// `dawidd6/action-send-mail` (ver .github/workflows/check.yml y DESIGN.md).
//
// notify() detecta las transiciones relevantes, aplica el cooldown anti-spam, persiste
// el estado en `alertas-estado.json` y, cuando corre dentro de GitHub Actions, marca el
// output `alerta=true` + `asunto` y vuelca el cuerpo a `alerta-cuerpo.txt` para que el
// step de email lo consuma.
//
// La logica que DECIDE (`detectarEventos`) es PURA e importable: se testea sin red ni I/O.

import { readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { esFlapping } from './historial.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(__dirname, '..');

const COOLDOWN_HORAS_DEFAULT = 6; // recordatorio si sigue caido tras N horas
const PANEL_URL = process.env.PANEL_URL || 'https://fel3854.github.io/dashboard-control/';

// Avisos "blandos" (no son caidas): umbral + cooldown propios para no spamear.
const UMBRAL_CERT_DIAS_DEFAULT = 21; // avisar si al cert le quedan <= N dias
const COOLDOWN_CERT_HORAS = 24; // como mucho un aviso de cert por dia
const UMBRAL_LENTO_SOSTENIDO_MS = 45 * 60_000; // LENTO continuo >= 45 min = sostenido
const COOLDOWN_LENTO_HORAS = 12; // como mucho un aviso de lento sostenido cada 12 h

// Alertas avanzadas.
const COOLDOWN_CRITICO_MIN = 30; // recordatorio cada 30 min para servicios criticos (vs 6 h)
const UMBRAL_ESCALAR_HORAS = 1; // critico caido continuo > 1 h -> escalamiento
const VENTANA_FLAP_MIN = 60; // ventana para contar rebotes de estado
const MAX_FLAP_TRANSICIONES = 4; // >= N transiciones en la ventana = inestable (flapping)
const COOLDOWN_FLAP_HORAS = 12; // un solo aviso de "inestable" cada N h

// ── Deteccion de eventos (PURA — el corazon testeable) ────────────────────────

/**
 * Compara el status nuevo vs el anterior (+ registro de alertas para el cooldown) y
 * devuelve los eventos a notificar y el nuevo registro de alertas.
 *
 * Eventos:
 *  - 'caida'       : el proyecto paso a CAIDO (no lo estaba antes).
 *  - 'recordatorio': sigue CAIDO y pasaron >= cooldown desde la ultima alerta.
 *  - 'recuperado'  : estaba CAIDO y volvio a responder.
 *
 * `alertasEstado` es un mapa { [nombre]: ISO de la ultima alerta }.
 *
 * @returns {{ eventos: Array<{tipo:string, proyecto:object}>, alertasEstado: object }}
 */
export function detectarEventos(
  nuevo,
  anterior,
  alertasEstado = {},
  {
    ahora = Date.now(),
    cooldownMs = COOLDOWN_HORAS_DEFAULT * 3600_000,
    cooldownCriticoMs = COOLDOWN_CRITICO_MIN * 60_000,
    umbralEscalarMs = UMBRAL_ESCALAR_HORAS * 3600_000,
    umbralCertDias = UMBRAL_CERT_DIAS_DEFAULT,
    cooldownCertMs = COOLDOWN_CERT_HORAS * 3600_000,
    umbralLentoMs = UMBRAL_LENTO_SOSTENIDO_MS,
    cooldownLentoMs = COOLDOWN_LENTO_HORAS * 3600_000,
    cooldownFlapMs = COOLDOWN_FLAP_HORAS * 3600_000,
    history = null,
  } = {},
) {
  const eventos = [];
  const mapa = { ...alertasEstado };
  const ahoraISO = new Date(ahora).toISOString();

  for (const p of nuevo?.proyectos ?? []) {
    // Ventana de mantenimiento: el estado se registra igual (check.js), pero NO se alerta.
    if (p.mantenimiento) continue;

    const prev = anterior?.proyectos?.find((x) => x.nombre === p.nombre);
    const estadoPrev = prev?.estado;
    const critico = Boolean(p.critico);

    // ── Flapping: si el proyecto rebota de estado muchas veces en poco tiempo, no spamear un
    //    evento por cada rebote: un solo aviso de "inestable" (cooldown largo) y saltar la
    //    logica de caida/recuperado/lento (el ping-state no es confiable mientras flapea).
    const claveFlap = `flapping:${p.nombre}`;
    const flap = history
      ? esFlapping(history.eventos?.filter((e) => e.nombre === p.nombre), {
          ahora,
          ventanaMin: VENTANA_FLAP_MIN,
          maxTransiciones: MAX_FLAP_TRANSICIONES,
        })
      : false;

    if (flap) {
      const ultima = mapa[claveFlap] ? Date.parse(mapa[claveFlap]) : 0;
      if (ahora - ultima >= cooldownFlapMs) {
        eventos.push({ tipo: 'flapping', proyecto: p });
        mapa[claveFlap] = ahoraISO;
      }
    } else {
      delete mapa[claveFlap];

      // ── Ping-state: caida / recordatorio / escalamiento / recuperado ──────────
      if (p.estado === 'CAIDO') {
        if (estadoPrev !== 'CAIDO') {
          // Nueva caida.
          eventos.push({ tipo: 'caida', proyecto: p });
          mapa[p.nombre] = ahoraISO;
        } else {
          // Sigue caido: recordatorio con cooldown segun criticidad; si es un servicio critico
          // y lleva mucho caido, escala a un aviso mas urgente.
          const cd = critico ? cooldownCriticoMs : cooldownMs;
          const ultima = mapa[p.nombre] ? Date.parse(mapa[p.nombre]) : 0;
          if (ahora - ultima >= cd) {
            const downMs = p.desde ? ahora - Date.parse(p.desde) : 0;
            const tipo = critico && downMs >= umbralEscalarMs ? 'escalado' : 'recordatorio';
            eventos.push({ tipo, proyecto: p });
            mapa[p.nombre] = ahoraISO;
          }
        }
      } else {
        // Ya no esta caido.
        if (estadoPrev === 'CAIDO' || mapa[p.nombre]) {
          eventos.push({ tipo: 'recuperado', proyecto: p });
        }
        delete mapa[p.nombre];
      }

      // ── Latencia alta SOSTENIDA (aviso, no caida). Reusa p.desde. ──────────────
      const claveL = `lento:${p.nombre}`;
      if (p.estado === 'LENTO') {
        const desdeMs = p.desde ? Date.parse(p.desde) : NaN;
        const continuo = Number.isFinite(desdeMs) ? ahora - desdeMs : 0;
        if (continuo >= umbralLentoMs) {
          const ultima = mapa[claveL] ? Date.parse(mapa[claveL]) : 0;
          if (ahora - ultima >= cooldownLentoMs) {
            eventos.push({ tipo: 'lento_sostenido', proyecto: p });
            mapa[claveL] = ahoraISO;
          }
        }
      } else {
        delete mapa[claveL];
      }
    }

    // ── Sub-estado FUNCIONAL: alerta aunque el PING este en verde ──────────────
    // El chequeo funcional (check.js -> funcion.js) puede fallar con el servidor
    // respondiendo 200. Se trata con la misma logica de caida/recordatorio/recuperado,
    // pero con clave propia ("funcion:<nombre>") para no pisar el cooldown del servicio.
    // FUNCION_OMITIDA / sin funcion se ignoran (no hay senal que alertar).
    const estadoF = p.funcion?.estado;
    if (estadoF === 'FUNCION_FALLA' || estadoF === 'FUNCION_OK') {
      const claveF = `funcion:${p.nombre}`;
      const estadoFPrev = prev?.funcion?.estado;
      if (estadoF === 'FUNCION_FALLA') {
        if (estadoFPrev !== 'FUNCION_FALLA') {
          eventos.push({ tipo: 'funcion_caida', proyecto: p });
          mapa[claveF] = ahoraISO;
        } else {
          const cd = critico ? cooldownCriticoMs : cooldownMs;
          const ultima = mapa[claveF] ? Date.parse(mapa[claveF]) : 0;
          if (ahora - ultima >= cd) {
            eventos.push({ tipo: 'funcion_recordatorio', proyecto: p });
            mapa[claveF] = ahoraISO;
          }
        }
      } else {
        // FUNCION_OK: si venia fallando, avisar recuperacion y limpiar el registro.
        if (estadoFPrev === 'FUNCION_FALLA' || mapa[claveF]) {
          eventos.push({ tipo: 'funcion_recuperada', proyecto: p });
        }
        delete mapa[claveF];
      }
    }

    // ── Vencimiento de certificado TLS: avisa ANTES de que caduque ──────────────
    // No es una transicion: se dispara mientras al cert le queden <= umbral dias, con
    // cooldown diario para no repetir. Al renovarse (dias > umbral) se limpia el registro.
    const diasCert = p.tls?.dias_para_vencer;
    const claveC = `cert:${p.nombre}`;
    if (typeof diasCert === 'number' && diasCert <= umbralCertDias) {
      const ultima = mapa[claveC] ? Date.parse(mapa[claveC]) : 0;
      if (ahora - ultima >= cooldownCertMs) {
        eventos.push({ tipo: 'cert_por_vencer', proyecto: p });
        mapa[claveC] = ahoraISO;
      }
    } else if (typeof diasCert === 'number') {
      delete mapa[claveC];
    }

  }

  // Severidad de cada evento (para el asunto y el escalamiento): CRITICO solo si el servicio
  // esta marcado critico y es una caida (ping o funcion); recuperados = INFO; el resto = AVISO.
  for (const e of eventos) e.severidad = severidadEvento(e.tipo, e.proyecto);

  return { eventos, alertasEstado: mapa };
}

// ── Armado del email ──────────────────────────────────────────────────────────

const ETIQUETA = {
  caida: '🔴 CAÍDO',
  recordatorio: '🔴 SIGUE CAÍDO',
  recuperado: '🟢 RECUPERADO',
  funcion_caida: '🔴 FUNCIÓN FALLA',
  funcion_recordatorio: '🔴 FUNCIÓN SIGUE FALLANDO',
  funcion_recuperada: '🟢 FUNCIÓN OK',
  cert_por_vencer: '🟡 CERT POR VENCER',
  lento_sostenido: '🟡 LENTO SOSTENIDO',
  escalado: '🚨 ESCALAMIENTO (sigue caído)',
  flapping: '🟡 INESTABLE (flapping)',
};

const TIPOS_FUNCION = new Set(['funcion_caida', 'funcion_recordatorio', 'funcion_recuperada']);
const TIPOS_RECUPERADO = new Set(['recuperado', 'funcion_recuperada']);
const TIPOS_AVISO = new Set(['cert_por_vencer', 'lento_sostenido', 'flapping']);
// Tipos que representan una caida (ping o funcion) para clasificar severidad.
const TIPOS_CAIDA = new Set(['caida', 'recordatorio', 'escalado', 'funcion_caida', 'funcion_recordatorio']);

/**
 * Severidad de un evento. CRITICO solo si el servicio esta marcado `critico` y el evento es
 * una caida (ping o funcion); recuperados = INFO; el resto (cert, lento, flapping, caidas de
 * servicios no criticos) = AVISO. Pura.
 */
export function severidadEvento(tipo, proyecto) {
  if (TIPOS_RECUPERADO.has(tipo)) return 'INFO';
  if (TIPOS_CAIDA.has(tipo)) return proyecto?.critico ? 'CRITICO' : 'AVISO';
  return 'AVISO';
}

/** Construye asunto + cuerpo (texto plano) a partir de los eventos. Pura. */
export function construirEmail(eventos) {
  const caidos = eventos.filter(
    (e) => e.tipo === 'caida' || e.tipo === 'recordatorio' || e.tipo === 'escalado',
  ).length;
  const funcionesFallando = eventos.filter(
    (e) => e.tipo === 'funcion_caida' || e.tipo === 'funcion_recordatorio',
  ).length;
  const recuperados = eventos.filter((e) => TIPOS_RECUPERADO.has(e.tipo)).length;
  const avisos = eventos.filter((e) => TIPOS_AVISO.has(e.tipo)).length;

  const resumen = [];
  if (caidos) resumen.push(`🔴 ${caidos} caído/s`);
  if (funcionesFallando) resumen.push(`🔴 ${funcionesFallando} función/es fallando`);
  if (avisos) resumen.push(`🟡 ${avisos} aviso/s`);
  if (recuperados) resumen.push(`🟢 ${recuperados} recuperado/s`);

  // Prefijo segun severidad maxima: un critico caido escala el asunto (para triage rapido).
  const hayCritico = eventos.some((e) => (e.severidad ?? severidadEvento(e.tipo, e.proyecto)) === 'CRITICO');
  const prefijo = hayCritico ? '[Master Bus][🚨 CRÍTICO]' : '[Master Bus]';
  const asunto = `${prefijo} ${resumen.join(' · ')}`;

  const lineas = ['Dashboard de Control — cambios detectados:', ''];
  for (const { tipo, proyecto: p } of eventos) {
    lineas.push(`${ETIQUETA[tipo]} — ${p.nombre} (${p.plataforma ?? '-'})`);
    if (TIPOS_FUNCION.has(tipo)) {
      const f = p.funcion ?? {};
      if (tipo === 'funcion_recuperada') {
        lineas.push(`   función «${f.descripcion ?? '-'}» volvió a responder · desde ${f.desde ?? '-'}`);
      } else {
        lineas.push(
          `   función «${f.descripcion ?? '-'}» · falló en "${f.paso_fallo ?? '-'}": ${f.motivo ?? '-'} · desde ${f.desde ?? '-'}`,
        );
      }
    } else if (tipo === 'cert_por_vencer') {
      lineas.push(`   el certificado TLS vence en ${p.tls?.dias_para_vencer ?? '-'} día/s (${p.tls?.valido_hasta ?? '-'})`);
    } else if (tipo === 'lento_sostenido') {
      lineas.push(`   responde pero lento: ${p.latencia_ms ?? '-'} ms · sostenido desde ${p.desde}`);
    } else if (tipo === 'flapping') {
      lineas.push(`   cambia de estado muy seguido (inestable) · último: ${p.estado}`);
    } else {
      lineas.push(`   http ${p.http_code ?? '-'} · ${p.latencia_ms ?? '-'} ms · desde ${p.desde}`);
    }
  }
  lineas.push('', `Panel: ${PANEL_URL}`);

  return { asunto, cuerpo: lineas.join('\n') };
}

// ── I/O helpers ───────────────────────────────────────────────────────────────

async function existe(ruta) {
  try {
    await access(ruta);
    return true;
  } catch {
    return false;
  }
}

// ── notify (wrapper con I/O) ──────────────────────────────────────────────────

/**
 * Punto de entrada que llama check.js. Detecta eventos, aplica cooldown, persiste el
 * registro y le indica al workflow que envie el email. NO envia SMTP por su cuenta.
 *
 * @param {{ nuevo: object, anterior: object|null, history?: object, dryRun?: boolean }} ctx
 */
export async function notify({ nuevo, anterior, history = null, dryRun = false }) {
  // ── Modo TEST: fuerza una alerta de prueba para verificar los canales ────────
  // Se dispara con TEST_ALERTA=1 (lo setea el workflow al correrlo a mano con el input
  // "test_alerta"). Manda email/Telegram sin esperar a una caida real, y NO persiste nada.
  if (process.env.TEST_ALERTA === '1') {
    const asunto = '[Master Bus] 🧪 Prueba de alertas';
    const cuerpo = [
      'Mensaje de PRUEBA del Dashboard de Control.',
      'Si lo recibís, el canal de alertas está funcionando. ✅',
      '',
      `Panel: ${PANEL_URL}`,
    ].join('\n');
    const out = process.env.GITHUB_OUTPUT;
    if (out) {
      await writeFile(resolve(RAIZ, 'alerta-cuerpo.txt'), cuerpo, 'utf8');
      await appendFile(out, `alerta=true\n`);
      await appendFile(out, `asunto=${asunto}\n`);
      console.log('notify: TEST_ALERTA activo → alerta de prueba marcada para email/Telegram.');
    } else {
      console.log(`notify (TEST_ALERTA, fuera de Actions):\n  ${asunto}\n${cuerpo}`);
    }
    return { eventos: [{ tipo: 'test' }], asunto, cuerpo, test: true };
  }

  const cooldownMs = Number(process.env.ALERTA_COOLDOWN_HORAS ?? COOLDOWN_HORAS_DEFAULT) * 3600_000;
  const umbralCertDias = Number(process.env.CERT_AVISO_DIAS ?? UMBRAL_CERT_DIAS_DEFAULT);
  const alertasPath = resolve(RAIZ, 'alertas-estado.json');
  const alertasEstado = (await existe(alertasPath)) ? JSON.parse(await readFile(alertasPath, 'utf8')) : {};

  const { eventos, alertasEstado: mapaNuevo } = detectarEventos(nuevo, anterior, alertasEstado, {
    ahora: Date.now(),
    cooldownMs,
    umbralCertDias,
    history,
  });

  if (eventos.length === 0) {
    console.log('notify: sin cambios de estado para alertar.');
    return { eventos };
  }

  const { asunto, cuerpo } = construirEmail(eventos);
  // Severidad maxima del lote (para que el workflow pueda enrutar criticos a destinatarios extra).
  const severidad = eventos.some((e) => e.severidad === 'CRITICO')
    ? 'CRITICO'
    : eventos.some((e) => e.severidad && e.severidad !== 'INFO')
      ? 'AVISO'
      : 'INFO';

  if (dryRun) {
    console.log(`notify (DRY_RUN — no se envia, no se persiste):\n  asunto: ${asunto}\n${cuerpo}`);
    return { eventos, asunto, cuerpo };
  }

  // Persistir el registro de alertas para el cooldown de la proxima corrida.
  await writeFile(alertasPath, JSON.stringify(mapaNuevo, null, 2) + '\n', 'utf8');

  // Dentro de GitHub Actions: pasarle el envio al step de email.
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    await writeFile(resolve(RAIZ, 'alerta-cuerpo.txt'), cuerpo, 'utf8');
    await appendFile(out, `alerta=true\n`);
    await appendFile(out, `asunto=${asunto.replace(/\r?\n/g, ' ')}\n`);
    await appendFile(out, `severidad=${severidad}\n`);
    console.log(`notify: alerta marcada para el workflow (${eventos.length} evento/s, severidad ${severidad}).`);
  } else {
    console.log(`notify: ${eventos.length} evento/s detectado/s (fuera de Actions, no se envia):\n${cuerpo}`);
  }

  return { eventos, asunto, cuerpo, severidad };
}
