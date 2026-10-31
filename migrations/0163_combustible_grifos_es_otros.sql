-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: proveedores "Otros" (los grifos que se usan una o dos veces)
--
-- Kenif (2026-10-21): hay grifos donde se compra una o dos veces y no vale la
-- pena darlos de alta. En "Compra en ruta" el conductor elige "Otros" y escribe
-- el nombre; el historial muestra ese nombre.
--
-- Cómo: el servicio crea un proveedor INTERNO por cada nombre distinto
-- ("Otros: Grifo El Sol"), marcado con `es_otros`. Así `grifo_id` sigue siendo
-- NOT NULL, ningún JOIN pierde filas, y el índice único de comprobante (por
-- proveedor, tipo y número) distingue dos grifos distintos con la misma boleta.
-- Las listas del catálogo, del formulario y de urea no los muestran.
--
-- Migración aditiva: no toca datos ni RLS, así que no necesita la ventana
-- NO FORCE de 0063/0133.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_grifos
  ADD COLUMN IF NOT EXISTS es_otros BOOLEAN NOT NULL DEFAULT false;
