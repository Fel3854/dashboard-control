# Dashboard de Control — Master Bus

Panel para ver de un vistazo si los proyectos del ecosistema Master Bus están **online y
sanos**. Un checker pinguea cada servicio cada 10 min (vía GitHub Actions), calcula
estado + latencia y escribe `public/status.json`; el panel estático (GitHub Pages) lo
muestra con semáforos 🟢🟡🔴.

> Fuente de verdad del diseño: [`DESIGN.md`](DESIGN.md). Esto es la **Fase 1**
> (checker + estado + panel). El email (Fase 2) y el heartbeat (Fase 3) todavía no están,
> pero el código ya está preparado para enchufarlos.

## Requisitos

- **Node.js 20+** (usa `fetch` nativo, `AbortSignal.timeout` y `node --test`). Sin dependencias.

## Estructura

```
dashboard-control/
├── checker/
│   ├── check.js        # lee proyectos.json, pinguea, escribe public/status.json
│   └── check.test.js   # tests de la logica de estado (fetch mockeado, sin red)
├── public/             # se publica en GitHub Pages
│   ├── index.html
│   ├── app.js          # fetch status.json + render + auto-refresh 60s
│   ├── styles.css      # branding Master Bus
│   └── status.json     # estado actual (lo escribe el checker)
├── proyectos.json          # QUE monitorear (completá las URLs)
├── proyectos.example.json  # demo (example.com OK + dominio inexistente CAIDO)
└── .github/workflows/check.yml  # cron */10 + commit status.json + deploy Pages
```

## Correr local

1. **Generar el status** (usa `proyectos.json` por defecto):

   ```bash
   node checker/check.js
   ```

   Para probar con la config de ejemplo (no necesita completar URLs):

   ```bash
   PROYECTOS_FILE=proyectos.example.json node checker/check.js
   ```

   Esto escribe `public/status.json`.

2. **Ver el panel.** Servílo con un server estático (NO lo abras con `file://`: Chrome
   bloquea el `fetch` de `status.json`):

   ```bash
   npx serve public
   # o:
   python3 -m http.server -d public 8000   # luego abrí http://localhost:8000
   ```

3. **Tests:**

   ```bash
   node --test
   ```

   Cubren OK / LENTO / CAÍDO / DESPERTANDO con `fetch` y `sleep` mockeados (sin red).

### Variables de entorno útiles

| Var | Default | Para qué |
|---|---|---|
| `PROYECTOS_FILE` | `proyectos.json` | Usar otra config (ej. la de ejemplo). |
| `STATUS_FILE` | `public/status.json` | Cambiar dónde se escribe el estado. |

## Completar `proyectos.json`

Reemplazá los placeholders `https://COMPLETAR-…` por las URLs reales. Mientras una URL
tenga `COMPLETAR`, el checker la **omite** (no la marca en rojo). Campos por target:

| Campo | Obligatorio | Notas |
|---|---|---|
| `nombre` | sí | Se muestra en el panel. |
| `tipo` | sí | `pull` (se chequea en Fase 1) o `heartbeat` (Fase 3, se omite por ahora). |
| `url` | si es `pull` | El endpoint a pinguear (idealmente un `GET /health`). |
| `plataforma` | sí | Etiqueta visible (Render, Vercel, etc.). |
| `tolera_cold_start` | no | `true` para Render/Cloud Run: habilita el estado `DESPERTANDO`. |
| `es_dependencia` | no | Marca informativa (ej. ERP del que dependen otros). |

> **Seguridad:** `status.json` **no** incluye las URLs — el panel nunca expone endpoints
> internos. Nunca commitees credenciales (las de Fase 2 van en GitHub Secrets).

## Lógica de estado (para no dar falsas alarmas)

Por cada target `pull`: GET con timeout de 10 s, **3 intentos con backoff** (0s, 2s, 5s)
antes de declarar caído. La función que decide es pura (`decidirEstado`) y testeable.

| Estado | Cuándo | Semáforo |
|---|---|---|
| `OK` | responde 2xx/3xx y latencia < 3 s | 🟢 |
| `LENTO` | responde pero supera 3 s | 🟡 |
| `DESPERTANDO` | falló el 1er intento pero respondió en un reintento, **solo** si `tolera_cold_start: true` (Render duerme ~15 min) | 🟡 |
| `CAÍDO` | no responde 2xx/3xx tras los 3 intentos | 🔴 |

Cada proyecto lleva un `desde` (desde cuándo está en ese estado), calculado comparando con
el `status.json` anterior.

## Desplegar en GitHub Pages

1. Subí el repo a GitHub.
2. **Settings → Pages → Source = "GitHub Actions"** (una sola vez).
3. El workflow [`check.yml`](.github/workflows/check.yml) corre solo cada 10 min (cron
   `*/10`), commitea `public/status.json` y publica `public/`. También podés correrlo
   manualmente desde la pestaña **Actions → Check & Deploy → Run workflow**
   (`workflow_dispatch`).

El cron de Actions tiene un mínimo de ~5 min y puede demorarse bajo carga; es aceptable
para este caso.

## Próximas fases (ya preparado, sin reescribir)

- **Fase 2 — Email.** `check.js` ya llama a `checker/notify.js` **después** de escribir
  `status.json` (si el archivo existe). Para activarlo: creá `checker/notify.js`
  exportando `notify({ nuevo, anterior, dryRun })` y mandá el mail solo en la transición
  `OK → CAÍDO`, con cooldown. SMTP en GitHub Secrets. Soporta `DRY_RUN=1` para probar sin
  enviar.
- **Fase 3 — Heartbeat.** Los targets `tipo: "heartbeat"` (ej. Rotación) hoy se omiten;
  se sumarán acá junto con el historial y el % de uptime.
