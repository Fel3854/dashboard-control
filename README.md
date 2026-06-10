# Dashboard de Control — Master Bus

Panel para ver de un vistazo si los proyectos del ecosistema Master Bus están **online y
sanos**. Un checker pinguea cada servicio cada 10 min (vía GitHub Actions), calcula
estado + latencia y escribe `public/status.json`; el panel estático (GitHub Pages) lo
muestra con semáforos 🟢🟡🔴.

> Fuente de verdad del diseño: [`DESIGN.md`](DESIGN.md). **Fase 1** (checker + estado +
> panel), **Fase 2** (alertas por email) y **Fase 3** (heartbeat + historial + uptime) ya
> están en producción. Sumado: detalle por proyecto, botón de chequeo manual y alertas por
> Telegram (ver más abajo).

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
| `tipo` | sí | `pull` (se pinguea) o `heartbeat` (proceso *push*, ver Fase 3). |
| `max_silencio_horas` | si es `heartbeat` | Silencio tolerado antes de marcar `INACTIVO` (default 26). |
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

## Fase 2 — Alertas por email

`check.js` llama a [`checker/notify.js`](checker/notify.js) **después** de escribir
`status.json`. `notify.js` detecta transiciones y aplica un cooldown anti-spam; **no manda
SMTP** (sin dependencias): cuando corre en el Action, marca un output `alerta=true` y el
step [`dawidd6/action-send-mail`](.github/workflows/check.yml) envía el mail.

**Cuándo avisa** (un solo mail por corrida que agrupa los cambios):

| Evento | Condición |
|---|---|
| 🔴 Caída | un proyecto pasó a `CAÍDO` (no lo estaba antes) |
| 🔴 Sigue caído | continúa `CAÍDO` y pasaron ≥ N horas desde la última alerta (recordatorio) |
| 🟢 Recuperado | estaba `CAÍDO` y volvió a responder |

El estado de las alertas se persiste en `alertas-estado.json` (commiteado, igual que
`status.json`) para que el cooldown sobreviva entre corridas.

### Activar el email (una vez)

1. **GitHub Secrets** — en el repo: **Settings → Secrets and variables → Actions → New
   repository secret**. Creá:

   | Secret | Ejemplo | Notas |
   |---|---|---|
   | `MAIL_SERVER` | `smtp.gmail.com` | Sin esto, el envío se saltea (no rompe el run). |
   | `MAIL_PORT` | `465` | 465 (SSL) o 587 (STARTTLS). |
   | `MAIL_USERNAME` | `masterbusdev@gmail.com` | Usuario SMTP. |
   | `MAIL_PASSWORD` | *(App Password)* | En Gmail **no** es tu clave normal: generá un **App Password** (requiere 2FA). |
   | `MAIL_TO` | `vos@ejemplo.com` | A quién avisar (coma-separado para varios). |

2. Listo: ante la próxima transición `OK → CAÍDO`, llega el mail. **Nunca** se commitea
   ningún secreto; viven solo en GitHub Secrets.

### Probar sin enviar (dry-run)

```bash
DRY_RUN=1 PROYECTOS_FILE=proyectos.example.json node checker/check.js
```

Con `DRY_RUN=1`, `notify.js` **loguea** el asunto/cuerpo que mandaría pero no envía ni
persiste. Variables útiles:

| Var | Default | Para qué |
|---|---|---|
| `DRY_RUN` | (off) | `1` = no envía ni persiste (solo loguea). |
| `ALERTA_COOLDOWN_HORAS` | `6` | Horas entre recordatorios de un mismo proyecto caído. |
| `PANEL_URL` | (la de Pages) | Link al panel que se incluye en el mail. |

## Fase 3 — Heartbeat + historial + uptime

### Heartbeat (procesos que no se pingean)

Para batch/local como **Rotación** (Streamlit) que no expone una URL, el modelo es *push*:
el proceso reporta su última corrida y el checker vigila el silencio.

- Config en `proyectos.json`: `{ "nombre": "Rotación", "tipo": "heartbeat",
  "max_silencio_horas": 26, "plataforma": "local" }`.
- El proceso, al terminar, escribe `heartbeats/<slug>.json` (`slug` de "Rotación" =
  `rotacion`) con `{ "ultima_corrida": "<ISO>", "ok": true }`.
