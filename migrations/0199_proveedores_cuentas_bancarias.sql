-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: cuentas bancarias del proveedor (PR3b del ecosistema «Gestión de proveedores»)
--
-- A qué cuenta se le paga a un proveedor es el dato que más se defrauda («nos cambiamos de banco»), así que
-- este es el único dato de la ficha con tratamiento aparte:
--
--   · El número NO se guarda en claro: va cifrado (AES-256-GCM, APP_ENCRYPTION_KEY) en `numero_cifrado`. En
--     claro solo viven los últimos 4 dígitos (`numero_ultimos4`) para mostrarlo enmascarado.
--   · `numero_huella` es un HMAC del número (no reversible): sirve para impedir la misma cuenta dos veces en
--     el mismo proveedor sin guardar el número.
--   · Una cuenta nunca se borra: «quitar» la desactiva con su motivo y quién la quitó.
--
-- Ver completo y editar tienen permisos aparte (`proveedores:cuentas:ver_completa` y `…:editar`), y cada alta,
-- cambio, baja y cada vez que alguien ve un número completo queda en la bitácora (sin el número).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS proveedores_cuentas_bancarias (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Lo manda la pantalla al abrir el formulario: un reintento no crea otra cuenta.
  cliente_uuid     UUID NOT NULL DEFAULT gen_random_uuid(),
  grifo_id         INTEGER NOT NULL REFERENCES combustible_grifos(id) ON DELETE CASCADE,
  banco            VARCHAR(80) NOT NULL CHECK (length(trim(banco)) > 0),
  tipo_cuenta      VARCHAR(10) NOT NULL CHECK (tipo_cuenta IN ('corriente', 'ahorros', 'detraccion')),
  moneda           VARCHAR(3) NOT NULL CHECK (moneda IN ('PEN', 'USD')),
  titular          VARCHAR(150),
  numero_cifrado   TEXT NOT NULL,
  numero_ultimos4  VARCHAR(4) NOT NULL CHECK (numero_ultimos4 ~ '^[0-9]{4}$'),
  numero_huella    VARCHAR(64) NOT NULL,
  principal        BOOLEAN NOT NULL DEFAULT false,
  activo           BOOLEAN NOT NULL DEFAULT true,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_por       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  quitado_en       TIMESTAMPTZ,
  quitado_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_baja      TEXT,
  UNIQUE (tenant_id, cliente_uuid),
  -- Una cuenta quitada no es la principal, y siempre dice por qué se quitó.
  CHECK (activo OR NOT principal),
  CHECK (
    (activo AND quitado_en IS NULL AND motivo_baja IS NULL)
    OR (NOT activo AND quitado_en IS NOT NULL AND length(trim(coalesce(motivo_baja, ''))) > 0)
  )
);

-- La misma cuenta no se registra dos veces en un proveedor (una quitada no cuenta).
CREATE UNIQUE INDEX IF NOT EXISTS idx_proveedores_cuentas_huella
  ON proveedores_cuentas_bancarias (tenant_id, grifo_id, numero_huella) WHERE activo;
-- A lo sumo una cuenta principal activa por proveedor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_proveedores_cuentas_principal
  ON proveedores_cuentas_bancarias (tenant_id, grifo_id) WHERE principal AND activo;
CREATE INDEX IF NOT EXISTS idx_proveedores_cuentas_proveedor
  ON proveedores_cuentas_bancarias (tenant_id, grifo_id, activo);
CREATE INDEX IF NOT EXISTS idx_proveedores_cuentas_grifo
  ON proveedores_cuentas_bancarias (grifo_id);
CREATE INDEX IF NOT EXISTS idx_proveedores_cuentas_creado_por
  ON proveedores_cuentas_bancarias (creado_por) WHERE creado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proveedores_cuentas_actualizado_por
  ON proveedores_cuentas_bancarias (actualizado_por) WHERE actualizado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proveedores_cuentas_quitado_por
  ON proveedores_cuentas_bancarias (quitado_por) WHERE quitado_por IS NOT NULL;

ALTER TABLE proveedores_cuentas_bancarias ENABLE ROW LEVEL SECURITY;
ALTER TABLE proveedores_cuentas_bancarias FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'proveedores_cuentas_bancarias'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON proveedores_cuentas_bancarias
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
