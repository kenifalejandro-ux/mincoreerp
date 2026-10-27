-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: una sola alerta ABIERTA por viaje y tipo
--
-- La alerta de "unidad detenida" ahora la abre tanto la ruta que marca el descanso como el worker
-- horario. Si coinciden, las dos comprobaban "no hay una abierta" y las dos insertaban. El índice
-- único parcial lo impide en la base: el segundo insert no hace nada (ON CONFLICT DO NOTHING).
--
-- Antes se cierran los duplicados abiertos que ya existan (se queda la más antigua).
-- ═══════════════════════════════════════════════════════════════════════════

-- La limpieza lee y escribe todas las empresas: va dentro de la ventana NO FORCE (ver 0097).
ALTER TABLE combustible_alertas NO FORCE ROW LEVEL SECURITY;

UPDATE combustible_alertas a
   SET resuelta_en = now()
 WHERE a.viaje_id IS NOT NULL
   AND a.resuelta_en IS NULL
   AND EXISTS (
     SELECT 1 FROM combustible_alertas b
      WHERE b.tenant_id = a.tenant_id AND b.viaje_id = a.viaje_id AND b.tipo = a.tipo
        AND b.resuelta_en IS NULL AND b.id < a.id
   );

ALTER TABLE combustible_alertas FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS uq_combustible_alertas_viaje_abierta
  ON combustible_alertas (tenant_id, viaje_id, tipo)
  WHERE viaje_id IS NOT NULL AND resuelta_en IS NULL;
