-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: un viaje a una unidad ESCRITA A MANO (sin Flota)
--
-- Autonomía de Viajes (ver 0176 para el vale, 0189 para Checklists, 0190 para OT): una empresa
-- puede tener Viajes sin tener el módulo Flota. Sin el registro de unidades, la unidad del viaje es
-- la placa que se escribe. Misma regla que el vale: la placa va normalizada (mayúsculas, sin
-- espacios ni guiones) y, si la empresa tiene Flota y la placa es de una unidad registrada, el
-- servidor toma esa unidad y no guarda la placa.
--
-- Lo que cambia en `combustible_viajes`:
--   · `equipo_id` deja de ser obligatorio.
--   · `placa_sin_alta` guarda la placa escrita. La unidad es UNA de las dos, nunca las dos ni
--     ninguna (CHECK): todo lo que cuelga de la unidad (el traslape, el medidor previo, el viaje en
--     curso) se resuelve por la unidad registrada o, si no la hay, por la placa.
--   · Un viaje en curso por placa, igual que el de por unidad (el índice de 0123 no cubre las
--     filas sin `equipo_id`: en Postgres los NULL no chocan entre sí).
--
-- Solo se RELAJA una restricción: toda fila que existe hoy tiene equipo_id y cumple el CHECK nuevo
-- (equipo_id no nulo, placa nula). No hay datos que migrar.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_viajes ALTER COLUMN equipo_id DROP NOT NULL;

ALTER TABLE combustible_viajes ADD COLUMN IF NOT EXISTS placa_sin_alta VARCHAR(20);

ALTER TABLE combustible_viajes DROP CONSTRAINT IF EXISTS combustible_viajes_unidad_check;
ALTER TABLE combustible_viajes
  ADD CONSTRAINT combustible_viajes_unidad_check
  CHECK (
    (equipo_id IS NULL) = (placa_sin_alta IS NOT NULL)
    AND (placa_sin_alta IS NULL OR placa_sin_alta ~ '^[A-Z0-9]{3,20}$')
  );

-- Una placa no está en dos viajes a la vez (el de por unidad es idx_viajes_un_en_curso_por_equipo).
CREATE UNIQUE INDEX IF NOT EXISTS idx_viajes_un_en_curso_por_placa
  ON combustible_viajes (tenant_id, placa_sin_alta)
  WHERE estado = 'en_curso' AND placa_sin_alta IS NOT NULL;

-- El traslape por placa (validarSinTraslape) y las listas por placa.
CREATE INDEX IF NOT EXISTS idx_viajes_placa_inicio
  ON combustible_viajes (tenant_id, placa_sin_alta, inicio_en)
  WHERE estado <> 'anulado' AND placa_sin_alta IS NOT NULL;
