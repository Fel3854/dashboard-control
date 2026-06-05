// public/app.js — panel estatico: lee status.json y dibuja los semaforos.
// Vanilla JS, sin build. Auto-refresh cada 60 s.

const REFRESH_MS = 60_000;

// Estado -> presentacion. (status.json no trae URLs internas: no se exponen.)
const ESTADOS = {
  OK: { emoji: '🟢', clase: 'ok', label: 'OK' },
  LENTO: { emoji: '🟡', clase: 'lento', label: 'LENTO' },
  DESPERTANDO: { emoji: '🟡', clase: 'despertando', label: 'DESPERTANDO' },
  CAIDO: { emoji: '🔴', clase: 'caido', label: 'CAIDO' },
};

const $ = (sel) => document.querySelector(sel);

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

function filaHTML(p) {
  const info = ESTADOS[p.estado] ?? { emoji: '⚪', clase: '', label: p.estado || '?' };
  const esCaido = p.estado === 'CAIDO';
  const latencia = esCaido || p.latencia_ms == null ? '— ms' : `${p.latencia_ms} ms`;

  // "desde" se muestra cuando el estado no es OK (caido/lento/despertando desde ...).
  let lineaDesde = '';
  if (p.estado !== 'OK' && p.desde) {
    const verbo = esCaido ? 'caído' : p.estado === 'LENTO' ? 'lento' : 'despertando';
    lineaDesde = `<div class="desde">${verbo} ${hace(p.desde)}</div>`;
  }

  return `
    <div class="fila ${info.clase}" role="listitem">
      <span class="semaforo" aria-hidden="true">${info.emoji}</span>
      <div class="info">
        <div class="nombre">${escapar(p.nombre)}</div>
        <div class="plataforma">${escapar(p.plataforma ?? '')}</div>
        ${lineaDesde}
      </div>
      <div class="metricas">
        <span class="estado-label ${info.clase}">${info.label}</span>
        <span class="latencia">${latencia}</span>
      </div>
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
  if (caidos > 0) return `🔴 ${caidos} caído/s`;
  if (n('LENTO') + n('DESPERTANDO') > 0) return `🟡 ${n('LENTO') + n('DESPERTANDO')} con avisos`;
  if (proyectos.length > 0) return '🟢 Todo OK';
  return '';
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
  panel.innerHTML = proyectos.map(filaHTML).join('');
}

async function cargar() {
  const error = $('#mensaje-error');
  try {
    const res = await fetch('status.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    error.hidden = true;
    render(data);
  } catch (err) {
    error.hidden = false;
    error.textContent = `No se pudo cargar status.json (${err.message}). ¿Ya corriste el checker?`;
  }
}

cargar();
setInterval(cargar, REFRESH_MS);
