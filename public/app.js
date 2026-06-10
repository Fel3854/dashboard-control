// public/app.js — panel estatico: lee status.json (+ history.json) y dibuja los semaforos.
// Vanilla JS, sin build. Auto-refresh cada 60 s. Cada fila se expande al click y muestra
// el detalle del proyecto (uptime 7/30/90 d + ultimos cambios de estado).

const REFRESH_MS = 60_000;

// Repo para el boton "Forzar chequeo" (abre la pagina de Actions: un panel estatico
// publico no puede guardar un token de escritura, asi que el disparo es manual desde ahi).
const REPO = 'Fel3854/dashboard-control';
const WORKFLOW = 'check.yml';
const ACTIONS_URL = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`;

// Estado -> presentacion. (status.json no trae URLs internas: no se exponen.)
const ESTADOS = {
  OK: { emoji: '🟢', clase: 'ok', label: 'OK' },
  LENTO: { emoji: '🟡', clase: 'lento', label: 'LENTO' },
  DESPERTANDO: { emoji: '🟡', clase: 'despertando', label: 'DESPERTANDO' },
  CAIDO: { emoji: '🔴', clase: 'caido', label: 'CAIDO' },
  INACTIVO: { emoji: '⚪', clase: 'inactivo', label: 'INACTIVO' },
  SIN_DATOS: { emoji: '⚪', clase: 'sindatos', label: 'SIN DATOS' },
};

const $ = (sel) => document.querySelector(sel);

// Filas abiertas (por nombre): se preserva entre auto-refrescos para no colapsarlas.
const abiertos = new Set();
let ultimoData = null; // ultimo status.json renderizado (para re-render al togglear)
let historial = { eventos: [] }; // history.json (best-effort)

/** Formatea una fecha ISO como tiempo relativo ("hace 3 min"). */
function hace(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const seg = Math.round(ms / 1000);
  if (seg < 60) return 'hace instantes';
  const min = Math.round(seg / 60);
  if (min < 60) return `hace ${min} min`;
  const hs = Math.round(min / 60);
  if (hs < 24) return `hace ${hs} h`;
  const dias = Math.round(hs / 24);
  return `hace ${dias} d`;
}

/** Fecha ISO -> hora local legible. */
function horaLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

const VERBO = { CAIDO: 'caído', LENTO: 'lento', DESPERTANDO: 'despertando', INACTIVO: 'inactivo', SIN_DATOS: 'sin datos' };

/** "98.5%" o "—" si no hay dato. */
function fmtUptime(v) {
  return v == null ? '—' : `${v}%`;
}

/** Detalle expandible de un proyecto: uptimes por ventana + ultimos cambios de estado. */
function detalleHTML(p) {
  const u = p.uptimes ?? {};
  const filasUp = [7, 30, 90]
    .map((d) => `<span class="up-item">${d}d <b>${fmtUptime(u[d])}</b></span>`)
    .join('');

  // Datos actuales segun tipo.
  const datos = [];
  if (p.tipo === 'heartbeat') {
    datos.push(['Última corrida', p.ultima_corrida ? `${horaLocal(p.ultima_corrida)} (${hace(p.ultima_corrida)})` : 'sin reportes']);
  } else {
    datos.push(['Latencia', p.latencia_ms != null ? `${p.latencia_ms} ms` : '—']);
    datos.push(['HTTP', p.http_code != null ? p.http_code : '—']);
  }
  datos.push(['Plataforma', p.plataforma ?? '—']);
  datos.push(['En este estado desde', p.desde ? `${horaLocal(p.desde)} (${hace(p.desde)})` : '—']);
  const datosHTML = datos
    .map(([k, v]) => `<div class="dato"><span class="k">${escapar(k)}</span><span class="v">${escapar(String(v))}</span></div>`)
    .join('');

  // Timeline: ultimos cambios de estado de este proyecto (history.json), mas reciente primero.
  const eventos = (historial.eventos ?? [])
    .filter((e) => e.nombre === p.nombre)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 6);
  let timeline;
  if (eventos.length === 0) {
    timeline = '<div class="vacio-mini">Sin cambios registrados todavía.</div>';
  } else {
    timeline = `<ul class="timeline">${eventos
      .map((e) => {
        const info = ESTADOS[e.estado] ?? { emoji: '⚪', label: e.estado };
        return `<li><span class="tl-emoji">${info.emoji}</span><span class="tl-estado">${escapar(info.label)}</span><span class="tl-fecha">${horaLocal(e.timestamp)} · ${hace(e.timestamp)}</span></li>`;
      })
      .join('')}</ul>`;
  }

  return `
    <div class="detalle" id="detalle-${escapar(slugId(p.nombre))}">
      <div class="detalle-uptimes"><span class="up-label">uptime</span>${filasUp}</div>
      <div class="detalle-datos">${datosHTML}</div>
      <div class="detalle-historial">
        <div class="detalle-titulo">Últimos cambios de estado</div>
        ${timeline}
      </div>
    </div>`;
}

/** Slug simple para usar en id de DOM. */
function slugId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function filaHTML(p, ventanaDias) {
  const info = ESTADOS[p.estado] ?? { emoji: '⚪', clase: '', label: p.estado || '?' };
  const esHeartbeat = p.tipo === 'heartbeat';
  const abierto = abiertos.has(p.nombre);

  // Metrica principal: latencia (pull) o "ultima corrida" (heartbeat).
  let metrica;
  if (esHeartbeat) {
    metrica = p.ultima_corrida ? `corrió ${hace(p.ultima_corrida)}` : 'sin reportes';
  } else {
    metrica = p.estado === 'CAIDO' || p.latencia_ms == null ? '— ms' : `${p.latencia_ms} ms`;
  }

  const uptime = p.uptime != null ? `<span class="uptime">uptime ${p.uptime}% · ${ventanaDias}d</span>` : '';

  // "desde" cuando el estado no es OK (caído/lento/inactivo… desde ...). Rojo solo si CAIDO.
  let lineaDesde = '';
  if (p.estado !== 'OK' && p.desde) {
    lineaDesde = `<div class="desde ${info.clase}">${VERBO[p.estado] ?? p.estado} ${hace(p.desde)}</div>`;
  }

  const idDetalle = `detalle-${slugId(p.nombre)}`;
  return `
    <div class="item ${info.clase} ${abierto ? 'abierto' : ''}" role="listitem">
      <button class="fila" type="button" aria-expanded="${abierto}" aria-controls="${idDetalle}" data-nombre="${escapar(p.nombre)}">
        <span class="semaforo" aria-hidden="true">${info.emoji}</span>
        <div class="info">
          <div class="nombre">${escapar(p.nombre)}</div>
          <div class="plataforma">${escapar(p.plataforma ?? '')}${esHeartbeat ? ' · heartbeat' : ''}</div>
          ${lineaDesde}
        </div>
        <div class="metricas">
          <span class="estado-label ${info.clase}">${info.label}</span>
          <span class="latencia">${metrica}</span>
          ${uptime}
        </div>
        <span class="chevron" aria-hidden="true">${abierto ? '▾' : '▸'}</span>
      </button>
      ${detalleHTML(p)}
    </div>`;
}

function escapar(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function resumen(proyectos) {
  const n = (e) => proyectos.filter((p) => p.estado === e).length;
  const caidos = n('CAIDO');
  const avisos = n('LENTO') + n('DESPERTANDO');
  const neutros = n('INACTIVO') + n('SIN_DATOS');

  const partes = [];
  if (caidos > 0) partes.push(`🔴 ${caidos} caído/s`);
  if (avisos > 0) partes.push(`🟡 ${avisos} con avisos`);
  if (neutros > 0) partes.push(`⚪ ${neutros} inactivo/s`);
  if (partes.length === 0) return proyectos.length > 0 ? '🟢 Todo OK' : '';
  return partes.join(' · ');
}

function render(data) {
  const panel = $('#panel');
  const proyectos = data.proyectos ?? [];

  $('#ultimo-check').textContent = `Último check: ${horaLocal(data.timestamp)} (${hace(data.timestamp)})`;
  $('#resumen').textContent = resumen(proyectos);

  if (proyectos.length === 0) {
    panel.innerHTML = '<div class="vacio">No hay proyectos monitoreados todavía. Completá <code>proyectos.json</code>.</div>';
    return;
  }
  const ventanaDias = data.uptime_ventana_dias ?? 30;
  panel.innerHTML = proyectos.map((p) => filaHTML(p, ventanaDias)).join('');
}

/** Abre/cierra una fila y re-renderiza preservando el resto. */
function toggle(nombre) {
  if (abiertos.has(nombre)) abiertos.delete(nombre);
  else abiertos.add(nombre);
  if (ultimoData) render(ultimoData);
}

async function cargar() {
  const error = $('#mensaje-error');
  try {
    // Historial: best-effort (no rompe el panel si falta).
    fetch('history.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => { if (h && Array.isArray(h.eventos)) historial = h; })
      .catch(() => {});

    const res = await fetch('status.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    ultimoData = data;
    error.hidden = true;
    render(data);
  } catch (err) {
    error.hidden = false;
    error.textContent = `No se pudo cargar status.json (${err.message}). ¿Ya corriste el checker?`;
  }
}

// Click en una fila -> toggle del detalle (delegacion: el panel se re-renderiza seguido).
$('#panel').addEventListener('click', (ev) => {
  const fila = ev.target.closest('.fila');
  if (fila && fila.dataset.nombre) toggle(fila.dataset.nombre);
});

// Boton "Forzar chequeo": abre la pagina de Actions para correr el workflow manualmente.
const btnCheck = $('#check-now');
if (btnCheck) btnCheck.href = ACTIONS_URL;

cargar();
setInterval(cargar, REFRESH_MS);
