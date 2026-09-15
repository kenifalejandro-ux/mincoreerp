# Cuentas, perfiles por empresa y administración con doble firma

Estado: **aprobado por Kenif el 2026-09-14**. Se implementa en seis entregas
(ver al final). Este documento es la referencia de todas; cada PR lo actualiza
si una decisión cambia.

---

## 1. Por qué

Hasta ahora cada usuario vivía **dentro** de una empresa: el correo era único
por empresa (`UNIQUE (tenant_id, email)`, migración 0001) y el login necesitaba
saber de antemano a qué empresa entrar (subdominio, dominio propio o un campo
manual "Empresa", que se quitó en #168).

Eso no alcanza para lo que el ERP va a tener que resolver cuando crezca, y
Kenif pidió dejarlo definido desde ya, "como los grandes ERP":

- Una persona puede tener perfil en **varias empresas** (grupo empresarial con
  dos razones sociales, consultor, auditor, contratista).
- Entra **sin elegir empresa antes**: la empresa sale de su correo, y si tiene
  varias, elige **después** de validar la clave.
- Tiene **una sola clave** para todas.
- Puede **cambiar de empresa sin salir**.
- En cada empresa tiene **permisos distintos** (consultas en una, opera en otra).
- Cada empresa **administra a su propia gente**, y las acciones de
  administración pueden exigir **doble firma**, como el telebanking de un banco.

## 2. Principios

Estos no se negocian en ninguna entrega:

1. **Identidad ≠ perfil.** La *cuenta* es la persona (correo, clave). El
   *perfil* es su lugar en una empresa (nombre, rol, módulos, activo).
2. **El aislamiento entre empresas no cambia.** La empresa de cada request sale
   de la sesión (`tenantMiddleware` → `req.usuario.tenantId`) y RLS filtra por
   ella. Cambiar de empresa es emitir **otra sesión**, nunca abrir una ventana
   entre empresas.
3. **Ninguna empresa ve otra.** Una empresa no puede averiguar si una persona
   tiene perfil en otra: ni al darla de alta, ni al buscarla, ni por un mensaje
   de error distinto. Solo la propia persona ve su lista de empresas.
4. **Quitar permisos es inmediato; darlos pide respaldo.** Es la misma regla
   que el módulo de combustible: endurecer no espera, aflojar se justifica.
5. **Cada empresa decide cómo se entra a ella.** Si una empresa exige su
   Microsoft/Google, esa regla vale al entrar a esa empresa aunque la persona
   tenga clave por otra.
6. **Todo queda auditado: quién y por qué** (ver
   `principio_auditoria_quien_y_porque`). Las acciones de administración
   registran el perfil que actuó, la cuenta detrás y el motivo.

## 3. Dos tipos de gente, dos formas de entrar

| | Administrativo | Operativo |
|---|---|---|
| Ejemplos | gerente, admin, supervisor, auditor | grifero, conductor |
| Entra con | **correo** + clave | **DNI** + clave |
| Identidad | una **cuenta** para todas sus empresas | un acceso **por empresa** |
| Varias empresas | sí, cambia sin salir | no |
| Dónde entra | cualquier dirección del ERP | **siempre la dirección de su empresa** |
| Alta | invitación por correo (entrega 3) | clave temporal, cambio obligatorio |
| Olvidó la clave | se la recupera por correo | se la resetea un admin |

El operativo entra siempre por la dirección de su empresa porque su DNI **no**
es único entre empresas y no existe un campo "Empresa". Es lo natural en
cancha: el ícono instalado en su celular ya viene de esa dirección. Si escribe
su DNI en la dirección general, el sistema le responde *"Entrá desde la
dirección de tu empresa"* en lugar de "credenciales inválidas".

## 4. Modelo de datos

### `cuentas` (nueva, migración 0087)

La persona. **Sin `tenant_id` y sin RLS** — igual que `tenants` o
`platform_admins`: es anterior a cualquier empresa. Solo la lee y escribe el
servicio de autenticación.

| Columna | Qué es |
|---|---|
| `id` | uuid |
| `email` | único en toda la plataforma (en minúsculas) |
| `password_hash` | NULL mientras la persona no definió su clave (invitación pendiente) |
| `debe_cambiar_password` | cambio obligatorio al entrar |
| `activo` | desactivar la cuenta entera: solo MINCORE, desde plataforma |
| `ultimo_tenant_id` | la última empresa elegida, para preseleccionarla |

### `usuarios` pasa a ser el **perfil**

Se agrega `cuenta_id` (NULL para operativos por DNI). Todo lo que hoy cuelga de
`usuarios.id` — sesiones, módulos, auditoría, la cola offline — **sigue
colgando del perfil**. Eso es deliberado:

- **La cola offline** (`offlineQueue.ts`) estampa `usuarioId` en cada operación
  y solo reenvía las del usuario en sesión. Si ese id pasara a ser el de la
  cuenta, una operación cargada en una empresa se reenviaría con la sesión de
  otra. **Tiene que seguir siendo el id del perfil.**
- **`token_version`** sigue en el perfil. Revocar una cuenta entera (cambio de
  clave) es incrementar la versión de **todos sus perfiles**, así el middleware
  de autenticación no cambia.

Reglas del perfil:

- Un perfil con cuenta entra **por la cuenta** (correo). Aunque tenga DNI
  cargado, no entra por DNI.
- Un perfil sin cuenta es operativo: entra por DNI con `usuarios.password_hash`.
- `UNIQUE (tenant_id, cuenta_id)`: una persona tiene **un** perfil por empresa.

`usuarios.email` queda como copia de `cuentas.email` para que el código
existente (listados, auditoría, notificaciones) no cambie. Hoy no existe cambio
de correo; cuando exista, se cambia en la cuenta y se propaga a sus perfiles en
la misma transacción.

### Compatibilidad hacia atrás (expand / contract)

La 0087 **solo agrega**: tabla nueva, columnas nulables, una política de RLS de
lectura, y relaja `NOT NULL` en `usuarios.password_hash` y en
`reset_tokens.usuario_id/tenant_id`. No borra ni endurece nada. El código
anterior sigue funcionando contra la base migrada.

El hash de clave de los perfiles con correo **se copia** a la cuenta y queda
también en `usuarios.password_hash` durante la transición. Una migración
posterior de *contract*, cuando todo corra con el código nuevo, lo pone en NULL
y agrega el `CHECK` de forma (perfil con cuenta **o** operativo con clave).

Si el mismo correo ya existía en varias empresas, la cuenta toma la clave del
perfil actualizado más recientemente. Antes del lanzamiento no hay datos reales
en ese caso.

### Entregas futuras

- **Permisos por perfil (entrega 3):** `usuario_modulos` gana `nivel`
  (`operar` / `consultas`), y la ausencia de fila es "sin acceso".
- **Solicitudes de doble firma (entrega 5):** tabla de solicitudes con
  quién pide, qué cambia (antes y después), motivo, estado, quién firma,
  vencimiento.
- **Seguridad por empresa (entrega 6):** `exigir_sso` en `tenant_sso_config`.
  Hoy SSO es una opción más, nunca obligatoria.

## 5. Cómo se leen los perfiles de una cuenta sin romper RLS

`usuarios` tiene `FORCE ROW LEVEL SECURITY` con la política
`tenant_id = current_setting('app.tenant_id')`. Para listar las empresas de una
persona hace falta leer sus perfiles **en todas** las empresas.

Se agrega una segunda política, **solo de lectura**:

```sql
CREATE POLICY perfiles_de_la_cuenta ON usuarios FOR SELECT
  USING (cuenta_id = NULLIF(current_setting('app.cuenta_id', true), '')::uuid);
```

Las políticas permisivas se combinan con OR. `withCuenta(cuentaId, fn)` abre una
transacción, fija `app.tenant_id` en el uuid nulo (no coincide con ninguna
empresa, y evita el error de la política original, que no usa `missing_ok`) y
`app.cuenta_id` en la cuenta **ya autenticada**. Resultado: se ven los perfiles
de esa persona y nada más.

Por qué no una función `SECURITY DEFINER`: con `FORCE ROW LEVEL SECURITY` el
dueño de la tabla también está sujeto a RLS, así que no la saltearía, y además
saltearla sería justo lo que no queremos. La política deja el alcance escrito en
la base.

`withCuenta` solo se usa en el servicio de autenticación, **después** de validar
la clave. Nunca con un id que venga del cliente sin verificar.

## 6. Entrar

### Con correo

1. Se busca la cuenta por correo. Se compara la clave **siempre** contra un
   hash (real o señuelo), para que el tiempo no delate si el correo existe.
2. Clave inválida, cuenta inexistente o inactiva → `401 Credenciales inválidas`.
3. Se listan sus perfiles activos en empresas activas (`withCuenta`).
4. Si el request vino por la dirección de una empresa, se queda **solo** con el
   perfil de esa empresa. Si no tiene → el mismo `401`: no se revela que la
   persona existe en otra empresa.
5. **Un perfil** → sesión directa.
6. **Varios** → la respuesta trae la lista de empresas y un **token de
   selección**: firmado, de 2 minutos, atado a la cuenta y a su versión. El
   cliente elige y lo canjea en `POST /api/auth/elegir-empresa`. La clave no
   viaja dos veces.
7. Al emitir la sesión se guarda `ultimo_tenant_id`.

### Con DNI

Exige la empresa por la dirección. Sin empresa → *"Entrá desde la dirección de
tu empresa"*. Con empresa, busca solo perfiles **sin cuenta**.

### Con Google

Google prueba que la persona es dueña del correo: equivale a la clave. Sigue el
mismo camino desde el paso 3.

### Con el SSO de la empresa

Sigue siendo por empresa (se entra por la dirección de la empresa). Resuelve el
perfil por `sso_subject` o lo vincula por correo, como hoy.

## 7. Cambiar de empresa sin salir (entrega 2)

- Selector arriba, **visible solo con 2 o más perfiles activos**.
- `POST /api/auth/cambiar-empresa`: verifica que el perfil exista y esté activo,
  emite la sesión de esa empresa y cierra la actual.
- El cliente se recarga completo: datos, SSE de tiempo real y catálogos
  cacheados de la otra empresa.
- Si hay operaciones offline sin sincronizar, **avisa antes**. Nunca se pierden
  ni se cruzan: quedan atadas a su perfil y salen al volver a esa empresa.

## 8. Sesiones y revocación

| Evento | Qué se revoca |
|---|---|
| Logout | esta sesión |
| Desactivar un perfil | las sesiones de **ese perfil**: la persona sigue en sus otras empresas |
| Cambiar o recuperar la clave | las de **todos** los perfiles de la cuenta |
| Desactivar la cuenta (plataforma) | todos los perfiles, y ningún login ni refresh posterior |
| Reuso de refresh token | las sesiones de ese perfil (contención, como hoy) |

## 9. Claves

- **Una clave por cuenta.** Cambiarla o recuperarla revoca todas sus sesiones.
- **Olvidé mi clave** pide solo el correo. El enlace apunta a la dirección de la
  empresa por la que se pidió, o a la última empresa usada.
- **Un admin nunca pone la clave de una cuenta.** Si lo hiciera, estaría
  cambiando la clave con la que esa persona entra a *otras* empresas, y
  además la conocería. Para una cuenta, "resetear clave" **envía el correo de
  recuperación** a la persona. La clave temporal escrita por un admin queda
  solo para operativos por DNI.

## 10. Administración por empresa (entregas 3 y 4)

Menú **"Administración"** en el sidebar, **visible solo para administradores**.
La estructura la definió Kenif sobre el telebanking de Scotiabank, que es donde
la vio funcionando:

| Opción | Qué tiene |
|---|---|
| **Administración de usuarios** | la gente de la empresa: nombre, id, correo, **celular**, tipo de usuario y **estado** (activo, inactivo, bloqueado). Alta, baja, desbloqueo, reseteo de clave |
| **Configuración** | las *autonomías*: qué módulos ve cada usuario, con qué nivel, y qué se le restringe |
| **Log de eventos** | todo lo que los usuarios hacen en el sistema, filtrable por fecha |
| **Órdenes** | las órdenes administrativas con correlativo (ver §11) |

**Perfil de usuario** va aparte del menú de administración: es la pantalla de
cada persona sobre sí misma (sus datos, su clave, sus empresas).

**Estado del perfil**, tres valores en vez del `activo` booleano de hoy:

- **activo**: entra normalmente.
- **inactivo**: lo dio de baja un admin. No entra.
- **bloqueado**: lo bloqueó el sistema (intentos fallidos de clave). No entra
  hasta que un admin lo desbloquee. Se distingue de "inactivo" porque no es
  una decisión de nadie y se resuelve con una orden de desbloqueo.

El **celular** es dato del perfil, no de la cuenta: la misma persona puede
tener distinto contacto en cada empresa, y es la empresa la que lo mantiene.

Un perfil = **tipo + módulos + nivel por módulo**:

- Tipos: Administrador, Operativo, Consultas, y los de cancha (grifero,
  conductor_ruta).
- Nivel por módulo: *Combustible: operar · Repuestos: consultas · Documentos:
  sin acceso*.

**Alta de alguien con correo:** si la persona es nueva se crea la cuenta y le
llega una invitación para definir su clave; si ya existe en otra empresa se
crea solo el perfil y le llega un aviso. **El admin ve exactamente lo mismo en
los dos casos.**

## 11. Órdenes administrativas y doble firma (entrega 5)

Toda acción de administración genera una **orden con correlativo**
(`ORD-2026-000123`), igual que en el telebanking: no es un formulario que se
aplica y desaparece, es un documento que queda. Tipos de orden: alta de
usuario, baja, desbloqueo, reseteo de clave, cambio de tipo de usuario, cambio
de módulos o de nivel, y el encendido/apagado de la doble firma.

La pantalla **Órdenes** muestra: correlativo, tipo, sobre quién, quién la pidió,
estado (pendiente / aprobada / rechazada / vencida / aplicada), quién firmó y
cuándo. Una orden aplicada es el respaldo de por qué alguien tiene el acceso
que tiene.

Cada empresa activa la doble firma (necesita al menos 2 administradores
activos). Con doble firma apagada, la orden se crea y se aplica con una sola
firma: el correlativo y el registro quedan igual.

1. Un admin **pide** un cambio con motivo. Queda pendiente; no se aplica nada.
2. **Otro** admin ve el antes → después y **aprueba o rechaza** con motivo.
3. Nadie aprueba su propia solicitud.
4. Vence a las **72 horas** sin firma.
5. Al aprobar **se valida todo de nuevo**: el usuario pudo haber cambiado.
6. Una sola solicitud pendiente por usuario; la segunda responde `409`.
7. Queda en la bitácora con las dos firmas.

| Acción | Firmas |
|---|---|
| Alta de usuario | 2 |
| Dar más permisos (tipo, módulos, subir nivel) | 2 |
| Reactivar | 2 |
| Resetear clave | 2 |
| Cualquier cambio sobre un **administrador** | 2 |
| Apagar la doble firma | 2 |
| **Dar de baja o quitar permisos a un no administrador** | **1, inmediato**, con aviso al otro admin |

La última fila existe porque cortar el acceso a una cuenta robada no puede
esperar al segundo firmante, y quitar permisos nunca le da ventaja a nadie. No
aplica a administradores: si aplicara, un admin podría sacar al otro y quedarse
solo.

**Casos de borde:**

- Con doble firma activa no se puede dar de baja al penúltimo administrador.
- Si un administrador se va igual, MINCORE habilita un reemplazo desde la
  plataforma con motivo obligatorio y registro (*break-glass*).

Esto cierra un límite anotado desde la primera auditoría de combustible: *"si el
admin es el dueño, nadie lo vigila"*.

## 12. Plataforma (MINCORE)

- Al crear una empresa, MINCORE da de alta a sus **dos administradores**, que
  son los dos firmantes.
- MINCORE puede crear usuarios de una empresa **por carta** del cliente. El
  número de carta es la autorización (la firma del cliente) y queda en la
  bitácora de la empresa, visible para sus administradores.
- MINCORE puede desactivar una **cuenta** entera (fraude, pedido de la
  persona). Una empresa solo desactiva **su** perfil.
- El dueño de la plataforma sigue sin ver datos de negocio de los clientes.

## 13. Respaldos por empresa

Un respaldo de empresa incluye sus perfiles, y los perfiles apuntan a cuentas,
que no son de ninguna empresa. El respaldo guarda también **las cuentas de sus
perfiles**. Al restaurar, una cuenta que ya existe (por correo) **no se toca**
— su clave pudo haber cambiado después desde otra empresa — y una que no
existe se crea.

**Respaldos anteriores a 0087.** No tienen cuentas ni `cuenta_id`: la clave
vivía en el perfil. Al restaurar uno, a cada perfil con correo se le arma la
cuenta desde esa clave, igual que hizo la migración. Sin esa conversión, el
restore dejaría los perfiles con una clave que el login ya no mira, y toda la
gente de oficina de esa empresa quedaría afuera — el día de un restore, que ya
es un día malo. Lo cubre `tests/platform-backup.test.ts` ("un backup anterior a
0087 le arma la cuenta al perfil que no la tenía").

## 14. Entregas

| # | Entrega | Alcance |
|---|---|---|
| **1** | **Cuentas y perfiles** | migración 0087, `withCuenta`, login por correo sin empresa, elegir empresa después de la clave, DNI por dirección de la empresa, Google, refresh, claves y recuperación a nivel cuenta, reset de un admin = correo para cuentas, respaldos |
| 2 | Cambiar de empresa sin salir | endpoint, selector, recarga completa, aviso de pendientes offline, reconexión SSE |
| 3 | Permisos por perfil | tipo + módulos + nivel por módulo, aplicado en todas las rutas; alta por invitación |
| 4 | Menú Administración | usuarios, permisos, bitácora de administración, sidebar solo para admins |
| 5 | Doble firma | solicitudes, aprobación, reglas de firmas, casos de borde, break-glass de plataforma, alta por carta |
| 6 | Seguridad por empresa | `exigir_sso`, desactivar cuenta desde plataforma, contract de la migración |

Cada entrega es un PR que funciona solo y con CI en verde.
