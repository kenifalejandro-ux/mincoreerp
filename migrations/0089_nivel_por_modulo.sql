-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: nivel de acceso por módulo (entrega 3)
--
-- Hasta acá, tener un módulo asignado era todo o nada: quien lo tenía podía
-- cargar, editar y anular. Kenif lo pidió como lo tenía el telebanking de su
-- banco -- las "autonomías": el mismo módulo se le da a una persona para
-- OPERAR y a otra solo para CONSULTAR.
--
-- Tres niveles, y el tercero ya existía sin nombre:
--
--   operar     = carga y modifica (lo de hoy, y el default)
--   consultas  = ve y exporta, no escribe nada
--   sin acceso = la fila no existe en usuario_modulos (como siempre)
--
-- Por qué el default es 'operar' y no 'consultas': esta migración no le puede
-- cambiar el acceso a nadie. Todo el que hoy tiene un módulo lo tiene para
-- operar, y así se queda hasta que un administrador decida otra cosa desde
-- Administración → Configuración.
--
-- Dónde se aplica: en el router del ERP, una sola vez para todos los módulos
-- (src/server/routes/index.ts). Un módulo nuevo queda cubierto sin tocar nada,
-- que es justo lo que no puede fallar en un control de acceso.
--
-- EJECUTAR (después de 0008, que crea usuario_modulos):
--   psql -d mincoreerp -f migrations/0089_nivel_por_modulo.sql
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE nivel_modulo AS ENUM ('operar', 'consultas');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE usuario_modulos
  ADD COLUMN IF NOT EXISTS nivel nivel_modulo NOT NULL DEFAULT 'operar';

COMMENT ON COLUMN usuario_modulos.nivel IS
  'operar = carga y modifica; consultas = solo lectura y exportar. Sin acceso es la ausencia de la fila.';
