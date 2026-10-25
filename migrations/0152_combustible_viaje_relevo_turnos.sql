-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el RELEVO de un viaje y los TURNOS de conducción
--
-- Un viaje tiene un conductor titular y, si se quiere, un relevo que puede tomar el volante (el
-- titular en su día de descanso, o a mitad de camino). Quién maneja AHORA no es una copia fija en el
-- viaje: es el turno abierto.
--
-- ── Qué se agrega a combustible_viajes ─────────────────────────────────────
-- relevo_dni / relevo_nombre: el relevo, elegido al programar el viaje (no es fijo por unidad).
-- sale_primero: quién sale manejando, 'titular' o 'relevo'.
--
-- ── Los turnos ─────────────────────────────────────────────────────────────
-- Cada turno es un tramo de tiempo con UNA persona al volante, con el medidor al empezar y al
-- terminar: de ahí salen los kilómetros y las horas al volante de cada uno. A lo sumo hay UN turno
-- abierto por viaje (índice parcial). Al iniciar el viaje nace el primero; entregar el mando cierra
-- uno y abre otro (entrega siguiente). El turno guarda el DNI y el nombre como copia: las personas
-- rotan entre unidades.
--
-- ── Viajes que ya existen ──────────────────────────────────────────────────
-- Los iniciados o cerrados reciben UN turno del titular con las marcas que ya tienen. Es idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Ventana NO FORCE (gotcha de 0097): las FK y el backfill leen tablas con FORCE RLS ─────────

ALTER TABLE combustible_viajes NO FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible_viajes
  ADD COLUMN IF NOT EXISTS relevo_dni    VARCHAR(15),
  ADD COLUMN IF NOT EXISTS relevo_nombre VARCHAR(150),
  ADD COLUMN IF NOT EXISTS sale_primero  VARCHAR(7) NOT NULL DEFAULT 'titular';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'combustible_viajes_sale_primero_check') THEN
    ALTER TABLE combustible_viajes
      ADD CONSTRAINT combustible_viajes_sale_primero_check
      CHECK (sale_primero IN ('titular', 'relevo')),
      ADD CONSTRAINT combustible_viajes_relevo_distinto_check
      CHECK (relevo_dni IS NULL OR relevo_dni <> conductor_dni),
      ADD CONSTRAINT combustible_viajes_sale_relevo_check
      CHECK (sale_primero = 'titular' OR relevo_dni IS NOT NULL);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS combustible_viaje_turnos (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  viaje_id         BIGINT NOT NULL,
  conductor_dni    VARCHAR(15) NOT NULL,
  conductor_nombre VARCHAR(150),
  inicio_en        TIMESTAMPTZ NOT NULL,
  fin_en           TIMESTAMPTZ,
  medidor_inicio   NUMERIC(12, 1) CHECK (medidor_inicio IS NULL OR medidor_inicio >= 0),
  medidor_fin      NUMERIC(12, 1) CHECK (medidor_fin IS NULL OR medidor_fin >= 0),
  lugar            VARCHAR(160),
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, viaje_id)
    REFERENCES combustible_viajes (tenant_id, id) ON DELETE CASCADE,
  CHECK (fin_en IS NULL OR fin_en > inicio_en),
  CHECK (medidor_inicio IS NULL OR medidor_fin IS NULL OR medidor_fin >= medidor_inicio)
);

-- A lo sumo un turno abierto por viaje: nadie más va al volante a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS uq_viaje_turno_abierto
  ON combustible_viaje_turnos (tenant_id, viaje_id) WHERE fin_en IS NULL;
CREATE INDEX IF NOT EXISTS idx_viaje_turnos_viaje
  ON combustible_viaje_turnos (tenant_id, viaje_id, inicio_en);
-- Quién va al volante de qué: lo usan Mi viaje, la unidad de compra en ruta y el historial.
CREATE INDEX IF NOT EXISTS idx_viaje_turnos_conductor
  ON combustible_viaje_turnos (tenant_id, conductor_dni, inicio_en);

-- Viajes que ya existen.
INSERT INTO combustible_viaje_turnos
  (tenant_id, viaje_id, conductor_dni, conductor_nombre, inicio_en, fin_en, medidor_inicio, medidor_fin)
SELECT v.tenant_id, v.id, btrim(v.conductor_dni), v.conductor_nombre, v.inicio_en,
       CASE WHEN v.estado = 'cerrado' THEN v.fin_en END, v.medidor_inicio,
       CASE WHEN v.estado = 'cerrado' THEN v.medidor_fin END
  FROM combustible_viajes v
 WHERE v.inicio_en IS NOT NULL AND v.estado IN ('en_curso', 'cerrado')
   AND v.conductor_dni IS NOT NULL AND btrim(v.conductor_dni) <> ''
   AND NOT EXISTS (
     SELECT 1 FROM combustible_viaje_turnos t WHERE t.tenant_id = v.tenant_id AND t.viaje_id = v.id
   );

ALTER TABLE combustible_viaje_turnos ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_viaje_turnos'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_viaje_turnos
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── Fin de la ventana NO FORCE ─────────────────────────────────────────────

ALTER TABLE combustible_viajes FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viaje_turnos FORCE ROW LEVEL SECURITY;
