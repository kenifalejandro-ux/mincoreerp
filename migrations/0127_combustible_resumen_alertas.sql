-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: RESUMEN DIARIO DE ALERTAS (Entrega 2 de la Bandeja)
--
-- Desde esta entrega solo lo grave sale por correo al momento (ver
-- src/modules/combustible/canalesAlertas.ts); el resto espera a un correo
-- diario a las 7:00 de Lima con lo nuevo y lo que sigue sin resolver
-- (combustibleResumenAlertas.worker.ts).
--
-- Esta tabla es la marca de "el resumen de ESTE día ya salió para esta
-- empresa". El worker revisa cada pocos minutos y puede haber más de una
-- instancia: la PRIMARY KEY (tenant_id, fecha) es lo que garantiza que salga
-- una sola vez por día, aunque dos corridas lleguen juntas. Se reclama la
-- fila ANTES de mandar: si el envío se cae a la mitad, ese día se pierde
-- para quien faltaba (queda en el log) en vez de duplicarse para todos. Lo
-- perdido no desaparece: sigue en la Bandeja y vuelve en el resumen del día
-- siguiente como "sin resolver".
--
-- `enviado_en` es además el corte de "lo nuevo": el resumen de mañana cuenta
-- desde el `enviado_en` de hoy, así una alerta no cae en dos resúmenes ni en
-- ninguno aunque el worker se atrase.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combustible_resumen_alertas_envios (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Día de Lima al que corresponde el resumen.
  fecha         DATE NOT NULL,
  enviado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Cuántas personas lo recibieron (0 = no había nada que contar o nadie
  -- marcado). Solo para diagnóstico.
  destinatarios INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, fecha)
);

ALTER TABLE combustible_resumen_alertas_envios ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_resumen_alertas_envios'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_resumen_alertas_envios
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

ALTER TABLE combustible_resumen_alertas_envios FORCE ROW LEVEL SECURITY;
