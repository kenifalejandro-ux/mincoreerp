-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: áreas y datos propios de los equipos, del ecosistema «Gestión de mantenimiento»
--
-- Los equipos NO tienen tabla propia en Mantenimiento: el maestro de unidades es `equipos` (con sus lecturas en
-- `equipo_lecturas`), una tabla BASE de la empresa que ningún módulo posee y que cualquiera puede usar, tenga la
-- empresa Flota o no. Hay un solo registro de unidades, con dos puertas: «Registro de unidades» (Flota) y
-- «Equipos» (Mantenimiento). Aquí solo va lo que es de Mantenimiento:
--
--   mantenimiento_areas         dónde trabajan los equipos (Cantera, Planta de hornos, Taller...). La lista la
--                               define cada empresa; un área con equipos no se quita (lo valida el servicio).
--   mantenimiento_equipo_datos  UNA fila por equipo con lo que solo Mantenimiento necesita: su área y si es
--                               propio o alquilado. Es una extensión de `equipos` (mismo patrón que
--                               `equipo_conductores` para Flota): la tabla base no se entera de ella.
--
-- Las dos llevan RLS por empresa y cuelgan de `tenants`. Nada se borra: «quitar» un equipo lo desactiva.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mantenimiento_areas (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre      VARCHAR(80) NOT NULL CHECK (length(trim(nombre)) > 0),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL
);

-- Sin dos áreas con el mismo nombre en la empresa (sin mirar mayúsculas ni espacios de los bordes).
CREATE UNIQUE INDEX IF NOT EXISTS idx_mantenimiento_areas_nombre
  ON mantenimiento_areas (tenant_id, lower(trim(nombre)));
CREATE INDEX IF NOT EXISTS idx_mantenimiento_areas_creado_por
  ON mantenimiento_areas (creado_por) WHERE creado_por IS NOT NULL;

CREATE TABLE IF NOT EXISTS mantenimiento_equipo_datos (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  equipo_id        INTEGER NOT NULL REFERENCES equipos(id) ON DELETE CASCADE,
  -- Opcional. Si el área se borra el equipo queda sin área, no desaparece.
  area_id          BIGINT REFERENCES mantenimiento_areas(id) ON DELETE SET NULL,
  propiedad        VARCHAR(10) NOT NULL DEFAULT 'propia' CHECK (propiedad IN ('propia', 'alquilada')),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, equipo_id)
);

CREATE INDEX IF NOT EXISTS idx_mantenimiento_equipo_datos_equipo
  ON mantenimiento_equipo_datos (equipo_id);
CREATE INDEX IF NOT EXISTS idx_mantenimiento_equipo_datos_area
  ON mantenimiento_equipo_datos (area_id) WHERE area_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mantenimiento_equipo_datos_actualizado_por
  ON mantenimiento_equipo_datos (actualizado_por) WHERE actualizado_por IS NOT NULL;

ALTER TABLE mantenimiento_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE mantenimiento_areas FORCE ROW LEVEL SECURITY;
ALTER TABLE mantenimiento_equipo_datos ENABLE ROW LEVEL SECURITY;
ALTER TABLE mantenimiento_equipo_datos FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'mantenimiento_areas' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON mantenimiento_areas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'mantenimiento_equipo_datos'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON mantenimiento_equipo_datos
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
