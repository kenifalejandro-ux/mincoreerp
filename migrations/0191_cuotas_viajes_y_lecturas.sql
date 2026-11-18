-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: CUOTA POR PLAN PARA VIAJES Y PARA LAS LECTURAS DEL MEDIDOR
--
-- Dos recursos nuevos con cuota por empresa (ver src/modules/registry.ts):
--   · 'viajes'          — los viajes creados (tabla combustible_viajes), por las dos rutas que
--                         crean uno: la de oficina y la del conductor.
--   · 'equipo_lecturas' — las lecturas del medidor de la unidad (0187). Hasta aquí `POST /:id/lecturas`
--                         se medía contra el conteo de EQUIPOS: no tenía tope propio, y una empresa al
--                         tope de unidades no podía registrar lecturas.
--
-- Mismo mecanismo de siempre (tenant_cuotas > plan_limites > default del registry): son DATOS, sin
-- DDL. Una empresa sin plan cae al default del registry (`porDefecto`, igual al de Mediana).
--
-- Los números salen del tamaño de cada plan (mype ~20 equipos, pequeña ~100, mediana ~500), con ~4
-- años de margen. Son TECHOS de seguridad, no un precio: se suben con una excepción por empresa desde
-- el panel, sin tocar código. Supuestos (a corregir con datos reales):
--   · Viajes: ~10 por unidad al mes (120/año). Cushuro, con 40 unidades, hace más de 100 al mes
--     (≥2,5 por unidad): el supuesto deja ~4× de holgura sobre ese mínimo.
--       mype (20):     20 × 120 =   2.400/año → 10.000
--       pequeña (100): 100 × 120 = 12.000/año → 50.000
--       mediana (500): 500 × 120 = 60.000/año → 240.000
--   · Lecturas del medidor: ~2 por unidad al día (730/año).
--       mype (20):     20 × 730 =  14.600/año → 60.000
--       pequeña (100): 100 × 730 = 73.000/año → 300.000
--       mediana (500): 500 × 730 = 365.000/año → 1.500.000
--   · Corporativo: NULL = ilimitado (no es "sin fila": esa significa «usá el default del registry»).
--
-- Idempotente: ON CONFLICT DO NOTHING no pisa un valor que ya se haya puesto a mano.
--
-- EJECUTAR (después de 0190):
--   psql -d mincoreerp -f migrations/0191_cuotas_viajes_y_lecturas.sql
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO plan_limites (plan_id, recurso, limite)
SELECT p.id, v.recurso, v.limite
FROM planes p
JOIN (VALUES
  ('mype',        'viajes',          10000::bigint),
  ('pequena',     'viajes',          50000),
  ('mediana',     'viajes',          240000),
  ('corporativo', 'viajes',          NULL),
  ('mype',        'equipo_lecturas', 60000),
  ('pequena',     'equipo_lecturas', 300000),
  ('mediana',     'equipo_lecturas', 1500000),
  ('corporativo', 'equipo_lecturas', NULL)
) AS v(codigo, recurso, limite) ON v.codigo = p.codigo
ON CONFLICT (plan_id, recurso) DO NOTHING;
