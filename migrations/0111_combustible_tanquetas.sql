-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: TANQUETAS / CUBETAS con código propio
--
-- La tanqueta (280 gal) es un depósito chico sin varilla ni medidor. Tiene dos
-- usos que el cliente confirmó (2026-10-04):
--   1. Alojar el EXCEDENTE de una recepción que no cabe en el tanque.
--   2. Servir de PREVISIÓN: sale con las unidades a ruta y se les carga desde
--      ahí (se controla con horómetro/odómetro y galones: entrega siguiente).
--
-- Por qué un registro y no un destino genérico ("reserva en cubeta"): sin
-- código no se puede hacer cumplir el tope de 280 gal, ni saber cuál se llenó,
-- ni tener su saldo.
--
-- ── El saldo se DERIVA, no se guarda ───────────────────────────────────────
-- Igual que el saldo teórico de un tanque: entradas menos salidas. Acá las
-- entradas son las líneas de excedente de recepciones no anuladas
-- (combustible_recepcion_excedentes.tanqueta_id). Las salidas llegan con la
-- carga en ruta. Guardar un saldo aparte lo haría divergir del historial.
--
-- Pertenece a un GRIFO INTERNO (la sede donde se llena): una tanqueta solo se
-- llena con excedente de los tanques de SU grifo. Es multi-tenant: otras
-- empresas pueden tener tanquetas en varias sedes.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combustible_tanquetas (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grifo_interno_id  INTEGER NOT NULL,
  codigo            VARCHAR(30) NOT NULL CHECK (length(trim(codigo)) > 0),
  capacidad         NUMERIC(10,2) NOT NULL DEFAULT 280 CHECK (capacidad > 0),
  activa            BOOLEAN NOT NULL DEFAULT true,
  motivo_baja       TEXT,
  creado_por        UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, grifo_interno_id) REFERENCES grifos_internos (tenant_id, id),
  CHECK (activa OR length(trim(coalesce(motivo_baja, ''))) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tanquetas_codigo
  ON combustible_tanquetas (tenant_id, lower(trim(codigo)));
CREATE INDEX IF NOT EXISTS idx_tanquetas_grifo
  ON combustible_tanquetas (tenant_id, grifo_interno_id);
CREATE INDEX IF NOT EXISTS idx_tanquetas_creado_por
  ON combustible_tanquetas (creado_por) WHERE creado_por IS NOT NULL;

ALTER TABLE combustible_tanquetas ENABLE ROW LEVEL SECURITY;
-- FORCE al final: la FK de abajo se valida contra esta tabla y esa consulta
-- pasaría por la política sin app.tenant_id (gotcha de 0097).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_tanquetas'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_tanquetas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- La línea del excedente que va a una cubeta dice a CUÁL. Nullable a propósito:
-- las líneas anteriores a esta migración (destino 'cubeta' sin tanqueta) ya
-- existen y no se inventa a cuál iban; las nuevas la exigen el schema y el
-- service. Solo una línea de cubeta puede apuntar a una tanqueta.
ALTER TABLE combustible_recepcion_excedentes
  ADD COLUMN IF NOT EXISTS tanqueta_id BIGINT;

-- La FK nueva se valida contra las filas existentes con una consulta que SÍ
-- pasa por RLS, y acá no hay app.tenant_id de sesión: va dentro de la ventana
-- NO FORCE (ver el gotcha de 0097).
ALTER TABLE combustible_recepcion_excedentes NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recepcion_excedentes_tanqueta_fk'
  ) THEN
    ALTER TABLE combustible_recepcion_excedentes
      ADD CONSTRAINT recepcion_excedentes_tanqueta_fk
      FOREIGN KEY (tenant_id, tanqueta_id) REFERENCES combustible_tanquetas (tenant_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recepcion_excedentes_tanqueta_destino_check'
  ) THEN
    ALTER TABLE combustible_recepcion_excedentes
      ADD CONSTRAINT recepcion_excedentes_tanqueta_destino_check
      CHECK (tanqueta_id IS NULL OR destino = 'cubeta');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_recepcion_excedentes_tanqueta
  ON combustible_recepcion_excedentes (tenant_id, tanqueta_id) WHERE tanqueta_id IS NOT NULL;

ALTER TABLE combustible_tanquetas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepcion_excedentes FORCE ROW LEVEL SECURITY;

-- ── Una recepción puede ir ENTERA al excedente ─────────────────────────────
-- Con el tanque lleno (2000/2000) toda la entrega es excedente: al tanque
-- entran 0 y el resto va a tanquetas, unidades o devolución. El CHECK de 0064
-- (cantidad > 0) lo impedía. Ahora: lo que entra al tanque puede ser 0, pero
-- la recepción tiene que haber entregado algo.
ALTER TABLE combustible_recepciones
  DROP CONSTRAINT IF EXISTS combustible_recepciones_cantidad_check;
ALTER TABLE combustible_recepciones
  ADD CONSTRAINT combustible_recepciones_cantidad_check
  CHECK (cantidad >= 0 AND (cantidad > 0 OR cantidad_derivada > 0));
