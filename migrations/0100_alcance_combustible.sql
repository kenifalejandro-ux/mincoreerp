-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: ALCANCE POR USUARIO en Combustible (entregas 3 y 4 de
-- docs/architecture/combustible-sedes-grifos-surtidores.md)
--
-- Cada usuario ve todas las sedes (`todo`, lo que tienen todos hoy) o solo lo
-- que el administrador le asignó: sedes, grifos o surtidores puntuales. El
-- administrador de la empresa ve todo siempre; eso lo decide el código.
--
-- El alcance vive en `usuarios` y NO en `usuario_modulos`: esa fila se borra
-- al quitarle el módulo a alguien, y al volver a asignárselo el alcance
-- renacería en `todo` -- ampliaría el acceso en silencio.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS alcance_combustible VARCHAR(10) NOT NULL DEFAULT 'todo'
    CHECK (alcance_combustible IN ('todo', 'asignado'));

-- Una fila por cosa asignada: una sede (incluye sus grifos, los de hoy y los
-- que se creen después), un grifo (sus tanques y surtidores) o un surtidor
-- (solo sus vales). Claves compuestas, como en 0097: la verificación de una
-- clave foránea no pasa por RLS.
CREATE TABLE IF NOT EXISTS usuario_accesos_combustible (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id        UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  sede_id           INTEGER,
  grifo_interno_id  INTEGER,
  surtidor_id       INTEGER,
  CHECK (num_nonnulls(sede_id, grifo_interno_id, surtidor_id) = 1),
  FOREIGN KEY (tenant_id, sede_id) REFERENCES sedes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, grifo_interno_id) REFERENCES grifos_internos (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, surtidor_id) REFERENCES surtidores (tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usuario_accesos_combustible_unico
  ON usuario_accesos_combustible
     (usuario_id, COALESCE(sede_id, 0), COALESCE(grifo_interno_id, 0), COALESCE(surtidor_id, 0));
CREATE INDEX IF NOT EXISTS idx_usuario_accesos_combustible_tenant
  ON usuario_accesos_combustible (tenant_id);
CREATE INDEX IF NOT EXISTS idx_usuario_accesos_combustible_sede
  ON usuario_accesos_combustible (tenant_id, sede_id) WHERE sede_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuario_accesos_combustible_grifo
  ON usuario_accesos_combustible (tenant_id, grifo_interno_id) WHERE grifo_interno_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuario_accesos_combustible_surtidor
  ON usuario_accesos_combustible (tenant_id, surtidor_id) WHERE surtidor_id IS NOT NULL;

ALTER TABLE usuario_accesos_combustible ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_accesos_combustible FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'usuario_accesos_combustible'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON usuario_accesos_combustible
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── La alerta de un vale a un equipo de otro grifo (entrega 4) ───────────
-- Un vale de tanque propio cuyo grifo no es el del equipo. SOLO alerta: los
-- equipos se prestan entre plantas. Es un hallazgo (se congela si nadie lo
-- explica), sin correo.
ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;
ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
    'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
    'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
    'tanque_sin_vigilancia',
    'recepcion_anulada', 'recepcion_discrepante', 'recepcion_sin_validar',
    'recepcion_retroactiva', 'consumo_excedido', 'varilla_sin_control',
    'varilla_exacta',
    'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
    'historial_sin_contrastar',
    'totalizador_salto', 'totalizador_retroceso',
    'precinto_alterado', 'precinto_reemplazado',
    'equipo_de_otro_grifo'
  ));

ALTER TABLE combustible_anomalias
  DROP CONSTRAINT IF EXISTS combustible_anomalias_tipo_check;
ALTER TABLE combustible_anomalias
  ADD CONSTRAINT combustible_anomalias_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo',
    'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
    'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
    'recepcion_anulada', 'recepcion_discrepante', 'recepcion_retroactiva',
    'consumo_excedido', 'varilla_exacta',
    'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
    'historial_sin_contrastar',
    'totalizador_salto', 'totalizador_retroceso',
    'precinto_alterado', 'precinto_reemplazado',
    'equipo_de_otro_grifo'
  ));
