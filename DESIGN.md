# Dashboard de Control de Proyectos — Diseño

> Generado en el "kickoff" desde la bóveda de memoria (`Documents/boveda claude`).
> Patrones reutilizados citados como **«Concepto» (bóveda)**.

## Resumen

Panel de control central para ver de un vistazo si **todos los proyectos del ecosistema Master Bus están online y sanos**. Chequea periódicamente cada proyecto (y el ERP del que dependen), muestra un semáforo verde/rojo con latencia y "última caída", y **avisa por email** cuando algo se cae.

## Usuarios

- **Vos / equipo de desarrollo:** entrás al panel, mirás el estado general y, si algo está en rojo, sabés qué proyecto y desde cuándo.

## Qué se monitorea (y cómo) — heterogéneo a propósito

| Proyecto | Deploy | Chequeo | Nota |
|---|---|---|---|
| Consultas BD Mantenimiento | Render | `GET /health` + `/api/flota` | Render **duerme ~15 min** → reintentos, no marcar caído en cold start |
| Controles Stock Telegram | Cloud Run | `GET` (solo ping) | **depende del ERP** (lo consulta por detrás); cold start posible |
| ~~Sistema Compras~~ | Railway | — | **Retirado (2026-07):** salió del ecosistema, ya no se monitorea |
| Sistema Cubiertas | Vercel | `GET /` (home/login) | serverless |
| **ERP Masterbus** (dependencia) | MySQL + web | `GET` a `mantenimiento.masterbus.net` | punto único de falla de 3 proyectos |
| Rotación | Streamlit **local** | *heartbeat* (Fase 3) | no pingueable: reporta "última corrida" |

**Dos modelos de chequeo:**
- **Pull** (el monitor pinguea una URL) → para los servicios web.
- **Push / heartbeat** (el proceso avisa "corrí OK") → para batch/local como Rotación.

**Dependencias conocidas:** el **bot de Controles Stock consulta el ERP Masterbus** por detrás
(cadena real: usuario en Telegram → bot en Cloud Run → ERP/MySQL). Hoy el bot se monitorea **solo con
ping**, así que si responde `200` pero su integración con el ERP está rota (credenciales, esquema,
conexión), el panel **no lo detecta** — es un punto ciego. *Mitigación parcial:* el ERP tiene chequeo
funcional propio y está marcado crítico, así que una caída **total** del ERP sí alerta. *Pendiente:* un
chequeo funcional read-only en el bot que ejercite una consulta al ERP (ver GUIA.md → «Chequeo funcional»).

## Stack tecnológico (100% gratuito)

| Capa | Tecnología | Hosting |
|---|---|---|
| Checker (cron) | Script Node.js (`fetch` con reintentos) | **GitHub Actions** (cron `*/10`) |
| Estado / historial | `status.json` + `history.json` commiteados al repo | Repo Git (sin BD) |
| Frontend | HTML + CSS + JS, una página | **GitHub Pages** |
| Alertas | Email SMTP (solo en transición OK→caído) | Step del Action (`dawidd6/action-send-mail`) |
| Config | `proyectos.json` (lista de targets) | Repo |

## Estructura del proyecto

```
dashboard-control/
├── .github/workflows/check.yml   # cron */10 → corre el checker + alerta
├── checker/
│   ├── check.js                  # pinguea cada target, arma status.json
│   └── notify.js                 # email en transición OK→DOWN (con cooldown)
├── public/                       # → GitHub Pages
│   ├── index.html                # el panel (semáforo + tabla)
│   ├── app.js                    # fetch status.json + render
│   └── styles.css                # tokens de branding Master Bus
├── proyectos.json                # qué monitorear
├── status.json                   # estado actual (lo escribe el Action)
├── history.json                  # historial de incidentes (append)
└── DESIGN.md
```

### `proyectos.json` (ejemplo)

```json
[
  { "nombre": "Sistema Cubiertas", "tipo": "pull", "url": "https://<cubiertas>.vercel.app/", "plataforma": "Vercel" },
  { "nombre": "Consultas BD Mantenimiento", "tipo": "pull", "url": "https://<backend>.onrender.com/health", "plataforma": "Render", "tolera_cold_start": true },
  { "nombre": "Controles Stock Telegram", "tipo": "pull", "url": "https://<service>.run.app/health", "plataforma": "Cloud Run", "tolera_cold_start": true },
  { "nombre": "ERP Masterbus", "tipo": "pull", "url": "https://mantenimiento.masterbus.net/", "plataforma": "propio", "es_dependencia": true },
  { "nombre": "Rotación", "tipo": "heartbeat", "max_silencio_horas": 26, "plataforma": "local" }
]
```

