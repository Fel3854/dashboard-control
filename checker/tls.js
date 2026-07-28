// checker/tls.js — Parte C: vencimiento del certificado TLS (aviso anticipado).
//
// Para targets `pull` con URL https, ademas del ping (que solo mira 2xx + latencia) se abre
// UNA conexion TLS y se lee la fecha de vencimiento del certificado del servidor. Asi el
// panel/alertas avisan ANTES de que un cert venza (un cert vencido tira el servicio entero,
// y suele pasar por olvido). Best-effort: si algo falla, `null` y NO rompe el checker.
//
// `diasParaVencer` es PURA e importable: se testea sin red (ver checker/tls.test.js).

import tls from 'node:tls';

const DIA_MS = 24 * 3600_000;

/**
 * Dias que faltan para que venza un certificado (negativo si ya vencio). Pura.
 *
 * @param {string} validoHasta  el `valid_to` del cert (ej. "Aug 10 12:00:00 2026 GMT")
 * @param {number} ahora        Date.now()
 * @returns {number|null}  dias enteros (redondeo hacia abajo) o null si la fecha no parsea
 */
export function diasParaVencer(validoHasta, ahora = Date.now()) {
  const ts = Date.parse(validoHasta);
  if (!Number.isFinite(ts)) return null;
  return Math.floor((ts - ahora) / DIA_MS);
}

/** Extrae el host de una URL https. Devuelve null si no es https o no parsea. */
export function hostHttps(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

/**
 * Abre una conexion TLS al host y devuelve la fecha de vencimiento del cert. Best-effort:
 * timeout o error -> null. Usa `rejectUnauthorized: false` a proposito: queremos LEER el cert
 * (incluso si esta por vencer) para MEDIR el vencimiento, no autenticar la cadena — de la
 * validez ya se encarga el ping via fetch.
 *
 * @returns {Promise<{valido_hasta:string, dias_para_vencer:number}|null>}
 */
export function obtenerCertificado(
  host,
  { port = 443, timeout = 5_000, ahora = Date.now(), connectImpl = tls.connect } = {},
) {
  return new Promise((resolve) => {
    let resuelto = false;
    const socket = connectImpl({ host, port, servername: host, rejectUnauthorized: false, timeout }, () => {
      if (resuelto) return;
      resuelto = true;
      const cert = socket.getPeerCertificate?.();
      let val = null;
      if (cert && cert.valid_to) {
        const dias = diasParaVencer(cert.valid_to, ahora);
        if (dias != null) val = { valido_hasta: cert.valid_to, dias_para_vencer: dias };
      }
      try { socket.end(); } catch { /* noop */ }
      resolve(val);
    });
    const fallar = () => {
      if (resuelto) return;
      resuelto = true;
      try { socket.destroy(); } catch { /* noop */ }
      resolve(null);
    };
    socket.on('timeout', fallar);
    socket.on('error', fallar);
  });
}
