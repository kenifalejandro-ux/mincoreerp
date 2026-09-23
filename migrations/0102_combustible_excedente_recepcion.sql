-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: DECISIÓN SOBRE EL EXCEDENTE DE UNA RECEPCIÓN
--
-- Hasta acá, una recepción que supera capacidad + tolerancia SIEMPRE se
-- rechazaba (400) -- ver validarDatosDeRecepcion en combustible.service.ts.
-- En la práctica el excedente casi nunca es culpa del proveedor: el
-- combustible YA se descargó, y el error suele ser de cálculo de quien pidió
-- la compra. Rechazar de plano traslada ese error a la relación con el
-- proveedor (devolución, reclamo) cuando el cliente puede preferir asumirlo.
--
-- Por tanque, no global: cada empresa (y cada tanque dentro de ella) decide
-- su propia política, igual que `requiere_documento` o `usa_precintos`.
--
--   'estricto'  (default, mismo comportamiento que hasta hoy) -> rechaza
--               siempre que se supere el techo. Sin sorpresas para el
--               cliente que prefiere devolver al proveedor.
--   'flexible'  -> si el excedente entra dentro de `limite_excedente_pct`
--               (o no hay límite configurado), la API NO guarda nada y
--               responde con el detalle para que decida: aceptar (con
--               alerta + correo a los admins), rechazar, o pedir que un
--               admin lo resuelva. Un excedente que SUPERA el límite se
--               rechaza igual, aunque el tanque esté en modo flexible --
--               el límite es el "hasta acá lo asumimos nosotros, de ahí
--               para arriba es devolución".
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible
  ADD COLUMN IF NOT EXISTS modo_excedente_recepcion VARCHAR(10) NOT NULL DEFAULT 'estricto'
    CHECK (modo_excedente_recepcion IN ('estricto', 'flexible')),
  ADD COLUMN IF NOT EXISTS limite_excedente_pct NUMERIC(5,2)
    CHECK (limite_excedente_pct IS NULL OR limite_excedente_pct >= 0);

COMMENT ON COLUMN combustible.modo_excedente_recepcion IS
  'estricto: una recepción que supera capacidad+tolerancia se rechaza siempre (default, comportamiento previo a 0102). flexible: se ofrece decidir (aceptar/rechazar/contactar admin), salvo que el excedente supere limite_excedente_pct.';
COMMENT ON COLUMN combustible.limite_excedente_pct IS
  'Tope adicional (% de capacidad_total), solo relevante en modo flexible, sobre el que ya no se puede decidir y se rechaza igual. NULL = sin tope adicional, cualquier excedente admite decisión.';

-- El nuevo tipo de alerta: se acepta un sobrestock a sabiendas.
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
    'equipo_de_otro_grifo',
    'sobrestock_recepcion'
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
    'equipo_de_otro_grifo',
    'sobrestock_recepcion'
  ));
