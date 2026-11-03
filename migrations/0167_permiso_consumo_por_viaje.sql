-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: "Consumo por viaje" pasa de ser una vista del Histórico a vivir
-- dentro de Viajes, con su propio permiso (`viajes:consumo`)
--
-- Hasta acá el ranking de consumo por viaje era la vista `historico:por_viaje`
-- del Histórico de Combustible. Ahora es una pestaña de Viajes y se rige por
-- `viajes:consumo`, un permiso hijo de `viajes` (mismo árbol de Combustible que
-- ya tienen `viajes:nuevo`, `viajes:editar` y `viajes:lugares`).
--
-- ── Lo que hace ─────────────────────────────────────────────────────────────
--
-- Quien tenía un override explícito de `historico:por_viaje` conserva el mismo
-- valor en el permiso nuevo (permitido o negado), para no perder lo que el
-- administrador ya decidió a mano. Los perfiles sin override siguen sus
-- defaults, que se calculan en código (permisosPestanas.service.ts).
--
-- La fila vieja NO se borra: un navegador abierto antes del despliegue todavía
-- lee `historico:por_viaje`, y una fila sin uso no hace daño. Se limpia aparte.
--
-- Idempotente: ON CONFLICT DO NOTHING no pisa lo que se haya marcado después.
--
-- ── Dos precauciones (las mismas de 0134 y 0166) ────────────────────────────
--
-- 1. Un INSERT de datos sobre una tabla con RLS forzado: sin `app.tenant_id` de
--    sesión no vería ninguna fila. Ventana NO FORCE dentro de la transacción que
--    abre migrate.ts, y se vuelve a forzar al final.
--
-- 2. Solo para usuarios que EXISTEN. La clave foránea hacia `usuarios` rechaza
--    la copia de una fila cuyo usuario ya no está (en una base de desarrollo,
--    restos de tests) y eso tumbaría el arranque del server. Con la ventana
--    NO FORCE abierta, `usuarios` también se ve completa.
--
-- EJECUTAR (después de 0166):
--   psql -d mincoreerp -f migrations/0167_permiso_consumo_por_viaje.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usuario_permisos_pestana NO FORCE ROW LEVEL SECURITY;

INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
SELECT p.tenant_id, p.usuario_id, p.modulo, 'viajes:consumo', p.permitido
  FROM usuario_permisos_pestana p
 WHERE p.modulo = 'combustible'
   AND p.pestana = 'historico:por_viaje'
   AND EXISTS (SELECT 1 FROM usuarios u WHERE u.id = p.usuario_id)
ON CONFLICT (usuario_id, modulo, pestana) DO NOTHING;

ALTER TABLE usuario_permisos_pestana FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
