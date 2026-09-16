# Runbook: restaurar un backup en producción

Para usar durante un incidente real (datos corrompidos, borrado accidental,
un cliente pide volver a un punto anterior). Si es la primera vez que hacés
esto, practicá antes con `npm run backup:restore-drill:escritura` (ver
"Antes del incidente" más abajo) — restaura contra un tenant descartable
con rollback automático, sin tocar nada real.

**Nunca ejecutes un paso de este runbook sin haber completado el paso
anterior.** Restaurar un backup es destructivo: vacía todos los datos de
negocio del tenant destino antes de insertar los del backup (ver
`vaciarDatosDeTenant` en `platformBackup.service.ts`).

## 0. Antes del incidente (hacer esto ahora, no cuando ya pasó algo)

Correr el drill de escritura a demanda para confirmar que el camino de
restore funciona hoy, sin esperar a la corrida automática:

```bash
npm run backup:restore-drill:escritura
```

Esto reutiliza exactamente `restaurarBackupService`/`vaciarDatosDeTenant`/
`restaurarTablas` — el mismo código de este runbook — pero sobre un tenant
temporal (`__drill__<uuid>`) dentro de una transacción que **siempre**
termina en `ROLLBACK`, incluso si todo sale bien (ver
`platformBackupWriteDrill.worker.ts`). Si este comando falla, arreglalo
antes de que haga falta un restore real — es la señal más barata que vas a
tener.

## 1. Variables de entorno necesarias

Todas viven en `.env` del servidor (Railway o local). Sin cualquiera de
estas tres primeras, el restore no puede ni empezar:

| Variable | Para qué |
|---|---|
| `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` (o `DATABASE_URL`) | Conexión a Postgres — el restore corre dentro de una transacción `withTenant()` |
| `BACKUP_ENCRYPTION_KEY` | Descifra el backup al leerlo (`leerBackup`, ver `backupCrypto.ts`) — sin esta clave el JSON no se puede abrir, ni para leerlo ni para restaurarlo |
| `PLATFORM_ADMIN_TOKEN` | Credencial para llamar al endpoint de restore (ver paso 3) |
| `BACKUP_STORAGE_DRIVER` + credenciales de S3 (si aplica) | Solo hace falta si el backup a restaurar vive en S3 — `platformBackup.service.ts` lee el driver de la propia fila (`tenant_backups.storage`), no de esta variable, así que un backup viejo en local se sigue leyendo de local aunque hoy el driver activo sea S3 |

Confirmá que están cargadas antes de seguir:

```bash
# En el servidor real (Railway): revisar las variables desde el dashboard.
# En local, contra una copia de producción:
echo "PG_HOST=$PG_HOST BACKUP_ENCRYPTION_KEY=${BACKUP_ENCRYPTION_KEY:+(seteada)}"
```

## 2. Identificar el backup correcto — ANTES de tocar nada

**No asumas que el backup más reciente es el correcto.** Si el incidente es
"un usuario borró datos sin querer hace 2 horas", el backup de esta
madrugada ya tiene el daño adentro.

```bash
# Backups de un tenant específico, más nuevo primero (ver
# listarBackupsTenantService — la fila más reciente aparece primera):
curl -s -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  "$APP_PUBLIC_URL/api/platform/tenants/<TENANT_ID>/backups" | jq '.backups[] | {id, estado, creadoEn, tablas}'
```

De la respuesta, confirmá **antes de restaurar**:

- `estado` es `"completo"` (nunca uses uno en `"fallido"` — no tiene datos
  consistentes).
- `creadoEn` es de ANTES del momento en que el daño ocurrió, no del más
  reciente sin más.
- `tablas` (el manifiesto: cuántas filas tiene cada tabla) tiene números
  que tienen sentido — un backup con `"repuestos": 0` cuando el tenant
  siempre tuvo miles es una señal de que ese backup específico salió mal,
  aunque su `estado` diga `"completo"`.

Si no sabés el `TENANT_ID`, buscalo por slug:

```bash
curl -s -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  "$APP_PUBLIC_URL/api/platform/tenants" | jq '.tenants[] | select(.slug=="<slug-del-cliente>")'
```

Anotá el `backupId` (columna `id` de la fila elegida) — es lo único que
necesitás del paso anterior.

## 3. Ejecutar el restore

Requiere **super_admin** de plataforma o el secreto compartido
(`PLATFORM_ADMIN_TOKEN`) — ver `platformSuperAdminMiddleware`. `confirmar:
true` es obligatorio en el body; sin él, la request ni siquiera pasa la
validación del schema (`restaurarBackupSchema`).

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetTenantId": "<TENANT_ID>", "confirmar": true}' \
  "$APP_PUBLIC_URL/api/platform/backups/<BACKUP_ID>/restaurar" | jq
```

Comando exacto, sin variables, para copiar/pegar en el incidente (reemplazá
los tres valores entre `<>`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer <PLATFORM_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"targetTenantId": "<TENANT_ID>", "confirmar": true}' \
  "<APP_PUBLIC_URL>/api/platform/backups/<BACKUP_ID>/restaurar"
```

