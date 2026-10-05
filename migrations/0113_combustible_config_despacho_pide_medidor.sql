-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: pedir (o no) el horómetro/odómetro en los despachos del tanque
--
-- Desde 0088 el formulario del vale del tanque propio pide el medidor de la
-- unidad, y sin él queda la alerta "sin lectura": era el único control de
-- consumo para lo que sale CON vale.
--
-- En la operación real de Kenif (2026-10-05) el grifero de Huamachuco no tiene
-- el horómetro a mano: todas las unidades salen cargadas de ahí, y el medidor
-- se anota en CADA carga en ruta (compra externa, y la carga desde tanqueta).
-- El consumo se sigue calculando: litros cargados entre dos lecturas (las
-- cargas sin medidor cuentan igual en el numerador) ÷ horas o km recorridos.
-- Lo que se pierde es la lectura en el punto de partida, no el control.
--
-- Por EMPRESA y con default true (del lado estricto, como el resto de 0088):
-- un PUT viejo que no mande el campo solo puede endurecer. Apagarlo cuenta
-- como aflojamiento: pide motivo y avisa a los admins.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_config
  ADD COLUMN IF NOT EXISTS despacho_pide_medidor BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN combustible_config.despacho_pide_medidor IS
  'true: el vale del tanque propio y el del excedente de cisterna piden el horómetro/odómetro de la unidad y alertan "sin lectura" si falta. false: no lo piden ni alertan; el medidor se toma en las cargas en ruta.';
