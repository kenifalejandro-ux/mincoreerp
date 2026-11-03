# ADR-0002: Contrato de Módulo

- **Estado**: Aceptado — implementado y probado (tests + smoke test manual en navegador).
- **Fecha**: 2026-08-02
- **Alcance**: cómo se registra, construye y opera un módulo del ERP (Repuestos, Combustible, Documentos, Dashboard, Equipos, Checklists, IPERC, y cualquiera que se agregue después). No toca multi-tenancy/plataforma en sí (ver [ADR-0001](0001-multi-tenancy-plataforma.md)), que ya está resuelto — este documento asume esa fundación y construye sobre ella.

---

## Resumen ejecutivo

Hasta hoy, "qué módulos tiene el ERP" no era una lista — eran **cinco listas separadas que nadie sincronizaba**: el enum `modulo_erp` de Postgres, la constante `MODULOS_ERP` en el backend, el montaje de rutas en `routes/index.ts`, el array de pestañas del `Sidebar.tsx`, y el `switch` de pantallas en `App.tsx`. La consecuencia real, no hipotética: **Equipos, Checklists e IPERC tenían backend completo (rutas, RLS, permisos) pero eran invisibles en el cliente** — nadie los agregó al Sidebar ni a `App.tsx` después de construirlos, y nada fallaba para avisarlo.

Este ADR define un Contrato de Módulo y lo hace cumplir con código, no solo con documentación:

- **Un registry por lado** (`src/modules/registry.ts` en el backend, `client/src/modules/registry.tsx` en el cliente) es ahora la única fuente de verdad de la que se _derivan_ rutas, validación, backup/restore y el menú — en vez de mantenerse a mano en cada lugar.
- **Dos tests de CI nuevos** (`tests/module-registry.test.ts`, `tests/rls-coverage.test.ts`) convierten el drift de "alguien agregó un módulo a medias" en un fallo de test, no en un bug que se descubre meses después.
- Equipos, Checklists e IPERC ya tienen pantalla en el cliente (mínima, no el flujo completo — ver "Fuera de alcance").
- Todo módulo de negocio ahora audita sus acciones de escritura en `platform_audit_log` (antes solo el panel de plataforma auditaba algo).

**Lo que se preservó tal cual, porque ya funcionaba bien**: el patrón de RLS por tabla, el enum de Postgres como guardia real a nivel de BD, `tenantMetricsMiddleware` (cobertura automática de salud/métricas para cualquier módulo sin tocar nada), y la UI del panel de plataforma para módulos por tenant/usuario (ya era 100% data-driven, nunca tuvo una lista hardcodeada de módulos).

---

## El problema, con evidencia concreta

Antes de este cambio, registrar un módulo requería tocar a mano:

1. `migrations/0008_platform_modulos.sql` (después, cualquier migración que ampliara el enum `modulo_erp`).
2. `MODULOS_ERP` en `src/server/schemas/platform.schema.ts` — con un comentario literal diciendo "mantenerlos sincronizados".
3. `routes/index.ts` — un `router.use("/x", requireModulo("x"), xRoutes)` por módulo.
4. `Sidebar.tsx` — un array `TODAS_LAS_PESTAÑAS` hardcodeado.
5. `App.tsx` — un union type + un `if` por pestaña.

Nada fallaba si alguno de los 5 quedaba desactualizado. Resultado real: Equipos, Checklists e IPERC (migrations `0006`/`0007`, con RLS, permisos por rol y rutas completas) nunca llegaron a `Sidebar.tsx` ni a `App.tsx` — invisibles para cualquier usuario del ERP desde que se crearon, hasta este cambio.

Otros dos gaps encontrados durante el diagnóstico:

- **Backup/restore**: `TABLAS_TENANT` en `platformBackup.service.ts` era un array mantenido a mano. Un módulo nuevo cuyas tablas no se agregaran ahí quedaba fuera del backup **en silencio** — sin error, solo sin exportar esas filas.
- **Auditoría**: `registrarAuditoria()` solo se usaba en `platform.service.ts`. Ningún módulo de negocio (ni los 4 viejos ni los 3 nuevos) auditaba create/update/delete — el panel de plataforma podía ver _sus propias_ acciones, pero nada de lo que pasaba dentro de un tenant.

---

## Decisiones

### 1. Registro del módulo

**Decisión**: `src/modules/registry.ts` es la fuente de verdad en código. Cada entrada (`ModuloDefinicion`, ver `src/modules/types.ts`) declara `id`, `label`, `icono`, `version`, su `router` de Express, y sus tablas de backup (`tablas` + `raices`, ver más abajo). De ahí se derivan:

- `MODULOS_ERP` en `platform.schema.ts` (para validación con Zod) — antes era una constante hardcodeada.
- El montaje de rutas en `routes/index.ts` — antes era un `router.use()` por módulo escrito a mano.
- `TABLAS_TENANT` y el orden de wipe en `platformBackup.service.ts` — antes eran arrays hardcodeados.

**El enum `modulo_erp` de Postgres sigue existiendo aparte, a propósito.** No se generó dinámicamente desde el registry porque da algo que TypeScript no puede dar: un `CHECK` real a nivel de base de datos, que sigue protegiendo `tenant_modulos`/`usuario_modulos` incluso si algún día algo escribe ahí sin pasar por el código de la app. El costo de mantener dos listas se paga con `tests/module-registry.test.ts` (ver más abajo), no evitándolo.

