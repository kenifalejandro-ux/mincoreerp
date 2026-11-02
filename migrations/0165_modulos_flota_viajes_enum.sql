-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: módulo "Gestión operacional de flota" (`flota`) y módulo `viajes`
--
-- Parte 1 de 2 (el enum y las cuotas). Los accesos de empresas y usuarios van
-- en 0166, en un archivo aparte a propósito: migrate.ts corre cada .sql en un
-- solo client.query(), y un valor de enum recién agregado no se puede usar
-- como dato dentro de la misma transacción que lo agrega (mismo motivo que
-- el comentario de 0049).
--
-- ── Qué hace ────────────────────────────────────────────────────────────────
--
-- 1. `equipos` se RENOMBRA a `flota` (ALTER TYPE ... RENAME VALUE) en vez de
--    sumar un valor nuevo. Registro de unidades pasa a vivir dentro del módulo
--    central "Gestión operacional de flota". Renombrar conserva solo todas las
--    filas que ya usan el valor (tenant_modulos, usuario_modulos,
--    usuario_alertas_correo, idempotency_keys): ninguna empresa ni usuario
--    pierde su acceso. Sumar `flota` y dejar `equipos` habría dejado un valor
--    muerto en el enum para siempre (Postgres no permite quitar valores) y
--    tests/module-registry.test.ts exige que el enum y el registry coincidan.
--
-- 2. Se suma `viajes`. Que exija tener `flota` activa lo resuelve el código,
--    no la base.
--
-- 3. Las cuotas se identifican con el id del módulo (recurso = id del registry,
--    ver 0033 y 0034). Si no se renombran junto con el enum, el límite de
--    equipos de cada plan y de cada empresa dejaría de coincidir con ningún
--    recurso y se ignoraría EN SILENCIO: el tope de unidades pasaría a ser
--    ilimitado. Por eso `equipos` -> `flota` también en plan_limites y
--    tenant_cuotas. (El texto 'equipos' como nombre de TABLA, de acción de
--    auditoría o de ruta no cambia.)
--
-- Idempotente: cada paso mira antes si ya se hizo.
--
-- EJECUTAR (después de 0164):
--   psql -d mincoreerp -f migrations/0165_modulos_flota_viajes_enum.sql
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'modulo_erp' AND e.enumlabel = 'equipos'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'modulo_erp' AND e.enumlabel = 'flota'
  ) THEN
    ALTER TYPE modulo_erp RENAME VALUE 'equipos' TO 'flota';
  END IF;
END $$;

ALTER TYPE modulo_erp ADD VALUE IF NOT EXISTS 'viajes';

-- Cuotas: el recurso `equipos` pasa a `flota`. El NOT EXISTS evita chocar con
-- la clave primaria si alguien ya hubiera cargado un `flota` a mano.
UPDATE plan_limites pl
   SET recurso = 'flota'
 WHERE pl.recurso = 'equipos'
   AND NOT EXISTS (
     SELECT 1 FROM plan_limites x WHERE x.plan_id = pl.plan_id AND x.recurso = 'flota'
   );

UPDATE tenant_cuotas tc
   SET recurso = 'flota'
 WHERE tc.recurso = 'equipos'
   AND NOT EXISTS (
     SELECT 1 FROM tenant_cuotas x WHERE x.tenant_id = tc.tenant_id AND x.recurso = 'flota'
   );