- El checker (`checker/heartbeat.js`) lo lee y decide:
  - **OK** 🟢 — reportó hace ≤ `max_silencio_horas` y la corrida fue exitosa.
  - **CAÍDO** 🔴 — la última corrida reportó `ok:false` (**falla real** del proceso).
  - **INACTIVO** ⚪ — reportó alguna vez pero superó el silencio permitido. Es un batch de
    cadencia irregular que **no corrió hace rato**: NO es una caída, así que **no alarma**
    (no manda email/Telegram), no cuenta como "caído" en el resumen y **no penaliza el
    uptime**. Solo informa.
  - **SIN DATOS** ⚪ — todavía no hay ningún reporte.

  > El silencio de un heartbeat **ya no se marca como CAÍDO** (eso daba falsas alarmas con
  > procesos que no corren todos los días): el rojo se reserva para `ok:false`.

**Cómo reporta Rotación** — script [`heartbeat/ping.py`](heartbeat/ping.py) (solo
stdlib, sin instalar nada), que actualiza el archivo vía la GitHub API sin clonar el repo:

```bash
GH_TOKEN=<token> python3 heartbeat/ping.py --slug rotacion --ok     # corrida OK
GH_TOKEN=<token> python3 heartbeat/ping.py --slug rotacion --fail   # corrida con error
```

Desde tu proceso Python, al final de la corrida:

```python
import os, subprocess
subprocess.run(["python3", "heartbeat/ping.py", "--slug", "rotacion", "--ok"],
               env={**os.environ, "GH_TOKEN": MI_TOKEN})
```

> 🔑 `GH_TOKEN` = un **Personal Access Token fine-grained** con permiso *Contents: Read
> and write* **solo** sobre este repo. Vive en la máquina de Rotación (en su `.env`), nunca
> se commitea. El repo/branch se pueden cambiar con `--repo`/`--branch` o las env
> `HEARTBEAT_REPO`/`HEARTBEAT_BRANCH`.

### Historial y % de uptime

- `history.json` (commiteado) guarda un *append* de las **transiciones** de estado — es
  compacto y permite reconstruir cuánto tiempo estuvo cada proyecto online.
- El checker calcula el **% de uptime** de cada proyecto sobre ventanas móviles de **7 / 30
  / 90 días** (`checker/historial.js`) y los incluye en `status.json` (`uptime` = 30 d para
  la fila, `uptimes` para el detalle). `OK`/`LENTO`/`DESPERTANDO`/`INACTIVO` cuentan como
  "online"; solo `CAÍDO`/`SIN DATOS` penalizan.
- El historial se poda a 90 días (conservando un ancla por proyecto para no perder el
  punto de partida del cálculo). Se publica una copia en `public/history.json` para que el
  panel dibuje el detalle por proyecto.

## Mejoras del panel

- **Detalle por proyecto** — tocá cualquier fila y se expande mostrando uptime 7/30/90 d,
  los datos actuales (latencia/HTTP o última corrida, plataforma, "desde") y los **últimos
  cambios de estado** (de `public/history.json`). Se vuelve a tocar para cerrar.
- **Forzar chequeo** — el botón "↻ Forzar chequeo" abre la pestaña de GitHub Actions del
  workflow para correrlo on-demand (botón *Run workflow*) sin esperar al cron. Un panel
  estático **público** no puede guardar un token de escritura, así que el disparo es
  manual desde Actions (seguro y sin secretos en el front).

## Alertas por Telegram (opcional)

Además del email, el workflow puede avisar las mismas transiciones a un chat de Telegram.
Reusa el cuerpo que arma `notify.js`; un `curl` a la Bot API alcanza (sin Action externa).
Se activa **solo** si está el secret `TELEGRAM_BOT_TOKEN` (si no, se saltea, igual que el
email).

### Activar (una vez)

1. **Crear el bot:** escribile a [`@BotFather`](https://t.me/BotFather) → `/newbot` →
   te da el **token** (`123456:ABC-...`).
2. **Obtener el `chat_id`:** mandale un mensaje a tu bot (o agregalo al grupo) y abrí
   `https://api.telegram.org/bot<TOKEN>/getUpdates` — el `chat_id` aparece en
   `result[].message.chat.id` (para grupos es negativo).
3. **GitHub Secrets** (Settings → Secrets and variables → Actions):

   | Secret | Ejemplo | Notas |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | `123456:ABC-DEF…` | Token de @BotFather. Sin esto el envío se saltea. |
   | `TELEGRAM_CHAT_ID` | `12345678` o `-1001234…` | Chat/grupo donde avisar. |

Listo: ante la próxima caída/recuperación, llega el mensaje a Telegram (y el email, si está
configurado — son independientes).