## Lógica de chequeo (clave por el caso "online")

- **Estados:** `OK` · `LENTO` (responde pero supera umbral de latencia) · `CAÍDO` (no responde tras reintentos) · `DESPERTANDO` (1er intento lento en plataformas con `tolera_cold_start`).
- **Reintentos con backoff** antes de declarar `CAÍDO` → evita falsos positivos por sleep de Render / cold start de Cloud Run.
- **Alerta solo en transición** `OK → CAÍDO` (comparando con el `status.json` anterior), no en cada corrida → evita spam. Segunda alerta solo si sigue caído tras N horas.
- **Heartbeat (Fase 3):** el proceso local (Rotación) hace `GET` a un *dead-man's switch* (ej. healthchecks.io gratis, o commitea un timestamp); si pasa `max_silencio_horas` sin señal → caído.

## Diseño visual — branding Master Bus (bóveda)

- Primario `#ED5D3B`, acento/alerta `#D12F19`, fondo `#EDEDED`, texto `#333`, radius 4px, Arial. Light mode.
- Semáforo por fila: 🟢 OK · 🟡 lento/despertando · 🔴 caído. Mostrar **latencia**, **último check** y **desde cuándo está caído**.
- Logo arriba: `https://traficonuevo.masterbus.net/masterbus-logo.png`.

## Orden de desarrollo (fases)

1. **Checker + estado + panel** — `check.js` pinguea los pull-targets (Cubiertas, Consultas, Controles Stock, ERP), escribe `status.json`; `index.html` lo muestra. Deploy en GitHub Pages.
2. **Alertas por email** — `notify.js` manda email en transición OK→caído, con cooldown. SMTP en GitHub Secrets.
3. **Heartbeat para Rotación / batch** + historial (`history.json`) y % de uptime.
4. *(opcional)* "Check now" manual vía `workflow_dispatch`; vista de histórico.

## Decision Log

| # | Decisión | Alternativas | Por qué |
|---|---|---|---|
| 1 | GitHub Actions + Pages (gratis) | Render, Railway, Cloud Run | $0 real, sin backend always-on, **un monitor no se puede dormir** (Render queda descartado) |
| 2 | `status.json` en el repo | BD (SQLite/MySQL) | Simple, versionado, gratis; el historial es el propio git |
| 3 | Email para alertas | Telegram | Elección del usuario; bueno para registro |
| 4 | HTML + JS estático | React/Vite | Panel interno simple; cero build |
| 5 | Ping web al ERP | Conexión MySQL directa | Actions no llega fácil a la BD; el web sirve de proxy de liveness en v1 |

## Reusos desde la bóveda (no reinventar)

- **«Automatización y notificaciones proactivas»** → cron → email, **cooldown** anti-spam, modo `--dry-run` para probar sin mandar mails.
- **«Stack de deploys gratuitos»** → las mañas de cada plataforma (Render duerme, Cloud Run cold start) ya están mapeadas → de ahí salen los reintentos.
- **«Manejo de credenciales y entorno»** → SMTP y tokens en **GitHub Secrets** (es el mismo patrón que `.env`, sin commitear nada).
- **«Estrategia de testing»** → testear `check.js` con HTTP mockeado; reusar los *smoke tests* existentes como checks remotos.
- **Esqueleto:** mirar `masterbus-dashboard` (Consultas BD Mantenimiento) para el patrón `/health` y el branding.

## Supuestos / pendientes

- **Cada proyecto web debería exponer `GET /health`** que valide su propia BD. Consultas ya lo tiene; a Cubiertas hay que agregarlo. → **patrón nuevo a estandarizar e ingestar en la bóveda como concepto «Health endpoint estándar».**
- Cron de Actions: mínimo 5 min y puede demorarse bajo carga (aceptable para esto).
- **Seguridad:** si el panel (GitHub Pages) es público, `status.json` **no** debe exponer URLs internas sensibles ni credenciales. Evaluar repo privado + Pages con acceso, o un panel sin datos sensibles.
- Completar las URLs reales de cada deploy en `proyectos.json`.
```
