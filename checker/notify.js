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

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(__dirname, '..');

const COOLDOWN_HORAS_DEFAULT = 6; // recordatorio si sigue caido tras N horas
const PANEL_URL = process.env.PANEL_URL || 'https://fel3854.github.io/dashboard-control/';

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
  { ahora = Date.now(), cooldownMs = COOLDOWN_HORAS_DEFAULT * 3600_000 } = {},
) {
  const eventos = [];
  const mapa = { ...alertasEstado };
  const ahoraISO = new Date(ahora).toISOString();

  for (const p of nuevo?.proyectos ?? []) {
    const prev = anterior?.proyectos?.find((x) => x.nombre === p.nombre);
    const estadoPrev = prev?.estado;

    if (p.estado === 'CAIDO') {
      if (estadoPrev !== 'CAIDO') {
        // Nueva caida.
        eventos.push({ tipo: 'caida', proyecto: p });
        mapa[p.nombre] = ahoraISO;
      } else {
        // Sigue caido: ¿toca recordatorio?
        const ultima = mapa[p.nombre] ? Date.parse(mapa[p.nombre]) : 0;
        if (ahora - ultima >= cooldownMs) {
          eventos.push({ tipo: 'recordatorio', proyecto: p });
          mapa[p.nombre] = ahoraISO;
        }
        // si no llego al cooldown, se conserva mapa[p.nombre]
      }
    } else {
      // Ya no esta caido.
      if (estadoPrev === 'CAIDO' || mapa[p.nombre]) {
        eventos.push({ tipo: 'recuperado', proyecto: p });
      }
      delete mapa[p.nombre];
    }
  }

  return { eventos, alertasEstado: mapa };
}

// ── Armado del email ──────────────────────────────────────────────────────────

const ETIQUETA = {
  caida: '🔴 CAÍDO',
  recordatorio: '🔴 SIGUE CAÍDO',
  recuperado: '🟢 RECUPERADO',
};

/** Construye asunto + cuerpo (texto plano) a partir de los eventos. Pura. */
export function construirEmail(eventos) {
  const problemas = eventos.filter((e) => e.tipo !== 'recuperado').length;
  const recuperados = eventos.filter((e) => e.tipo === 'recuperado').length;

  const resumen = [];
  if (problemas) resumen.push(`🔴 ${problemas} caído/s`);
  if (recuperados) resumen.push(`🟢 ${recuperados} recuperado/s`);
  const asunto = `[Master Bus] ${resumen.join(' · ')}`;

  const lineas = ['Dashboard de Control — cambios detectados:', ''];
  for (const { tipo, proyecto: p } of eventos) {
    lineas.push(`${ETIQUETA[tipo]} — ${p.nombre} (${p.plataforma ?? '-'})`);
    lineas.push(
      `   http ${p.http_code ?? '-'} · ${p.latencia_ms ?? '-'} ms · desde ${p.desde}`,
    );
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
 * @param {{ nuevo: object, anterior: object|null, dryRun?: boolean }} ctx
 */
export async function notify({ nuevo, anterior, dryRun = false }) {
  const cooldownMs = Number(process.env.ALERTA_COOLDOWN_HORAS ?? COOLDOWN_HORAS_DEFAULT) * 3600_000;
  const alertasPath = resolve(RAIZ, 'alertas-estado.json');
  const alertasEstado = (await existe(alertasPath)) ? JSON.parse(await readFile(alertasPath, 'utf8')) : {};

  const { eventos, alertasEstado: mapaNuevo } = detectarEventos(nuevo, anterior, alertasEstado, {
    ahora: Date.now(),
    cooldownMs,
  });

  if (eventos.length === 0) {
    console.log('notify: sin cambios de estado para alertar.');
    return { eventos };
  }

  const { asunto, cuerpo } = construirEmail(eventos);

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
    console.log(`notify: alerta marcada para el workflow (${eventos.length} evento/s).`);
  } else {
    console.log(`notify: ${eventos.length} evento/s detectado/s (fuera de Actions, no se envia):\n${cuerpo}`);
  }

  return { eventos, asunto, cuerpo };
}
