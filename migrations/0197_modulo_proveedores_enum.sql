-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: módulo `proveedores` (ecosistema «Gestión de proveedores»)
--
-- PR1 del ecosistema: solo el valor del enum. El módulo nace en SOLO LECTURA y
-- lee `combustible_grifos` (la tabla de proveedores de Combustible, que no
-- cambia de dueño en este PR). No crea tablas ni cuotas, y NO se habilita solo
-- en ninguna empresa: se enciende por empresa desde el panel de plataforma
-- (los módulos no se auto-habilitan).
--
-- El valor del enum no se puede usar como dato en la misma transacción que lo
-- agrega (mismo motivo que 0165/0166): por eso va solo, sin accesos.
--
-- Idempotente (IF NOT EXISTS).
--
-- EJECUTAR (después de 0196):
--   psql -d mincoreerp -f migrations/0197_modulo_proveedores_enum.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE modulo_erp ADD VALUE IF NOT EXISTS 'proveedores';
