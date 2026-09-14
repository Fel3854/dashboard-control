# Guía del Dashboard de Control — Master Bus

Cómo leer el panel y qué significa cada medición.

El dashboard vive en **[fel3854.github.io/dashboard-control](https://fel3854.github.io/dashboard-control)**.
Cada ~10 minutos, un robot (GitHub Actions) revisa uno por uno los proyectos del ecosistema, guarda el
resultado y vuelve a publicar la página. Vos solo abrís el link y mirás los colores.

> Esta guía explica **qué mirás** en el panel. Para instalar, configurar secretos o agregar un proyecto,
> ver el [README](README.md).

## Índice

**[Parte A — Cómo leer el panel](#parte-a--cómo-leer-el-panel-rápido)**
- [Los colores (el semáforo)](#los-colores-el-semáforo-de-cada-proyecto)
- [Las 3 cosas que medimos](#las-3-cosas-que-medimos-por-proyecto)
- [El chip de "función" 🟢/🔴](#el-chip-de-función-)
- [Etiquetas: 🚨 crítico y 🛠 mantenimiento](#etiquetas-de-fila--crítico-y--mantenimiento)
- [El resumen de arriba](#el-resumen-de-arriba-1-con-avisos--1-inactivos)
- [Uptime y "desde"](#uptime-y-desde)
- [La barra de "datos desactualizados"](#la-barra-roja-de-datos-desactualizados)
- [Qué hago si veo…](#qué-hago-si-veo)

**[Parte B — Detalle técnico](#parte-b--detalle-técnico)**
- [Estados de ping](#estados-de-ping-proyectos-tipo-pull)
- [Chequeo de salud (`/health`)](#chequeo-de-salud-saludjson--health)
- [Certificado TLS / HTTPS](#certificado-tls--https-proyectos-https)
- [Chequeo funcional](#chequeo-funcional-funcion)
- [Heartbeat](#heartbeat-procesos-que-no-se-pingean-ej-rotacion)
- [Ventanas de mantenimiento](#ventanas-de-mantenimiento)
- [Cómo se calcula el uptime](#cómo-se-calcula-el-uptime)
- [Alertas (email / Telegram)](#alertas-email--telegram)
- [Cada cuánto corre y cómo forzarlo](#cada-cuánto-corre-y-cómo-forzarlo)
- [Confiabilidad del monitor](#confiabilidad-del-monitor-que-no-muera-en-silencio)

**[Apéndice — Caso "Capacitaciones RRHH"](#apéndice--el-caso-capacitaciones-rrhh)**

---

# Parte A — Cómo leer el panel (rápido)

## Los colores (el semáforo de cada proyecto)

Cada proyecto tiene un círculo de color. Es lo primero que mirás:

| Color | Estado | Qué significa | ¿Me preocupo? |
|-------|--------|----------------|----------------|
| 🟢 | **OK** | Responde bien y rápido. | No. |
| 🟡 | **LENTO** | Responde, pero tarda (≥ 3 s). Anda, pero pesado. | Ojo, no urgente. |
| 🟡 | **DESPERTANDO** | Estaba "dormido" (se apaga solo para ahorrar) y está arrancando. | No, es normal en esos servicios. |
| 🔴 | **CAÍDO** | No respondió tras varios intentos. Está caído. | **Sí.** |
| ⚪ | **INACTIVO** | Un proceso que reporta cada tanto lleva rato sin avisar. No es una caída. | Chequear si corresponde. |
| ⚪ | **SIN DATOS** | Todavía no llegó ninguna señal de ese proceso. | Solo al principio. |

**La regla mental:** 🟢 y 🟡 = está arriba. 🔴 = está caído. ⚪ = un proceso que trabaja por lotes (no se
puede "pinguear") y ahora está callado — informativo, no alarma.

## Las 3 cosas que medimos por proyecto

No alcanza con "el servidor contesta". Un sitio puede abrir y aun así tener el login roto o la base caída
por detrás. Por eso medimos hasta 3 capas (según el proyecto):

1. **Ping** — ¿el servidor responde? → define el **color del semáforo**.
2. **Salud** (`/health`) — ¿está sano por dentro? (versión, base de datos, uptime). Aparece en el detalle.
3. **Función** — ¿*funciona de verdad*? Ejecuta una acción real (ej. **login + una consulta a la base**) y
   valida la respuesta. → define el **chip "función"**.

## El chip de "función" 🟢/🔴

Debajo del nombre puede aparecer un chip:

- 🟢 **función OK** — la prueba real (ej. login) anduvo.
- 🔴 **función falla** — la prueba real falló, **aunque el sitio abra**.
- (sin chip) — ese proyecto no tiene prueba funcional, o falta cargar sus credenciales de prueba.

> **Importante:** el semáforo puede estar 🟢 **y** el chip 🔴 al mismo tiempo. Significa: *"la página carga,
> pero la función que probamos no anda"*. Es justo lo más valioso de detectar. (Ver el caso real de
> **Capacitaciones RRHH** en el [Apéndice](#apéndice--el-caso-capacitaciones-rrhh).)

## Etiquetas de fila: 🚨 crítico y 🛠 mantenimiento

Debajo de algunos proyectos pueden aparecer etiquetas (son informativas, no cambian el color):

- 🚨 **crítico** — es un servicio clave, o del que dependen otros (como el **ERP**). Si se cae, su alerta es
  **CRÍTICA** y escala más rápido que las demás (ver Parte B).
- 🛠 **mantenimiento** — hay una **ventana de mantenimiento** declarada para ese proyecto: su estado se sigue
  mostrando, pero **no** dispara alertas (para no avisar de un corte que vos mismo programaste).

## El resumen de arriba ("1 con avisos · 1 inactivos")

El encabezado cuenta los proyectos por categoría:

- **🔴 caído/s** = en CAÍDO.
- **🟡 con avisos** = en LENTO o DESPERTANDO.
- **⚪ inactivo/s** = en INACTIVO o SIN DATOS.
- Si no hay ninguno de esos → **🟢 Todo OK**.

Ejemplo: *"1 con avisos · 1 inactivos"* = 1 proyecto lento/despertando + 1 proceso callado. Ninguno caído.

## Uptime y "desde"

- **uptime 99.8% · 30d** — qué porcentaje del tiempo estuvo *arriba* en la ventana (por defecto, 30 días).
  En el detalle vas a ver también 7d y 90d. *Lento cuenta como arriba*; solo penaliza estar **caído**.
- **"desde"** / **"En este estado desde"** — desde cuándo está en el estado actual (ej. *"caído hace 2 h"*).

## La barra roja de "datos desactualizados"

Si arriba de todo aparece una **barra roja** que dice *"Datos posiblemente desactualizados — el último check
fue hace…"*, quiere decir que el robot **dejó de actualizar** el panel (hace más de 30 min). Ojo: lo de
abajo puede **no ser el estado actual**, y el problema puede ser el **monitor mismo**, no los proyectos.
Qué hacer: entrar a GitHub Actions y ver si el workflow *Check & Deploy* está corriendo o quedó en rojo.

## Qué hago si veo…

- 🔴 **CAÍDO** → el servicio está abajo. Abrir el proyecto, revisar su plataforma (Vercel/Render/Modal/…),
  logs y deploy. Si tenés alertas activas, ya te llegó un mail/Telegram.
- 🔴 **función falla** (con semáforo verde) → el sitio abre pero la acción probada (casi siempre el **login**)
  no anda. Abrí el detalle: dice **en qué paso** falló y **por qué** (ej. *"status 400: Invalid login
  credentials"*). Suele ser credenciales/permisos, no el servidor.
- 🟡 **LENTO** → responde pero tarda. Si persiste, mirar carga/recursos. No es urgente.
- 🟡 **DESPERTANDO** → normal en servicios que se apagan solos (Render/Modal/Cloud Run). Se acomoda solo.
- ⚪ **INACTIVO** → un proceso por lotes lleva rato sin reportar. Verificar que su tarea programada corra.
- 🟥 **barra "datos desactualizados"** → dejó de reportar el **monitor** (no los proyectos). Revisar el
  workflow *Check & Deploy* en GitHub Actions.
- ⚠️ **"cert vence en X días"** (en el detalle) → al certificado HTTPS le quedan pocos días; **renovarlo
  antes** de que venza (un cert vencido tira el servicio).
- 🛠 **mantenimiento** → ese proyecto está en una ventana planificada: sus alertas están silenciadas a
  propósito, no te preocupes por ese.

*Tip:* el botón **"Forzar chequeo"** abre GitHub Actions para correr la revisión ahora, sin esperar los
10 minutos. Cada tarjeta se **expande** (▸) para ver latencia, HTTP, salud, la función probada y los
últimos cambios de estado.

---

# Parte B — Detalle técnico

Todos los umbrales salen del código; entre paréntesis, dónde mirarlos.

## Estados de ping (proyectos `tipo: "pull"`)

El checker hace un `GET` a la URL del proyecto, con **timeout de 10 s** y hasta **3 intentos** con esperas
de **0 s, 2 s y 5 s** antes de cada uno; corta apenas uno responde. Un intento cuenta como éxito si el
HTTP es **2xx o 3xx**. (`[checker/check.js](checker/check.js)`: `TIMEOUT_MS`, `LENTO_MS`, `DELAYS`,
`decidirEstado`.)

| Estado | Condición exacta |
|--------|------------------|
| **CAÍDO** | Ningún intento respondió 2xx/3xx tras los 3 intentos. |
| **DESPERTANDO** | El 1er intento falló pero un reintento respondió, **y** el proyecto tiene `tolera_cold_start: true`. Se evalúa **antes** que LENTO. |
| **LENTO** | Respondió, pero la latencia del intento bueno fue **≥ 3.000 ms**. |
| **OK** | Respondió 2xx/3xx con latencia **< 3.000 ms**. |

- `tolera_cold_start` (en [proyectos.json](proyectos.json)) marca servicios que se apagan solos. Sin esa
  marca, un servicio que falla el 1er intento pero revive queda OK/LENTO (nunca DESPERTANDO).
- `SIN_DATOS` e `INACTIVO` **no** son estados de ping: solo los produce el heartbeat (ver abajo).

## Chequeo de salud (`salud_json` → `/health`)

Si el proyecto tiene `salud_json: true` y el ping salió OK/LENTO/DESPERTANDO, el checker consulta su
`/health` (timeout 5 s) y muestra datos en el detalle. **No cambia el color** — es metadata.
(`[checker/salud.js](checker/salud.js)`.)

- Convención del endpoint: `{ "status":"ok", "version":"1.0.0", "db":"ok", "uptime_s":123 }`.
- Por seguridad solo se conservan campos de una lista blanca (`status`, `version`, `db`/`database`,
  `uptime_s`, `commit`); todo lo demás se descarta y los textos se recortan. Nunca expone tokens ni
  connection strings aunque el endpoint los devuelva.

## Certificado TLS / HTTPS (proyectos `https`)

El certificado HTTPS es lo que hace andar el **candado** del navegador: cifra el tráfico y prueba que el
dominio es legítimo. Tiene **fecha de vencimiento** (Let's Encrypt dura 90 días; otros emisores, 1 año) y hay
que **renovarlo** antes de esa fecha. La renovación suele ser automática… hasta que un día no lo es.

### Qué pasa si vence (y por qué avisamos con anticipación)

Un certificado vencido **no es un aviso amarillo: es una caída total**, y por partida triple:

- **Los usuarios quedan afuera.** El navegador **bloquea** el sitio con una pantalla de error roja
  (*"Tu conexión no es privada"* / `NET::ERR_CERT_DATE_INVALID`) — no pueden entrar aunque el servidor esté
  perfecto por detrás.
- **Se rompen las integraciones.** Las apps y APIs que consumen el servicio **cortan la conexión** (fallan
  todos los pedidos HTTPS), aunque el backend funcione bien.
- **En el dashboard se ve 🔴 CAÍDO.** El propio ping falla, porque rechaza la conexión TLS inválida. O sea:
  cuando ya lo ves en rojo, el daño ya está hecho.

Por eso el checker no espera a que caduque. Para cada proyecto `https` que responde, abre una conexión TLS
aparte y lee **cuántos días le quedan** al certificado — lo ves en el detalle (*"Certificado TLS: vence en 60
días"*). Cuando quedan **≤ 21 días** (configurable con `CERT_AVISO_DIAS`), manda un **aviso** anticipado
(severidad AVISO, como mucho **1 vez por día**). Es la diferencia entre **renovar tranquilo un martes** y
tener **todo caído un domingo a la madrugada**.

```
   hoy ─────────────────────────────▶ vencimiento
        ✅ todo normal   │  🟡 aviso   │  🔴 CAÍDO
                     ≤ 21 días        día 0
                    "vence en N d"   sitio bloqueado
```

Es **best-effort**: solo lee la fecha del cert (no valida la cadena; de eso ya se encarga el ping); si no se
puede leer, no muestra nada y no rompe el checker. (`[checker/tls.js](checker/tls.js)`.)

### Cómo se renueva

- **Plataformas gestionadas** (Vercel, Render, Cloud Run): renuevan solas, no hay que hacer nada.
- **Let's Encrypt propio** (`certbot`): se auto-renueva por un cron; si el aviso salta, revisar que ese cron
  esté corriendo y llegando al servidor.
- **Cert manual/comprado**: renovarlo con el emisor y reinstalarlo antes del día 0.

## Chequeo funcional (`funcion`)

Ejecuta una secuencia de pasos HTTP reales y valida cada respuesta. Sirve para detectar fallas que un
"200 OK" no ve (login roto, base caída detrás de un front que igual carga). (`[checker/funcion.js](checker/funcion.js)`.)

- **Estados:** `FUNCION_OK` (todos los pasos pasaron), `FUNCION_FALLA` (falló uno; guarda el paso y el
  motivo), `FUNCION_OMITIDA` (falta algún secret de prueba → se saltea sin marcar rojo).
- **Reintentos inteligentes:** cada paso se reintenta (0/1,5/3,5 s) **solo** si la falla parece transitoria
  (error de red o 5xx: típico cold start). Una falla real (401, 400, campo faltante) **no** se reintenta.
- **Flujos con login:** mantiene un *jar* de cookies y puede extraer valores de un paso para el siguiente
  (ej. token CSRF de Laravel), e interpolar secretos (`env:NOMBRE`) y variables (`var:NOMBRE`).
- **Motivo detallado:** si un paso devuelve un status inesperado y el cuerpo trae un mensaje de error
  (`error_description`/`msg`/`message`/`error`), se anexa al motivo. Así el panel muestra
  *"status 400: Invalid login credentials"* en vez de solo *"status 400"*. (`cumpleEspera` + `mensajeError`.)
- **Motivo detallado (2):** si el paso termina en un **redirect** inesperado, el motivo dice **adónde**
  (*"status 302 (esperaba 200) → redirige a '/'"*); y si un endpoint JSON devuelve **HTML**, lo aclara
  (*"vino HTML — la app rebotó a una pantalla"*). Los dos casos apuntan casi siempre a lo mismo: sesión
  vencida o falta de permiso. Por eso los pasos llevan `no_seguir_redirect: true`: seguir el redirect
  esconde la pista detrás de una pantalla cualquiera.
- Los tres patrones ya configurados: **Cubiertas** (login por formulario + consulta), **ERP** (Laravel:
  CSRF + sesión), **Capacitaciones** (Supabase Auth `signInWithPassword`).

> **Lección aprendida — el usuario de prueba y los permisos (Cubiertas, 24/8/26):** el chequeo consultaba
> `/ajax/ultimo_fuego`; un deploy de Cubiertas puso ese endpoint detrás del permiso **crear cubiertas**, que
> el usuario de monitoreo (`LECTURA_TEST`, solo lectura) no tiene. El servidor lo rebotaba a la home y el
> panel mostraba *"falló en consulta — la respuesta no es JSON"* durante tres días, **con el servicio sano**.
> Se repuntó el chequeo a `/ajax/cubiertas_unidad` (permiso de **ver**, que sí tiene). Regla: **no le amplíes
> permisos al usuario de monitoreo para que pase el check** — esas credenciales viven en GitHub Secrets y
> conviene que no puedan escribir; mové el chequeo a un endpoint de lectura. Y ojo: la URL lleva un
> `unidad_id` fijo, así que si esa unidad se da de baja o se queda sin cubiertas montadas, hay que apuntarla
> a otra.

> **Punto ciego conocido — Controles Stock:** el bot de stock **consulta el ERP** por detrás, pero hoy se
> monitorea **solo con ping** (no tiene bloque `funcion`). Si el bot responde `200` pero su consulta al ERP
> está rota, el panel no lo ve. Queda **parcialmente** cubierto porque el **ERP** sí tiene chequeo funcional
> y es crítico (una caída total del ERP alerta). *Pendiente:* agregarle al bot un endpoint **read-only** que
> toque el ERP, para chequear la cadena de punta a punta.

## Heartbeat (procesos que no se pingean, ej. Rotacion)

Algunos procesos corren por lotes y no tienen URL para pinguear: en vez de eso, **avisan** cuando corren
(escriben `heartbeats/<slug>.json`). El checker lee esa señal. (`[checker/heartbeat.js](checker/heartbeat.js)`.)

| Estado | Condición |
|--------|-----------|
| **SIN_DATOS** | No hay ninguna señal todavía. |
| **CAÍDO** | La última corrida reportó `ok: false` (falló de verdad). |
| **INACTIVO** | Pasó más de `max_silencio_horas` (default **26 h**) sin reportar. Es silencio, **no** caída. |
| **OK** | Reportó dentro de la ventana y la corrida fue exitosa. |

Decisión de diseño: el silencio de un batch de cadencia irregular **no** dispara rojo (evita falsas
alarmas); el rojo se reserva para un `ok: false` explícito.

## Ventanas de mantenimiento

Para silenciar las alertas de un corte **planificado** (deploy, migración, ventana de proveedor), se declaran
ventanas en `mantenimiento.json` (hay un ejemplo en `mantenimiento.example.json`):

```json
[{ "nombre": "ERP Masterbus", "desde": "2026-08-01T02:00:00Z", "hasta": "2026-08-01T04:00:00Z", "motivo": "Migración" }]
```

Durante la ventana, el estado del proyecto **se sigue registrando** (color, uptime, historial), pero **no se
manda ninguna alerta**, y el panel le muestra el badge **🛠 mantenimiento**. `"nombre": "*"` aplica a todos
los proyectos (útil para un corte global). (`[checker/mantenimiento.js](checker/mantenimiento.js)`.)

## Cómo se calcula el uptime

`history.json` guarda solo **transiciones** de estado (no una muestra por corrida). El uptime reconstruye
cuánto tiempo estuvo en cada estado dentro de la ventana y divide *tiempo arriba / tiempo total*, redondeado
a 1 decimal. Ventanas: **7 / 30 / 90 días**; la fila muestra la de 30. (`[checker/historial.js](checker/historial.js)`.)

- **Cuentan como "arriba":** OK, LENTO, DESPERTANDO, **INACTIVO**. → *lento no baja el uptime*.
- **Penalizan (0%):** **CAÍDO** y **SIN_DATOS**.
- Es ponderado por tiempo: 1 hora caído pesa el doble que 30 minutos caído.

## Alertas (email / Telegram)

Después de cada chequeo, `[checker/notify.js](checker/notify.js)` compara con el estado anterior y avisa
solo ante lo que importa, con **cooldown** para no spamear. Cada alerta lleva una **severidad**:

| Evento | Cuándo | Severidad |
|--------|--------|-----------|
| 🔴 Caída | Un proyecto **pasó a CAÍDO**. | CRÍTICO si es crítico; si no, AVISO |
| 🔴 Sigue caído (recordatorio) | Sigue CAÍDO y venció el cooldown. | igual que la caída |
| 🚨 Escalamiento | Un **crítico** sigue caído **> 1 h**. Asunto más urgente. | CRÍTICO |
| 🟢 Recuperado | Volvió de CAÍDO. | INFO |
| 🔴 Función falla / sigue / 🟢 recuperada | Igual, para el chequeo funcional (avisa aunque el semáforo esté verde). | según criticidad |
| 🟡 Cert por vencer | Al certificado le quedan ≤ 21 días. | AVISO |
| 🟡 Lento sostenido | Sigue **LENTO** de forma continua ≥ 45 min. | AVISO |
| 🟡 Inestable (flapping) | **Rebota** de estado (≥ 4 cambios en 1 h): un solo aviso en vez de spam. | AVISO |

- **Severidad y asunto:** si hay algo CRÍTICO, el asunto del mail lleva el prefijo **`[🚨 CRÍTICO]`** (para
  triage rápido). Un servicio es crítico si tiene `"critico": true` en [proyectos.json](proyectos.json), o
  si es una dependencia (`es_dependencia`, ej. el **ERP**).
- **Escalamiento:** los críticos recuerdan cada **30 min** (los demás, cada **6 h**), y con el secret
  opcional `MAIL_TO_CRITICO` la alerta va **también** a una lista de guardia extra.
- **Anti-spam:** cooldowns separados por proyecto y evento; el flapping colapsa muchos rebotes en un solo
  aviso; el cert avisa como mucho **1 vez por día**.
- **No** alertan un LENTO puntual, DESPERTANDO, INACTIVO ni SIN_DATOS (ruido, no caídas). Un proyecto en
  **ventana de mantenimiento** tampoco genera ninguna alerta (ver *Ventanas de mantenimiento*).
- Los canales (email/Telegram) son opcionales: si su secret no está cargado, ese canal se saltea.
  (Setup en el [README](README.md).)

## Cada cuánto corre y cómo forzarlo

Corre por cron cada ~10 min, y también al cambiar la config/código. El botón **"Forzar chequeo"** del panel
abre la página de GitHub Actions para dispararlo a mano (un panel estático público no puede guardar un token
de escritura, por eso te manda a Actions). El panel además se refresca solo cada 60 s en el navegador.

## Confiabilidad del monitor (que no muera en silencio)

Un monitor no sirve si se cae sin avisar. Las capas que evitan eso:

- **Datos frescos:** si el panel queda **> 30 min** sin actualizarse, muestra la **barra roja** de datos
  desactualizados (señal de que el checker dejó de correr).
- **Dead-man switch (opcional):** con el secret `HEALTHCHECK_URL` (un check gratis en healthchecks.io), el
  workflow "pinguea" al terminar cada corrida; si GitHub deja de correr el cron o Actions se cae,
  healthchecks.io te avisa **desde afuera de GitHub**.
- **Entrega garantizada:** si había una alerta y **ningún** canal la entregó (SMTP roto, etc.), el run de
  Actions queda en **rojo** (visible) en vez de tragarse el aviso en silencio.
- **Canario semanal:** el workflow `canary-alertas.yml` manda una alerta de prueba cada lunes para confirmar
  que email/Telegram siguen vivos. (También podés disparar una a mano con el input `test_alerta`.)
- **Tests antes de deployar:** el workflow corre la batería de tests antes de publicar, así un bug en la
  lógica de estado o de alertas no llega a producción.

---

# Apéndice — El caso "Capacitaciones RRHH"

Ejemplo real de **semáforo verde + chip 🔴 función falla**, y cómo se arregla.

**Síntoma:** el sitio de Capacitaciones abre normal (ping 🟢 OK, HTTP 200), pero el chip dice
**🔴 función falla**, y el detalle: *"falló en login — status 400 (esperaba 200)"*.

**Qué prueba ese chequeo:** hace un login real contra Supabase Auth
(`POST /auth/v1/token?grant_type=password`) con un email/clave de prueba, esperando un `200` con
`access_token`. Los datos de prueba viven en GitHub Secrets: `CAP_EMAIL`, `CAP_PASS`, `CAP_SUPABASE_ANON_KEY`.

**Diagnóstico:** contra ese endpoint, una **apikey** inválida devuelve `401`; nosotros recibimos `400`. Es
decir, la apikey es correcta, pero Supabase **rechaza el login**: un `400` en este endpoint = credenciales
inválidas, email sin confirmar, o cuenta sin contraseña. → **No es el servidor ni el código**: es la
**cuenta de prueba** la que no puede autenticarse.

**Cómo arreglarlo (hay que hacerlo en GitHub y Supabase, no en el código):**

1. En Supabase (proyecto de Capacitaciones) → **Authentication → Users**, crear/verificar una **cuenta de
   monitoreo dedicada** (ej. `monitor@masterbus…`) con **"Auto Confirm"** activado y una contraseña estable
   que no vaya a rotar.
2. En GitHub → repo `dashboard-control` → **Settings → Secrets and variables → Actions**, setear:
   - `CAP_EMAIL` = ese email
   - `CAP_PASS` = esa contraseña
   - `CAP_SUPABASE_ANON_KEY` = ya está OK, no tocar.
3. Correr **"Forzar chequeo"** (Actions → *Check & Deploy* → *Run workflow*) y confirmar que el chip pase a
   **🟢 función OK**.

> Con la mejora del motivo detallado, la próxima vez el panel va a decir directamente *"status 400: Invalid
> login credentials"* (o *"Email not confirmed"*), así se distingue de una sola mirada si el problema es la
> contraseña o la confirmación del email.
