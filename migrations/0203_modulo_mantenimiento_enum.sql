-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: módulo `mantenimiento` (ecosistema «Gestión de mantenimiento»)
--
-- Etapa 1 del ecosistema: solo el valor del enum. El módulo es dueño de sus propios datos (los equipos
-- que la empresa mantiene y sus áreas, migración 0204) y NO exige ningún otro módulo. NO se habilita
-- solo en ninguna empresa: se enciende por empresa desde el panel de plataforma (los módulos no se
-- auto-habilitan).
--
-- El valor del enum no se puede usar como dato en la misma transacción que lo agrega (mismo motivo que
-- 0165/0166/0197): por eso va solo, sin accesos.
--
-- Idempotente (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE modulo_erp ADD VALUE IF NOT EXISTS 'mantenimiento';