**Qué hace, en orden** (`restaurarBackupService`, `platformBackup.service.ts`):

1. Lee y descifra el backup elegido.
2. Abre una transacción con `withTenant(targetTenantId, ...)`.
3. `vaciarDatosDeTenant`: borra TODAS las filas de negocio actuales del
   tenant destino (repuestos, combustible, documentos, equipos,
   checklists, ipercs) **y también sus usuarios**, que el paso 4 vuelve a
   insertar desde el backup. Las **cuentas** (la persona detrás de cada
   usuario, migración 0087) nunca se borran: no son de esta empresa, y la
   misma persona puede estar trabajando en otra.
4. `restaurarTablas`: inserta las filas del backup, en el orden que
   respeta las FK (`raices`/`tablas` del registry de módulos).
5. Si el backup restauró usuarios, incrementa `token_version` de todos en
   +1000 — **cualquier sesión activa de ese tenant queda invalidada de
   inmediato**, sin importar cuándo expire su JWT. Es intencional: un
   restore es un rollback de estado, un token emitido después del momento
   del backup no debe seguir sirviendo.

   La **clave** de quien entra con correo NO vuelve a la del backup: vive en
   su cuenta y la cuenta no se toca (si la cambió después del backup, sigue
   valiendo la nueva). Si la cuenta ya no existía, se recrea desde el backup.
   Ver `docs/architecture/cuentas-perfiles-y-administracion.md` §13.
6. Todo en una sola transacción — si cualquier paso falla, `ROLLBACK`
   completo. El tenant nunca queda a medio restaurar.

Respuesta esperada (200):

```json
{ "ok": true, "tablasRestauradas": { "repuestos": 412, "equipos": 18, ... } }
```

**Compará `tablasRestauradas` contra el `tablas` del backup que anotaste en
el paso 2** — tienen que coincidir número por número. Si no coinciden, algo
salió mal a pesar del 200 (no debería pasar — `restaurarTablas` cuenta lo
que efectivamente insertó — pero es la última verificación barata antes de
avisarle al cliente que ya está resuelto).

## 4. Después de restaurar

- Avisale al tenant que sus sesiones activas se cerraron (paso 3.5) —
  van a necesitar loguearse de nuevo.
- Registrá el incidente: la restauración ya quedó en `platform_audit_log`
  con `accion: "restaurar_backup_tenant"` (acción automática del propio
  servicio, no hace falta nada manual acá) — incluye `backupId`,
  `backupTenantOriginal` y `tablasRestauradas`.
- Si el restore fue por un bug de la aplicación (no un error humano),
  abrí el ticket correspondiente antes de cerrar el incidente — un
  restore es un síntoma, no una solución al problema de fondo.

## 5. Criterio de rollback — si el restore mismo sale mal

**Un restore que falla (statusCode ≠ 200) no dejó nada a medias**: corre
dentro de una única transacción Postgres, así que un error en cualquier
paso revierte todo — el tenant queda exactamente como estaba antes de
intentarlo. Confirmalo si tenés dudas:

```bash
curl -s -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  "$APP_PUBLIC_URL/api/platform/tenants/<TENANT_ID>/salud" | jq '.salud.usuariosTotal'
```

Si ese número es el mismo de antes de intentar el restore, no hay nada que
revertir — repetí desde el paso 2 (probablemente con otro `backupId`, o
después de resolver lo que haya fallado: ver `err`/`message` en la
respuesta y el log `"Falló la restauración de un backup de tenant"` en el
servidor).

**El único escenario donde SÍ hay algo que "deshacer" es cuando el restore
respondió 200 pero restauró el backup equivocado** (ej. se restauró un
backup de antes de lo necesario, o el manifiesto no coincidía con lo
insertado — ver la verificación del paso 3). En ese caso:

1. No hay una operación de "deshacer restore" — la única forma de volver
   atrás es restaurar de nuevo, esta vez con el `backupId` correcto (o,
   si el propio restore corrompió datos que ya no tienen backup, no hay
   forma de recuperarlos — por eso el paso 2 es el que más importa de
   todo este runbook).
2. Restaurar de nuevo repite el mismo ciclo (vaciar + insertar) — no hace
   falta ningún paso extra de limpieza antes de reintentar.

## Referencia rápida

| Necesitás | Dónde |
|---|---|
| Confirmar que el camino de restore funciona hoy | `npm run backup:restore-drill:escritura` |
| Listar backups de un tenant | `GET /api/platform/tenants/:id/backups` |
| Restaurar | `POST /api/platform/backups/:backupId/restaurar` (`super_admin`, `confirmar: true`) |
| Código fuente del restore | `src/server/services/platformBackup.service.ts` (`restaurarBackupService`) |
| Backup de PLATAFORMA (no de un tenant) | `POST /api/platform/backups/plataforma/:backupId/restaurar` — aditivo, nunca vacía nada, ver `restaurarBackupPlataformaService` |
