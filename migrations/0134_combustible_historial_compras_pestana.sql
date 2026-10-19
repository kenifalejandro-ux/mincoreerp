-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: "Historial de compras" pasa a ser una pestaña propia
--
-- Hasta 0133 el botón "Historial de compras" del panel de Tanques colgaba de
-- `tanques:historial_despacho`: marcar una vista encendía la otra. Ahora cada
-- una tiene su pestaña (`tanques:historial_compras`) y el conductor trae la de
-- compras por defecto, para subir el comprobante que no pudo subir al comprar.
--
-- ── Lo que hace ─────────────────────────────────────────────────────────────
--
-- Quien tenía un override explícito de `historial_despacho` conserva el mismo
-- valor en la pestaña nueva (permitido o negado), para no perder lo que el
-- administrador ya decidió a mano. Los perfiles sin override siguen sus
-- defaults, que ahora se calculan en código (permisosPestanas.service.ts).
--
-- Idempotente: ON CONFLICT DO NOTHING no pisa lo que se haya marcado después.
-- ═══════════════════════════════════════════════════════════════════════════

-- Un INSERT de datos sobre una tabla con RLS forzado: sin `app.tenant_id` de
-- sesión no vería ninguna fila. Ventana NO FORCE dentro de la transacción que
-- abre migrate.ts, y se vuelve a forzar al final (mismo patrón que 0133).
ALTER TABLE usuario_permisos_pestana NO FORCE ROW LEVEL SECURITY;

INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
SELECT tenant_id, usuario_id, modulo, 'tanques:historial_compras', permitido
  FROM usuario_permisos_pestana
 WHERE modulo = 'combustible' AND pestana = 'tanques:historial_despacho'
ON CONFLICT (usuario_id, modulo, pestana) DO NOTHING;

ALTER TABLE usuario_permisos_pestana FORCE ROW LEVEL SECURITY;