**Versionado**: `version` es un string libre por módulo en el registry (hoy: `"v1"` en los 8). Es la misma semántica que ya existía en `tenant_modulos.version` (migración `0021`) — puramente informativo, ningún consumidor de `modulosPermitidos` lo lee todavía. No se construyó nada más elaborado (semver, migraciones de versión) porque nadie lo necesita hoy — ver "Fuera de alcance".

### 2. Base de datos

**Convención** (ya existía, ahora reforzada por test): toda tabla de negocio de un módulo lleva `tenant_id UUID NOT NULL REFERENCES tenants(id)`, incluidas las tablas "hijas" de detalle (no solo el header) — así RLS aplica parejo sin depender de que cada query haga JOIN hasta el padre. Índice `idx_<tabla>_tenant_id` en cada una. Un módulo nuevo agrega su propia migración `NNNN_nombre_del_modulo.sql`.

**RLS desde el día uno — ahora garantizado por test, no por convención.** `tests/rls-coverage.test.ts` recorre `pg_class`/`pg_policies` directamente (no una lista mantenida a mano) y falla si aparece una tabla con `tenant_id` sin `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + una policy `tenant_isolation`, salvo que esté en una allowlist explícita y documentada (las tablas de plataforma que a propósito no tienen RLS: `tenant_modulos`, `platform_audit_log`, `tenant_scim_config`, `refresh_tokens`, `reset_tokens`, `tenant_metricas_horarias`, `tenant_backups`, `tenant_sso_config`). Antes de este test, que una tabla nueva tuviera RLS dependía 100% de que el desarrollador copiara el bloque `DO $$ ... $$` de una migración anterior.

**Backup/restore automático.** Cada módulo declara `tablas: TablaBackupMeta[]` (nombre, tipo de PK, columnas `GENERATED` a excluir al restaurar, y sus FKs hacia otras tablas del mismo backup) en orden seguro de INSERT — padres antes que hijos. `platformBackup.service.ts` concatena `usuarios` (núcleo de auth, no es de ningún módulo) + las tablas de todos los módulos, en el orden del registry. El wipe (`vaciarDatosDeTenant`) usa `raices` — el subconjunto de tablas de un módulo que necesita `DELETE` explícito porque no cascadea desde otra tabla del mismo backup — invertido automáticamente (invertir un orden válido de INSERT siempre da un orden válido de DELETE). Un módulo nuevo que declare mal sus tablas ya no rompe el backup en silencio: si `raices` referencia un nombre que no está en `tablas`, `tests/module-registry.test.ts` lo detecta.

### 3. Permisos y features

**Sin cambios en el mecanismo, ya funcionaba bien**: `requireModulo(id)` sigue siendo el gate a nivel de router — bloquea el módulo entero si `usuario.modulosPermitidos` (intersección `tenant_modulos ∩ usuario_modulos`, calculada en login/refresh) no lo incluye. `requireRole(...)` sigue siendo el control fino por ruta dentro de un módulo (ej. `admin` para borrar, `admin`+`operador` para crear).

**Sub-features**: no existe un mecanismo dedicado, y se decidió **no construir uno** en esta ronda — ver "Fuera de alcance". Hoy la granularidad más fina que un módulo completo es el rol por ruta (`requireRole`), que ya cubre el caso real que existe (ej. solo `admin` aprueba/rechaza un IPERC).

### 4. Backend

**Estructura de carpetas** (ya existía, se formaliza como parte del contrato): `src/modules/<id>/<id>.routes.ts` + `.controller.ts` + `.service.ts` + `.repository.ts`. El `router` de `<id>.routes.ts` es lo único que el registry necesita importar.

**Montaje de rutas**: automático, vía `for (const modulo of MODULOS) router.use(`/${modulo.id}`, requireModulo(modulo.id), modulo.router)` en `routes/index.ts`. Agregar un módulo ya no toca este archivo.

**Auditoría — nueva, parte de este contrato.** `src/server/shared/utils/moduleAudit.ts` expone `contextoAuditoriaModulo(req)`, que arma un `ContextoAuditoria` con el nuevo `actorType: "tenant_usuario"` (migración `0030`, extiende el `CHECK` de `platform_audit_log`). Todo `create`/`update`/`delete`/cambio de estado en Equipos, Checklists e IPERC ahora llama `registrarAuditoria(...)` con ese contexto — antes ningún módulo de negocio dejaba rastro. `detalle` lleva solo ids/referencias, nunca contenido de negocio, mismo criterio que ya usaba `platform.service.ts`.

### 5. Frontend

**Registro**: `client/src/modules/registry.tsx` — un archivo sin lógica, solo `{ id, label, icono, componente }` por módulo. `id` debe coincidir con el `id` del registry del backend (con un enum de 7 elementos, mantenerlo a mano no es un problema real hoy; ver "Decisiones forzadas por código vs. convención" sobre por qué no se comparte el archivo entre server y cliente).

**Menú**: `Sidebar.tsx` ya no tiene un array hardcodeado — itera `MODULOS_CLIENTE` filtrado por `usuario.modulosPermitidos`, igual que antes pero data-driven.

**Lazy loading**: cada `componente` en el registry es un `React.lazy(() => import(...))`. `App.tsx` busca el módulo activo por `id` y lo renderiza dentro de `<Suspense>`. Verificado con `vite build`: cada módulo (`EquiposTable`, `ChecklistsView`, `IpercView`, `Dashboard`, etc.) generó su propio chunk — el código de un módulo que un usuario no tiene habilitado, o que no abrió, no viaja a su navegador.

**Convención de rutas del cliente**: no hay router (SPA de una sola vista con tabs, decisión ya tomada antes de este ADR — ver `password_reset_audit_platform_ui`, que evaluó agregar uno solo para `/reset-password` y decidió no hacerlo). Un módulo nuevo no necesita rutas de cliente, solo un `id` en el registry.

### 6. Panel de plataforma

**Ya cumplía el contrato antes de este ADR — no se tocó.** `client/src/platform/TenantDetalleView.tsx` obtiene la lista de módulos de un tenant desde `GET /api/platform/tenants/:id/modulos` (que a su vez lee `MODULOS_ERP`, ahora derivado del registry) — nunca tuvo una lista hardcodeada en el cliente. Un módulo nuevo aparece automáticamente en el panel apenas existe en el registry + su migración de enum, sin tocar el frontend de plataforma.

**Rollout y versión**: ya soportado desde la migración `0021` (`estado`: habilitado/deshabilitado/rollout con `rollout_porcentaje`, bucketing determinístico por tenant+módulo+usuario; `version`: string libre). Sin cambios en este ADR.

### 7. Observabilidad y operación

**Métricas — ya automático, no se tocó.** `tenantMetricsMiddleware` cuelga del router genérico en `routes/index.ts`, antes de `requireModulo`, así que registra tráfico (incluidos los 403 de módulo no habilitado) para cualquier módulo sin que este declare nada. `obtenerSaludTenantService` (`platformTenantHealth.service.ts`) sigue siendo por tenant, no por módulo — un módulo nuevo queda cubierto por el mismo mecanismo sin código adicional.

**Auditoría de acciones**: ver sección 4 (Backend) — `contextoAuditoriaModulo` + `registrarAuditoria` es lo que un módulo debe llamar en cada mutación.

**Métrica mínima que un módulo debe exponer**: ninguna adicional — el tráfico/errores/recursos-creados de `tenantMetricsMiddleware` ya es automático por diseño de middleware, no algo que cada módulo tenga que declarar.

### 8. Offline-first (opcional por módulo)

Agregado después de la primera versión de este ADR, al construir el offline de Checklists (migración `0044`). Un módulo cuyas escrituras puedan pasar sin señal confiable puede declararse elegible para la cola offline del cliente. Es **opcional y explícito**: un módulo que no lo declare se comporta como siempre — sus escrituras fallan si no hay red.

**Por qué esto no es "campo vs. oficina".** El ERP es para operaciones mineras — campamentos y plantas rurales, no oficinas urbanas. La señal inestable no es exclusiva de un operario en la cancha: una PC administrativa en el mismo campamento tiene el mismo problema. Por eso el criterio de elegibilidad de abajo NO es "¿dónde se usa este módulo?" — es puramente técnico: **¿la mutación es idempotente y su reintento es seguro?** Un módulo entero puede tener partes que califican y partes que no (ver IPERC más abajo). La ubicación de quien lo usa no es parte del criterio.

**El motor es genérico; el módulo solo declara.** `client/src/offline/` (cola en IndexedDB, detección de conexión, drenaje al reconectar) no tiene ninguna lista de rutas propia: lee `offline.escrituras` del registry. Sumar un módulo es agregar ese bloque en los dos registries, nada más — mismo criterio que `tablas` o `cuota`.

**Requisito no negociable para declarar una ruta:** el servicio que la atiende tiene que pasar por `idempotentInsert()` (`src/server/shared/utils/idempotentInsert.ts`), y su schema Zod aceptar `cliente_uuid` opcional. Encolar una escritura que NO sea idempotente es peor que no tener offline: el reintento crea un duplicado en silencio. Por eso la declaración es por ruta y no "todo POST de este módulo".

**Cómo funciona la idempotencia, en una línea:** el dispositivo genera un `crypto.randomUUID()` al momento de guardar (online u offline), viaja como `cliente_uuid` en el body, y el servidor lo reserva en `idempotency_keys` dentro de la MISMA transacción que crea la fila. Un reintento con esa clave devuelve `200` con la fila que ya existía en vez de crear otra. La tabla es aparte y no una columna con `UNIQUE` porque `checklists`/`ipercs` están particionadas y Postgres exige la columna de partición en todo índice único — ver el comentario largo de `migrations/0044_idempotency_keys.sql`.

**Qué NO calificar**, con el criterio que se usó en los 4 módulos ya implementados:

- **Lecturas (GET)**: no se encolan nunca. Lo que hace falta para llenar un formulario sin red se resuelve cacheando catálogos en el service worker (`runtimeCaching` en `client/vite.config.js`), no en la cola.
- **DELETE**: reintentar un borrado puede eliminar algo que se recreó entre medio.
- **Transiciones de estado** (aprobar, rechazar, cambiar de fase): no son creaciones, son "aplicar esto SI el estado actual todavía es X". Encolar una a ciegas hace que un reintento tardío pise una decisión más nueva, o se aplique sobre un estado que ya cambió — el mismo problema de fondo que `fix_race_condition_iperc_estado` resolvió para requests concurrentes, aplicado ahora a requests _tardías_.
- **Escrituras que sobreescriben un valor absoluto** (no acumulan): si dos lecturas pueden llegar fuera de orden (una offline, tomada horas antes, sincronizando después de una online más reciente), la vieja pisa a la nueva en silencio — no es un duplicado detectable por `idempotentInsert()`, es corrupción de dato real. Antes de declarar una ruta así, hay que pasar el modelo a histórico append-only (ver Combustible más abajo).
- **Configuración de catálogo** (plantillas, líneas base): hoy se edita con poca frecuencia y no es parte del flujo que se interrumpe por falta de señal en el momento — pendiente de reevaluar si en el futuro alguien necesita crear/editar una plantilla sin red (ver "Fuera de alcance").

**Aislamiento en dispositivo compartido** (tablet de planta, el caso normal): IndexedDB y el caché del service worker son **por origen**, no por sesión. Cada entrada de la cola se estampa con su `usuarioId` y solo se drena bajo esa sesión (si no, el servidor firmaría el checklist con el usuario que sincronizó, no con el que lo llenó), y los catálogos cacheados se borran al cerrar sesión (RLS blinda la base, no el caché del navegador). Ver `client/src/offline/sesionOffline.ts`.

**Pasos concretos** (además del checklist de abajo):

1. Migración: nada — `idempotency_keys` ya existe y es genérica. Solo hay que asegurarse de que el `id` del módulo esté en el enum `modulo_erp` (ya lo exige el paso 1 del checklist).
2. Schema Zod: `cliente_uuid: z.string().uuid().optional()`.
3. Servicio: envolver la creación en `idempotentInsert({ client, tenantId, modulo, clienteUuid, insertar, recuperar })`. El `client` debe venir de un `withTenant()` — la garantía depende de que la clave y la fila commiteen juntas.
4. Controller: si `creado === false`, responder `200` con la fila existente y **no** volver a llamar `registrarAuditoria` ni `publicarEventoTenant` (ya se hizo en el intento original).
5. Declarar las escrituras en los dos lados: `offline: { escrituras: [...] }` en `src/modules/registry.ts`, y una entrada en `ESCRITURAS_OFFLINE` de `client/src/modules/offlineRegistry.ts`. (Del lado del cliente vive en un `.ts` aparte y no dentro de `registry.tsx`: ese archivo es JSX, y tanto el motor offline como el test que compara ambos lados corren donde no hay JSX configurado.)
6. La vista genera `cliente_uuid: crypto.randomUUID()` al armar el body, y trata el `202` de `apiFetch` como "guardado, pendiente de enviar".
7. `npx vitest run tests/offline-registry.test.ts` — falla si los dos registries divergen.

**Los 7 módulos ya implementados, como ejemplo real** (en el orden en que se construyeron — cada uno agregó un caso que el anterior no tenía):

- **Checklists** (PR #71, caso base): una sola escritura, `POST /` (crear el checklist lleno). Las plantillas quedan fuera — configuración de catálogo, ver criterio de arriba. `src/modules/registry.ts` línea ~152 y `offlineRegistry.ts` clave `checklists`.
- **IPERC** (PR #72, agrega la exclusión de transiciones de estado): también `POST /`, pero el módulo tiene más rutas de escritura que Checklists (aprobar, rechazar) y **ninguna de esas se declara**. Aprobar/rechazar es una transición de estado, no una creación — encolarla choca con la misma clase de problema que resolvió `fix_race_condition_iperc_estado` (dos decisiones pisándose), solo que acá la carrera es contra el tiempo en vez de contra otra request simultánea. Ver el comentario en `registry.ts` línea ~194.
- **Combustible** (PR #73, agrega el caso "hay que cambiar el modelo primero"): el endpoint original, `PUT /:id/nivel`, sobreescribía un valor absoluto — sincronizar una lectura offline tomada horas antes, después de una lectura online más reciente, habría pisado el dato bueno con uno viejo. No es un problema que `idempotentInsert()` resuelva (no es un duplicado, es una lectura distinta y válida, solo que desordenada). La migración `0045_combustible_lecturas.sql` pasó el modelo a histórico append-only (`combustible_lecturas`, cada fila es una lectura con su timestamp, el nivel "actual" se deriva de la más reciente por fecha) — recién ahí calificó, con `POST /lecturas`. **Este es el patrón a repetir** en cualquier módulo futuro que hoy sobreescriba un campo en vez de acumular historial.
- **Documentos** (agrega el caso "un módulo con varias escrituras, solo ALGUNAS califican" y el de archivo binario): `POST /` (crear el registro — cubre también pólizas, SOAT, etc., que son solo `documentos` con otro `nombre_documento`, no un tipo aparte) y `POST /:id/versiones` (subir el archivo adjunto). Documentos no tenía schema Zod en absoluto antes de esto (`src/server/schemas/documentos.schema.ts` es nuevo) — sumar offline fue también la primera vez que su `POST /` quedó validado. Las otras 2 escrituras del módulo se auditaron y **no calificaron**: `PUT /:id` edita campos existentes (mismo riesgo de sobreescritura que tenía Combustible) y `POST /bulk` es carga masiva desde Excel (flujo de oficina, array grande).
- **Repuestos** (PR #82/#83, agrega el caso "delta en vez de lectura absoluta" y el de rechazo persistente): `POST /movimientos` (entrada/salida de stock). A diferencia de Combustible, un movimiento es un DELTA (+N/-N) y sumar deltas es conmutativo — `repuestos.stock` se actualiza con `UPDATE stock = stock + delta` SIN comparar ningún timestamp, no hizo falta pasar a histórico append-only para que calificara. `PUT /:id` (edita el catálogo) y `POST /bulk` (carga masiva) se auditaron y **no calificaron**, mismo motivo que Documentos. Una salida que dejaría el stock negativo se RECHAZA (409) en vez de permitirse — y el rechazo queda persistido con `estado = 'rechazado'` en vez de simplemente no insertarse: un rechazo silencioso, sin fila, dejaba a un técnico offline sin ningún rastro (ni servidor ni dispositivo, ver el punto de `EstadoOffline.tsx` más abajo) de un movimiento que físicamente sí pasó. Repuestos también fue el primer módulo con **cuota en más de un recurso** (`cuotasPorRuta` — el catálogo y el histórico de movimientos se miden por separado); ver [cuotas-por-tenant.md](../architecture/cuotas-por-tenant.md) para ese mecanismo, que es de cuotas y no de offline en sí.
- **Órdenes de Trabajo** (migración `0049`, agrega el caso "declarar offline desde el día 1 del módulo" en vez de sumarlo en una sesión aparte, como habían hecho los cinco anteriores): `POST /` (crear la OT). Es de los casos más claros del ERP para trabajar sin señal — el equipo se rompe en cancha, se abre la OT ahí mismo — y el costo marginal fue bajo porque `idempotentInsert()`+`cliente_uuid` ya se construían igual para la Capa B anti-doble-clic (sección 9). `PATCH /:id/estado` (iniciar/completar/cancelar) **no calificó**, mismo motivo que aprobar/rechazar en IPERC (transición de estado, no creación); `PUT /:id` (editar título/prioridad/asignado/etc.) tampoco, mismo motivo que Combustible antes de 0045 (sobreescribe valores existentes).
- **Equipos** (PR #94, agrega el caso "el módulo más chico posible" — CRUD simple, sin bulk, sin archivo, sin transición de estado): solo `POST /` (dar de alta el equipo). `PUT /:id` y `DELETE /:id` **no calificaron**, mismo motivo de siempre (editar sobreescribe, borrar no debe reintentarse a ciegas). Como Documentos, no tenía schema Zod antes de esto — `src/server/schemas/equipos.schema.ts` es nuevo, y `POST`/`PUT` quedaron validados de una. Aportó un matiz de redacción, no de arquitectura: el mensaje genérico de "sin conexión, quedó guardado en este equipo" (que usan los demás módulos, donde "equipo" significa "dispositivo") es ambiguo acá porque el propio recurso que se crea también se llama "equipo" — se sustituyó por "este dispositivo" solo en `EquiposTable.tsx`, sin tocar el resto del patrón.

Ningún módulo de los 7 llegó completo a offline — en cada uno, algunas escrituras calificaron y otras no. Ese es el resultado esperado del criterio de la sección de arriba, no una limitación pendiente de resolver.

**El descarte de una escritura rechazada por el servidor (no por falta de red) también puede perder evidencia si no se persiste del lado del recurso.** `esErrorPermanente()` (`client/src/offline/offlineSync.ts`) trata cualquier 4xx salvo 401/408/429 como rechazo definitivo: la entrada sale de la cola sin reintentar y se reporta en `descartadas`, que `EstadoOffline.tsx` muestra como un banner. Ese banner es puro estado en memoria del navegador (`useState`, no IndexedDB ni servidor) — si el operario no lo lee antes de cerrar la pestaña, la información desaparece. El motor es correcto para el caso general (un 400 de validación no necesita persistirse en ningún lado, el dato nunca fue válido), pero un 409 de conflicto de negocio (como el de Repuestos) sí representa algo que pasó de verdad — para esos casos, el recurso mismo tiene que dejar su propio rastro server-side (ver `estado` en `repuestos_movimientos`, migración `0048`), el motor offline genérico no lo va a hacer por ningún módulo.

**Archivo adjunto de Documentos: el primer caso con archivo binario, no JSON.** El motor original asumía que toda escritura encolable era JSON (`EntradaCola.body: string`) y toda ruta offline era literal (`rutasOffline.ts` no matcheaba segmentos de URL como `:id` — por eso Combustible movió `combustible_id` al body en vez de la URL). Subir el archivo adjunto de un documento (`POST /:id/versiones`) no encaja en ninguna de las dos asunciones, y en vez de repetir el workaround de "mover el id al body" una tercera vez, se extendió el motor genéricamente:

- `rutasOffline.ts`: `segmentosCoinciden()` matchea un segmento de patrón que empieza con `:` contra cualquier valor concreto en esa posición. El id real sigue viajando completo en la URL guardada (`EntradaCola.url`) — el comodín solo decide si la ruta CALIFICA, no participa del reenvío. Sirve para cualquier módulo futuro con rutas anidadas (ej. el `PUT /:id` que eventualmente tengan Equipos/Repuestos).
- `offlineQueue.ts`: `EntradaCola.body` (string JSON) y el nuevo `EntradaCola.formData` (`CampoFormData[]`) son mutuamente excluyentes. IndexedDB clona `Blob` nativamente (structured clone), así que el archivo entero se guarda tal cual, sin pasar por base64.
- `apiClient.ts`: `leerClienteUuid()` ahora también lee de un `FormData` (`body.get("cliente_uuid")`), y el catch de `apiFetch()` arma `formData` en vez de `body` cuando la request original era `FormData` (ver `formDataAEntradas()`).
- `offlineSync.ts`: al reintentar, `initDeEntrada()` reconstruye el `FormData` real desde `formData` y NO fija `Content-Type` a mano — fetch() arma el boundary del multipart solo.

**Dos decisiones de alcance para este caso, tomadas a propósito:**

1. **Sin encadenar colas.** En teoría, subir un archivo depende de que el documento ya exista con un id real — si la creación del documento (Caso A) todavía está encolada sin sincronizar, ese id no existe. No se construyó ninguna lógica para resolver esa dependencia porque, en la UI actual, es físicamente imposible llegar al flujo de "subir archivo" para un documento que no volvió del servidor: `DocumentosTable.tsx` solo lista documentos ya sincronizados, y el botón que abre el modal de subida solo existe en filas de esa tabla.
2. **Un reintento sube el archivo al storage una segunda vez antes de que `idempotentInsert()` detecte el duplicado** (la subida a R2/disco pasa primero a propósito, afuera de la transacción — no tiene sentido bloquear Postgres esperando una llamada de red). Eso deja un archivo huérfano en el storage en el caso raro de un reintento real. Se aceptó sin agregar una verificación previa (que sumaría su propia condición de carrera) porque `documentos.service.ts` ya acepta el mismo tipo de huérfano en `delete()` — mismo criterio, ya validado en este archivo.

### 9. Protección contra doble submit

Agregado después de encontrar el hueco en los 4 módulos que ya escribían (PR #75). Es una sección aparte de la 8 y no una subsección, porque **también aplica a formularios que NO participan del offline**.

#### El problema, y por qué la idempotencia sola no lo cubre

Un doble clic —o un doble tap en una tablet de campo, con guantes y pantalla lenta— creaba **dos registros reales**. Y no era un bug de `idempotency_keys`: el cliente generaba un `cliente_uuid` nuevo **dentro del handler de submit**, así que cada clic mandaba una clave distinta. El servidor compara la clave, no el contenido, y dos claves distintas son dos registros legítimamente distintos.

Eso **tiene que ser así**: es exactamente lo que permite que dos operarios llenen un checklist del mismo camión en el mismo turno. El servidor no puede —ni debe— distinguir un dedo torpe de dos inspecciones reales. La distinción tiene que hacerla el cliente.

#### Las dos capas, y por qué ninguna alcanza sola

**A — Bloquear el botón** (lo que el operario ve). Un estado `guardando`/`enviando`, un `if (guardando) return` al entrar al handler, y `disabled` en el botón de submit.

> **El reset va en un `finally`, no al final del `try`.** Si `apiFetch` _tira_ (sin red y con una ruta que no se encola), sin `finally` el botón queda trabado para siempre y el operario tiene que recargar la app para poder seguir trabajando. Es un error fácil de cometer y difícil de notar, porque solo aparece sin señal.

Esta capa da feedback inmediato, pero **solo achica la ventana**: si los dos taps entran antes de que React re-renderice, pasan los dos. Y el `Enter` sobre el formulario es otro camino al mismo submit.

**B — Fijar el `cliente_uuid` al ABRIR el formulario** (lo que garantiza). Se genera una sola vez al abrir el modal, vive en el estado del componente, y se reutiliza en todos los submits de esa instancia. Así los dos envíos comparten clave y la idempotencia del servidor los une.

> **Se REGENERA en cada apertura.** Este es el filo del patrón: si el uuid quedara pegado entre aperturas, el segundo registro legítimo del turno chocaría contra la clave del primero y el servidor devolvería aquel **en silencio** — se perdería un registro sin dejar rastro. Eso es peor que el duplicado que se está evitando.

#### La regla

Todo formulario de **creación** lleva la capa A. Los que además usan `cliente_uuid` llevan también la B.

**Los que NO usan `cliente_uuid` no quedan exentos** — al contrario. En las plantillas de checklist y las líneas base de IPERC (catálogo de oficina, no participan del offline), la capa A es la **única** defensa posible contra el doble clic. Que no haya una capa B que las respalde las hace _más_ dependientes de bloquear el botón, no menos.

#### La excepción razonada: subir un archivo

`subirArchivo()` en Documentos genera el uuid **por invocación**, no al abrir el modal, y es deliberado. Se dispara desde el `onChange` de un `<input type="file">`: un tap de más abre el selector de archivos, no manda dos veces. Y atarlo al modal haría que subir **dos versiones distintas** del mismo documento sin cerrar el panel se deduplicara contra sí misma — la segunda se perdería, que es justo lo contrario de lo que se espera de un historial de versiones. Ahí va solo el guard de reentrada.

Aplicar la receta a ciegas habría roto ese flujo. Cuando un formulario no encaja, el criterio es preguntarse **qué representa una repetición para el usuario**: en un modal de creación, dos envíos son un accidente; en un selector de archivos, dos selecciones son dos intenciones.

#### Dónde vive cada cosa

- Generación del uuid: en el **estado del componente**, en el handler que abre el modal. Nunca dentro del handler de submit.
- Idempotencia del lado del servidor: `idempotentInsert()` + declaración en los dos registries (ver sección 8).

#### Test obligatorio

Un módulo que agregue creación con `cliente_uuid` necesita un e2e que abra el modal, **dispare dos submits**, afirme que se envió **exactamente el mismo** `cliente_uuid`, y después cierre, reabra y afirme que se generó **uno distinto**.

Las dos mitades son obligatorias: la primera prueba que no duplica, la segunda que no pierde registros. Ver `e2e/capa-b-cliente-uuid.spec.ts`, que además documenta por qué se hace interceptando con un 500 (mantiene el modal abierto, no depende del timing de los clics y no ensucia la base) y por qué necesita `serviceWorkers: "block"`.

**Un test de servidor no sirve para esto.** `tests/idempotencia-offline.test.ts` prueba "el mismo `cliente_uuid` dos veces ⇒ una sola fila" — y eso ya pasaba **con el bug puesto**. Lo que estaba roto era que el cliente mandaba uuid distintos, y eso solo se ve desde el navegador.

### 10. Checklist de "Nuevo Módulo"

1. Migración `NNNN_<nombre>.sql`: tablas con `tenant_id NOT NULL REFERENCES tenants(id)` (header e hijas), índices, bloque RLS (`ENABLE` + `FORCE ROW LEVEL SECURITY` + policy `tenant_isolation` — copiar el bloque `DO $$` de `migrations/0006` o `0007`), y `ALTER TYPE modulo_erp ADD VALUE '<id>'`.
2. `src/modules/<id>/`: `routes.ts` + `controller.ts` + `service.ts` + `repository.ts`, siguiendo el patrón de un módulo existente (ej. `equipos/`).
3. Controllers: cada `create`/`update`/`delete`/cambio de estado llama `registrarAuditoria({ accion: "<id>.<accion>", tenantId, usuarioId: req.usuario!.id, detalle: { ...solo ids }, contexto: contextoAuditoriaModulo(req) })`.
4. Agregar el módulo a `src/modules/registry.ts`: `id` (igual al valor del enum del paso 1), `label`, `icono`, `version`, `router`, `tablas` (orden seguro de INSERT, con `fks` si referencia tablas de otro módulo), `raices` (subconjunto que necesita DELETE explícito al vaciar un tenant).
5. Agregar el módulo a `client/src/modules/registry.tsx`: mismo `id`, `label`, `icono`, `componente: lazy(() => import(...))`.
6. Construir la pantalla en `client/src/components/<id>/`.
   6b. **Evaluar offline para cada escritura del módulo, siempre** (no solo si "se usa en campo" — en un ERP minero rural, la señal es inestable en toda la operación, no solo en la cancha; ver sección 8). Para cada `POST`/`PUT`/`PATCH`: si es una creación idempotente-viable, declararla siguiendo los pasos de la sección 8. Si no califica (transición de estado, sobreescribe un valor absoluto, DELETE, o el trabajo de volverla idempotente no se justifica todavía), dejar una línea en el PR explicando por qué no — igual que se documentó para aprobar/rechazar en IPERC. Ningún módulo queda bloqueado por esto: lo que no se declara sigue exigiendo red, como siempre.
   6c. **Proteger cada formulario de creación contra el doble submit** (ver sección 9). Capa A —botón bloqueado con el reset en un `finally`— en TODOS, incluidos los que no participan del offline, donde es la única defensa. Capa B —`cliente_uuid` fijado al abrir el modal y regenerado en cada apertura— en los que sí usan `cliente_uuid`. Y el e2e de las dos mitades que exige esa sección.
7. Correr `npm run migrate`, luego `npx vitest run tests/module-registry.test.ts tests/rls-coverage.test.ts` — deben pasar antes de tocar nada más. Después, la suite completa.
8. `npm run build` en `client/` y confirmar que el módulo nuevo generó su propio chunk (code-splitting).
9. Smoke test manual: login, el módulo aparece en el Sidebar, CRUD básico funciona, sin errores en consola.
10. El panel de plataforma (`/plataforma`) ya lo va a mostrar solo — no requiere ningún cambio si los pasos 1 y 4 están bien hechos.

---

## Decisiones forzadas por código vs. dejadas como convención

**Forzado por código (falla un test o el tipo no compila si se rompe):**

- Que `MODULOS_ERP` (código) y el enum `modulo_erp` (BD) coincidan exactamente — `tests/module-registry.test.ts`.
- Que toda tabla con `tenant_id` tenga RLS completo, salvo allowlist explícita — `tests/rls-coverage.test.ts`.
- Que `raices` de un módulo sea subconjunto de `tablas` — mismo test de arriba.
- Que las rutas de un módulo respeten `requireModulo` — estructural, viven dentro del loop de `routes/index.ts`, no hay forma de montarlas sin pasar por ahí.
- Que la declaración `offline` del registry del backend y la del cliente coincidan exactamente — `tests/offline-registry.test.ts`. Es el único punto de duplicación deliberado que sí se testea, porque divergir acá no rompe nada visible: el cliente encolaría una ruta que el servidor no atiende con `idempotentInsert()` y el reintento duplicaría en silencio.

**Dejado como convención (nada lo hace cumplir automáticamente):**

- Que el `id` del registry del cliente coincida con el del backend — un typo ahí produce un módulo que el backend permite pero el Sidebar nunca muestra (el mismo bug que originó este ADR, pero ahora acotado a un solo archivo de una sola línea por módulo, en vez de repartido en 3).
- Que un controller llame `registrarAuditoria` en cada mutación — no hay lint que lo exija, ni nada genérico que cubra un módulo nuevo automáticamente. Se decidió no automatizarlo (ej. con un middleware genérico) porque `detalle` necesita criterio humano por acción (qué ids son relevantes, qué NO incluir). Lo más cerca que hay es `tests/auditoria-mutaciones.test.ts`, que verifica módulo por módulo — hoy cubre 6 de los 7 (falta Órdenes de Trabajo, que sí audita en su controller pero no tiene test ahí), y hay que acordarse de sumar el módulo nuevo a mano.
- Que un formulario de creación proteja contra el doble submit (sección 9). Está probado **solo en Checklists** (`e2e/capa-b-cliente-uuid.spec.ts`); en IPERC, Combustible y Documentos el patrón está implementado pero nada lo vigila. No se generalizó el e2e a los cuatro porque lo que cambia en cada módulo es cómo se llena el formulario, no la garantía — y un spec parametrizado que hay que ajustar módulo por módulo no es más barato que cuatro específicos. Si un módulo nuevo se olvida de la capa B, el fallo es silencioso: dos registros donde debería haber uno.
- El orden de `tablas`/`raices` dentro de un módulo respeta las FK reales — si un desarrollador declara un orden incorrecto, el error aparece recién al _restaurar_ un backup (INSERT falla por FK), no antes. Aceptado porque backup/restore ya corre dentro de una transacción (`withTenant`) — un orden incorrecto falla ruidoso, nunca deja datos a medias.

## Fuera de alcance de esta primera versión

- ~~**No se retrofitó auditoría a Repuestos/Combustible/Documentos**~~ — **cerrado (2026-08-14)**. Los tres módulos viejos ya auditan todas sus mutaciones (Repuestos: crear/actualizar/eliminar/carga masiva/registrar movimiento; Combustible: registrar lectura y el `PUT /:id/nivel` legacy; Documentos: crear/actualizar/eliminar/carga masiva/subir versión), con dos criterios que fija este retrofit y que valen para cualquier módulo futuro: (a) **una carga masiva audita UNA fila con el conteo**, no una por registro — la pregunta que se le hace después a la auditoría es "quién importó y cuánto", y una fila por registro solo inunda `platform_audit_log`; (b) **un rechazo que igual persiste una fila se audita con `resultado: "failure"`** (movimiento de stock rechazado, `migrations/0048`), mismo criterio que `cuota.bloqueo` — es una mutación real y además la señal operativa que interesa ver. Dashboard sigue sin auditar nada porque no muta nada.
- **No se construyó un sistema de sub-features** dentro de un módulo (feature flags por función, no por módulo completo). Nadie lo necesita hoy — el rol por ruta (`requireRole`) cubre el único caso real (aprobar/rechazar IPERC solo por `admin`).
- **No se generó el enum `modulo_erp` dinámicamente desde el registry** — sigue siendo una migración manual por módulo nuevo, a propósito (ver Decisión 1).
- **No se compartió un único archivo de registry entre backend y cliente** — son dos builds de Vite/tsx separados; forzar un import cruzado (`client/` importando de `src/modules/registry.ts`, que a su vez importa Express/pg) habría sido más complejidad que el problema que resuelve, para un set de 8 módulos.
- **Las pantallas de Checklists e IPERC son mínimas, no el flujo completo**: cubren listar, crear (plantilla/línea base/checklist/IPERC con ítems manuales) y aprobar/rechazar/eliminar. No cubren editar una plantilla o línea base existente, ni el flujo de "referenciar un ítem ya aprobado de la línea base" al crear un IPERC específico (el backend ya lo soporta vía `linea_base_item_id`, la UI no lo expone todavía) — se dejó así para no inflar el alcance de esta ronda; el backend no tiene ninguna limitación pendiente, es trabajo de UI puro cuando alguien lo necesite.
- **El offline está declarado en los 7 módulos de negocio del ERP** (Checklists, IPERC, Combustible, Documentos, Repuestos, Órdenes de Trabajo y Equipos — sección 8) — incluido el archivo adjunto de Documentos (`POST /:id/versiones`), que motivó extender el motor genérico para soportar rutas con comodín y archivos binarios (`Blob` en IndexedDB en vez de JSON), ver el ejemplo de Documentos en la sección 8. En Documentos, Repuestos y Equipos, específicamente, editar (y en Documentos/Repuestos también la carga masiva) quedaron fuera por razones técnicas concretas, no por estar "menos evaluados" que el resto.
- **No se versiona el comportamiento por `version`** — sigue siendo metadata informativa (igual que antes de este ADR), no algo que el código lea para branchear lógica.

---

## Actualización (noviembre de 2026): `flota` y `viajes`

- **`equipos` pasó a llamarse `flota`** ("Gestión operacional de flota", el módulo central) y se creó el módulo **`viajes`** (migraciones 0165 y 0166, `ALTER TYPE modulo_erp RENAME VALUE`). El enum, las cuotas (`plan_limites`, `tenant_cuotas`) y los accesos de empresas y usuarios se migraron con ese renombre. La URL del módulo NO cambió: `flota` sigue montado en `/api/erp/equipos`.
- **Tres campos nuevos en `ModuloDefinicion`** (`src/modules/types.ts`):
  - `ruta`: dónde se monta bajo `/api/erp`, cuando no coincide con el id (`flota` → `equipos`). El cliente lo replica en `RUTA_DE_MODULO` (`client/src/modules/offlineRegistry.ts`).
  - `requiere`: módulos que la **empresa** debe tener habilitados para que este se vea (`viajes` exige `flota`). Se aplica al calcular los módulos de cada usuario y en el panel de plataforma (por empresa y en el interruptor global).
  - `bucketDe`: con qué id se reparte a los usuarios en un rollout por porcentaje (`viajes` y `flota` reparten como `combustible`).
- **Las rutas de Viajes y Lugares** viven en `src/modules/viajes/viajes.routes.ts`, bajo `/api/erp/viajes`. Las lecturas que traen cargas exigen además el módulo Combustible. Los alias que tuvieron bajo Combustible se retiraron; queda solo `GET /api/erp/combustible/viajes/mi-unidad`, porque Compra en ruta no puede depender de Viajes. Los permisos de pestaña de Viajes siguen bajo el módulo `combustible` (`combustible:viajes`, `combustible:mi_viaje`, `combustible:viajes:consumo`, ...).
- **Las alertas** se agrupan por módulo (Combustible, Urea, Flota; `src/modules/combustible/alertasPorModulo.ts`) y quien no tiene el módulo `viajes` no ve las de viaje.
