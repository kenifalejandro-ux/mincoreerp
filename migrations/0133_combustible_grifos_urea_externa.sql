-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: proveedores de urea INTERNOS y EXTERNOS
--
-- Hasta 0132 un proveedor tenía tres roles: abastece_ruta, abastece_tanque y
-- abastece_urea. La urea no distinguía si se compra para la planta o en el
-- recorrido de ruta, a diferencia del combustible (tanque = interno, ruta =
-- externo). El cliente confirmó que la urea también se divide así.
--
-- ── Lo que cambia ───────────────────────────────────────────────────────────
--
--   • `abastece_urea` (ya existe) pasa a significar urea INTERNA: la que se
--     recibe en el almacén de la planta.
--   • `abastece_urea_ruta` (nueva) es la urea EXTERNA: la que se compra en el
--     recorrido de ruta.
--
-- Los proveedores que hoy tienen urea marcada se copian a la columna nueva, de
-- modo que nada de lo que funciona hoy deja de funcionar; después se ajustan a
-- mano. La migración es aditiva: no borra ni renombra nada.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_grifos
  ADD COLUMN IF NOT EXISTS abastece_urea_ruta BOOLEAN NOT NULL DEFAULT false;

-- El backfill es un UPDATE de datos sobre una tabla con RLS forzado: sin
-- `app.tenant_id` de sesión no vería ninguna fila. Ventana NO FORCE dentro de
-- la transacción que abre migrate.ts, y se vuelve a forzar al final (mismo
-- patrón que 0063).
ALTER TABLE combustible_grifos NO FORCE ROW LEVEL SECURITY;

UPDATE combustible_grifos
   SET abastece_urea_ruta = true
 WHERE abastece_urea AND NOT abastece_urea_ruta;

ALTER TABLE combustible_grifos FORCE ROW LEVEL SECURITY;
