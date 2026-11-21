-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la ficha del proveedor (PR3a del ecosistema «Gestión de proveedores»)
--
-- Dos tablas propias del módulo `proveedores`, que cuelgan del proveedor (`combustible_grifos`, hoy la
-- tabla de proveedores) pero NO la modifican: así Combustible no se entera de ellas y, cuando la tabla
-- cambie de dueño (PR6), la ficha se queda como está.
--
--   proveedores_ficha     UNA fila por proveedor: dirección, teléfono, correo y condiciones de pago
--                         (contado o crédito con su plazo, y la moneda). Todo opcional.
--   proveedores_contactos las personas de contacto. Nunca se borran: «quitar» las desactiva.
--
-- Nada de esto es dato sensible (las cuentas bancarias, que sí lo son, vienen en un PR aparte con su
-- permiso y su bitácora). Las dos llevan RLS por empresa y borran en cascada con el proveedor.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS proveedores_ficha (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grifo_id         INTEGER NOT NULL REFERENCES combustible_grifos(id) ON DELETE CASCADE,
  direccion        VARCHAR(250),
  telefono         VARCHAR(40),
  correo           VARCHAR(150),
  -- Contado no lleva plazo; crédito lo exige (en días).
  forma_pago       VARCHAR(10) CHECK (forma_pago IN ('contado', 'credito')),
  plazo_pago_dias  INTEGER CHECK (plazo_pago_dias BETWEEN 1 AND 365),
  moneda           VARCHAR(3) CHECK (moneda IN ('PEN', 'USD')),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, grifo_id),
  CHECK (
    (forma_pago = 'credito' AND plazo_pago_dias IS NOT NULL)
    OR (forma_pago IS DISTINCT FROM 'credito' AND plazo_pago_dias IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_proveedores_ficha_proveedor ON proveedores_ficha (grifo_id);
CREATE INDEX IF NOT EXISTS idx_proveedores_ficha_actualizado_por
  ON proveedores_ficha (actualizado_por) WHERE actualizado_por IS NOT NULL;

CREATE TABLE IF NOT EXISTS proveedores_contactos (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Lo manda la pantalla al abrir el formulario: un reintento (doble clic, mala señal) no crea otro.
  cliente_uuid     UUID NOT NULL DEFAULT gen_random_uuid(),
  grifo_id         INTEGER NOT NULL REFERENCES combustible_grifos(id) ON DELETE CASCADE,
  nombre           VARCHAR(120) NOT NULL CHECK (length(trim(nombre)) > 0),
  cargo            VARCHAR(80),
  telefono         VARCHAR(40),
  correo           VARCHAR(150),
  principal        BOOLEAN NOT NULL DEFAULT false,
  activo           BOOLEAN NOT NULL DEFAULT true,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_por       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  quitado_en       TIMESTAMPTZ,
  quitado_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, cliente_uuid),
  -- Un contacto sirve si se le puede llamar o escribir.
  CHECK (telefono IS NOT NULL OR correo IS NOT NULL),
  -- Un contacto quitado no es el principal.
  CHECK (activo OR NOT principal)
);

-- A lo sumo un contacto principal activo por proveedor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_proveedores_contactos_principal
  ON proveedores_contactos (tenant_id, grifo_id) WHERE principal AND activo;
CREATE INDEX IF NOT EXISTS idx_proveedores_contactos_proveedor
  ON proveedores_contactos (tenant_id, grifo_id, activo);
CREATE INDEX IF NOT EXISTS idx_proveedores_contactos_grifo ON proveedores_contactos (grifo_id);
CREATE INDEX IF NOT EXISTS idx_proveedores_contactos_creado_por
  ON proveedores_contactos (creado_por) WHERE creado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proveedores_contactos_actualizado_por
  ON proveedores_contactos (actualizado_por) WHERE actualizado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proveedores_contactos_quitado_por
  ON proveedores_contactos (quitado_por) WHERE quitado_por IS NOT NULL;

ALTER TABLE proveedores_ficha ENABLE ROW LEVEL SECURITY;
ALTER TABLE proveedores_ficha FORCE ROW LEVEL SECURITY;
ALTER TABLE proveedores_contactos ENABLE ROW LEVEL SECURITY;
ALTER TABLE proveedores_contactos FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'proveedores_ficha' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON proveedores_ficha
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'proveedores_contactos'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON proveedores_contactos
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
