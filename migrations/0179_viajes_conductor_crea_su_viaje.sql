-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el conductor crea su propio viaje desde el celular («Mi viaje»).
--
-- 1. tenants.conductor_crea_viaje: interruptor por empresa, APAGADO por defecto
--    (mismo patrón que tenants.doble_firma, 0091). Se enciende desde el panel de
--    plataforma; una empresa que no lo enciende no ve «Empezar un viaje».
--
-- 2. combustible_viajes.creado_por_conductor: marca «Creado por el conductor».
--    combustible_viajes.id_cliente: identificador único que genera el celular al
--    empezar el viaje. Un reenvío sin señal con el mismo identificador devuelve
--    el viaje que ya existe en vez de crear otro (índice único parcial).
--
-- 3. equipos.por_completar: la unidad que registró el conductor con solo placa,
--    nombre y ruta. La oficina agrega el resto y la marca se apaga.
--
-- 4. Alerta nueva `viaje_creado_por_conductor` (ESTADO, como viaje_demorado): se abre
--    al crear el viaje y se resuelve sola al cerrarlo o anularlo. Es la lista de
--    tipos de 0173 más este.
--
-- Todo es aditivo y con valor por defecto: no cambia lo que ya existe. No hay
-- tablas nuevas, así que no hay RLS nueva; las políticas de las tablas tocadas
-- siguen igual.
--
-- EJECUTAR (después de 0178):
--   psql -d mincoreerp -f migrations/0179_viajes_conductor_crea_su_viaje.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS conductor_crea_viaje BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE combustible_viajes
  ADD COLUMN IF NOT EXISTS creado_por_conductor BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS id_cliente UUID;

-- Un identificador por empresa: el mismo UUID dos veces nunca da dos viajes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_combustible_viajes_id_cliente
  ON combustible_viajes (tenant_id, id_cliente)
  WHERE id_cliente IS NOT NULL;

ALTER TABLE equipos
  ADD COLUMN IF NOT EXISTS por_completar BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  ALTER TABLE combustible_alertas DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;
  ALTER TABLE combustible_alertas
    ADD CONSTRAINT combustible_alertas_tipo_check
    CHECK (tipo IN (
      'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
      'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
      'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
      'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
      'tanque_sin_vigilancia', 'recepcion_sin_validar', 'varilla_sin_control',
      'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
      'recepcion_anulada', 'recepcion_discrepante', 'recepcion_retroactiva',
      'consumo_excedido', 'varilla_exacta',
      'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
      'urea_stock_bajo', 'urea_stock_excedido',
      'urea_conteo_recargado',
      'urea_precio_fuera_de_catalogo',
      'historial_sin_contrastar',
      'totalizador_salto', 'totalizador_retroceso',
      'precinto_alterado', 'precinto_reemplazado',
      'equipo_de_otro_grifo', 'sobrestock_recepcion', 'lectura_anulada',
      'tanqueta_sobregirada',
      'vale_excede_tanque',
      'comprobante_sin_foto',
      'urea_litros_corregidos',
      'urea_conteo_alterado',
      'tanqueta_retorno_diferencia',
      'viaje_demorado', 'viaje_detenido',
      -- 0170
      'cisterna_con_saldo',
      -- 0173
      'compra_diferencia', 'recepcion_sin_compra',
      -- 0179
      'viaje_creado_por_conductor'
    )) NOT VALID;
END $$;
