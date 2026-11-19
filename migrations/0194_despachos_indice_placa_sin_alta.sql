-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: índice de los vales por placa escrita (autonomía de Viajes, 0193)
--
-- El viaje de una unidad escrita a mano no tiene `equipo_id`: sus cargas se buscan por la placa
-- escrita (`combustible_despachos.placa_sin_alta`, 0176) dentro de la ventana del viaje: el detalle
-- del viaje, el consumo de su ruta, la vista de unidad del Control TV. Sin este índice esa búsqueda
-- recorre todos los vales de la empresa por cada viaje.
--
-- Parcial: solo las filas con placa escrita, que son pocas.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_despachos_placa_sin_alta
  ON combustible_despachos (tenant_id, placa_sin_alta, despachado_en)
  WHERE placa_sin_alta IS NOT NULL;
