-- ─────────────────────────────────────────────────────────────────────────
-- Migración 0085: los roles de CANCHA -- grifero y conductor_ruta
--
-- Pedido del cliente (reunión 2026-09-09): dar acceso al grifero y a los
-- conductores de ruta. Hasta acá los únicos roles eran admin / operador /
-- lectura (migración 0001), pensados para gente de OFICINA.
--
-- Por qué `operador` no alcanzaba
-- ───────────────────────────────
-- En combustible hay 22 rutas que exigen `admin` contra 5 que aceptan
-- `operador`. Un grifero con `operador` puede anular vales, y anular es la
-- maniobra de fraude más limpia que existe: se despachan 200 L de verdad, se
-- anula el vale, el combustible salió y el papel dice que no. El sistema ya
-- lo detecta después del hecho (la anulación queda y dispara alerta), pero si
-- el que despacha es el mismo que anula no hay segregación, hay autopsia.
--
-- Decisión de Kenif (2026-09-10): "el grifero no anula sus vales, que dependa
-- del admin".
--
-- No son una jerarquía
-- ────────────────────
-- admin > operador > lectura sí es una escalera. Estos dos NO van en esa
-- escalera: son recortes laterales, y en direcciones distintas entre sí. El
-- grifero puede lo del tanque propio y nada de ruta; el conductor_ruta al
-- revés. Por eso `requireRole` sigue recibiendo una LISTA de roles permitidos
-- y no un nivel mínimo -- si algún día se convierte en un nivel numérico,
-- estos dos no tienen dónde ubicarse.
--
-- Lo que este enum NO decide
-- ──────────────────────────
-- Que un conductor_ruta no pueda despachar del tanque propio no se puede
-- resolver acá ni con requireRole: el vale del tanque y la compra externa
-- entran por el MISMO endpoint (POST /api/erp/combustible/despachos) y se
-- distinguen por el campo `origen` del body. La restricción real va adentro
-- del service. Ver combustible.service.ts.
--
-- ALTER TYPE ... ADD VALUE no corre dentro de una transacción en Postgres
-- viejos, y el runner de migraciones de este repo no las envuelve (ver
-- migrate.ts) -- así que esto es seguro tal cual está.
--
--   npm run migrate
-- ─────────────────────────────────────────────────────────────────────────

ALTER TYPE rol_usuario ADD VALUE IF NOT EXISTS 'grifero';
ALTER TYPE rol_usuario ADD VALUE IF NOT EXISTS 'conductor_ruta';

-- ── Quién puede tomar varilla ────────────────────────────────────────────
--
-- Decisión de Kenif (2026-09-10): "vamos a poner para que sea configurable
-- qué grifero registra varilla, porque en su mayoría pasa eso, y cuando hay
-- que hacer una auditoría el personal encargado de grifo va y toma la varilla
-- para ver si todo está ok".
--
-- O sea: en la operación real de este cliente la varilla NO es un control
-- independiente -- la toma el mismo que despacha. La separación de funciones
-- es una POLÍTICA que cada empresa elige según con cuánta gente cuenta, no
-- una regla que el sistema pueda imponer sin dejar a media industria afuera.
--
-- Default true, y no false, por la misma razón por la que los umbrales
-- arrancan en NULL: el default tiene que ser el comportamiento que YA existe.
-- Arrancar en false le apagaría la varilla al grifero de todos los tenants
-- que hoy la toman, y el síntoma sería "el sistema dejó de dejarme medir"
-- sin que nadie haya cambiado nada.
--
-- Vive en combustible_config (por tenant) y no en `usuarios` (por persona) a
-- propósito: es una política de la empresa, no un permiso individual. Si
-- mañana hace falta la excepción por persona, se agrega encima; al revés no
-- se puede, porque la política ya estaría dispersa en N filas.
ALTER TABLE combustible_config
  ADD COLUMN IF NOT EXISTS grifero_registra_varilla BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN combustible_config.grifero_registra_varilla IS
  'Si el rol grifero puede registrar lecturas de varilla. true = sí (default: '
  'es lo que hace hoy la mayoría). false = la varilla queda solo para admin y '
  'operador, para empresas que quieran separar quien mide de quien despacha.';
