-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la línea del excedente que va a una tanqueta puede decir PARA QUÉ
-- UNIDAD va, con su vale
--
-- Kenif (2026-10-21): cuando sobra combustible de una cisterna y va a una
-- tanqueta, al asignarla a una unidad se le da su vale, igual que un despacho
-- del tanque a una unidad (la tanqueta lleva sus galones, hasta 280).
--
--   * tanqueta_equipo_id: la unidad (0139 la asigna al guardar la recepción).
--   * serie_talonario + n_vale: el vale de esa línea. Van los tres o ninguno;
--     solo una línea 'cubeta' puede llevarlos.
--
-- El vale NO entra al control de saltos y huecos del talonario (eso es de los
-- despachos): el servicio solo evita que el mismo número se use dos veces,
-- contra los despachos y contra las otras líneas.
-- Nullable a propósito: las líneas anteriores nacen sin unidad ni vale.
-- ═══════════════════════════════════════════════════════════════════════════

-- La FK nueva se valida contra filas existentes con una consulta que pasa por
-- RLS y acá no hay app.tenant_id: dentro de la ventana NO FORCE (gotcha 0097).
ALTER TABLE combustible_recepcion_excedentes NO FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible_recepcion_excedentes
  ADD COLUMN IF NOT EXISTS tanqueta_equipo_id INTEGER REFERENCES equipos(id),
  ADD COLUMN IF NOT EXISTS serie_talonario VARCHAR(20),
  ADD COLUMN IF NOT EXISTS n_vale INTEGER;

ALTER TABLE combustible_recepcion_excedentes
  DROP CONSTRAINT IF EXISTS recepcion_excedentes_unidad_vale_check;
ALTER TABLE combustible_recepcion_excedentes
  ADD CONSTRAINT recepcion_excedentes_unidad_vale_check
  CHECK (
    (tanqueta_equipo_id IS NULL) = (serie_talonario IS NULL)
    AND (serie_talonario IS NULL) = (n_vale IS NULL)
    AND (tanqueta_equipo_id IS NULL OR tanqueta_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_recepcion_excedentes_tanqueta_equipo
  ON combustible_recepcion_excedentes (tenant_id, tanqueta_equipo_id)
  WHERE tanqueta_equipo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recepcion_excedentes_vale
  ON combustible_recepcion_excedentes (tenant_id, serie_talonario, n_vale)
  WHERE serie_talonario IS NOT NULL;

ALTER TABLE combustible_recepcion_excedentes FORCE ROW LEVEL SECURITY;
