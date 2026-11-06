-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: las cantidades de combustible admiten hasta 3 decimales (120.234).
--
-- Antes eran NUMERIC(…,2): un contómetro que marca 112.331 se guardaba como
-- 112.33 y el formulario respondía "los dos valores válidos más aproximados
-- son 112.33 y 112.34". Ensanchar la escala NO pierde datos: lo que ya estaba
-- en 2 decimales queda igual (112.33 → 112.330).
--
-- Alcance: despacho (cantidad + contómetro), recepción, tanque (nivel y
-- capacidad), tanquetas (capacidad, asignación, retornos) y cisternas
-- (traslados, compras, excedentes). NO entra: urea (va por bultos), horómetro,
-- odómetro, precios ni costos, ni los umbrales y pisos de alertas.
--
-- `combustible_tanqueta_retornos.diferencia` es una columna GENERADA a partir de
-- saldo_validado y saldo_calculado: Postgres no deja cambiar el tipo de una
-- columna de la que depende una generada, así que se suelta y se recrea igual.
-- Re-ejecutable: si la escala ya es 3 el ALTER no cambia nada, y la columna
-- generada se suelta y se vuelve a crear con la misma fórmula.
-- ═══════════════════════════════════════════════════════════════════════════

-- Despacho
ALTER TABLE combustible_despachos
  ALTER COLUMN cantidad           TYPE NUMERIC(12,3),
  ALTER COLUMN lectura_contometro TYPE NUMERIC(12,3);

-- Recepción
ALTER TABLE combustible_recepciones
  ALTER COLUMN cantidad           TYPE NUMERIC(12,3),
  ALTER COLUMN cantidad_documento TYPE NUMERIC(14,3),
  ALTER COLUMN cantidad_derivada  TYPE NUMERIC(14,3);

ALTER TABLE combustible_recepcion_excedentes
  ALTER COLUMN cantidad TYPE NUMERIC(14,3);

-- Tanque (el "pozo"). El nivel actual no es columna (0059): sale de la última lectura.
ALTER TABLE combustible
  ALTER COLUMN capacidad_total TYPE NUMERIC(12,3),
  ALTER COLUMN nivel_minimo    TYPE NUMERIC(12,3);

ALTER TABLE combustible_lecturas
  ALTER COLUMN nivel TYPE NUMERIC(12,3);

-- Tanquetas
ALTER TABLE combustible_tanquetas
  ALTER COLUMN capacidad TYPE NUMERIC(10,3);

ALTER TABLE combustible_tanqueta_asignaciones
  ALTER COLUMN cantidad TYPE NUMERIC(14,3);

ALTER TABLE combustible_tanqueta_retornos
  DROP COLUMN IF EXISTS diferencia;

ALTER TABLE combustible_tanqueta_retornos
  ALTER COLUMN saldo_calculado TYPE NUMERIC(14,3),
  ALTER COLUMN saldo_validado  TYPE NUMERIC(14,3),
  ALTER COLUMN cantidad_pozo   TYPE NUMERIC(12,3);

ALTER TABLE combustible_tanqueta_retornos
  ADD COLUMN diferencia NUMERIC(14,3) GENERATED ALWAYS AS (saldo_validado - saldo_calculado) STORED;

-- Cisternas
ALTER TABLE combustible_cisterna_traslados
  ALTER COLUMN cantidad TYPE NUMERIC(14,3);

ALTER TABLE combustible_compras_cisterna
  ALTER COLUMN cantidad_facturada TYPE NUMERIC(14,3);
