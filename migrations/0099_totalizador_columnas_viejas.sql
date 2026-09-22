-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: CONTRAER lo que 0098 dejó del totalizador por tanque
--
-- 0098 pasó la casilla del totalizador, su tolerancia y su máximo del TANQUE
-- al SURTIDOR, y lo que la varilla lee de la columna
-- `combustible_lecturas.totalizador_lectura` a la tabla
-- `combustible_lectura_totalizadores`. Las columnas viejas quedaron para no
-- romper al código viejo durante el despliegue; el código nuevo ya no las lee.
--
-- Producción nunca corrió con el código anterior a 0098 (el CD todavía no
-- desplegó nunca), así que no hay ventana que cuidar: se borran acá.
--
-- Lo que sí hay que cuidar es restaurar un backup anterior a 0098, que trae
-- estas columnas: registry.ts las declara como excluidas al restaurar, igual
-- que `nivel_actual` desde 0059. Un surtidor que la base le crea a un tanque
-- de ese backup nace sin la casilla del totalizador.
-- ═══════════════════════════════════════════════════════════════════════════

-- El trigger que copiaba la columna vieja de la varilla a la tabla nueva.
DROP TRIGGER IF EXISTS trg_lecturas_totalizador_viejo ON combustible_lecturas;
DROP FUNCTION IF EXISTS copiar_totalizador_viejo_de_lectura();

-- El surtidor de un tanque que nunca tuvo ninguno ya no puede heredar la
-- casilla del tanque: la recibe (la manda el alta de tanque) o nace sin ella
-- (el vale de un tanque insertado por SQL o restaurado de un backup viejo).
DROP FUNCTION IF EXISTS crear_surtidor_del_tanque(INTEGER);
CREATE OR REPLACE FUNCTION crear_surtidor_del_tanque(
  p_combustible_id INTEGER,
  p_usa_totalizador BOOLEAN DEFAULT false,
  p_tolerancia NUMERIC DEFAULT 1
)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_surtidor INTEGER;
  t RECORD;
BEGIN
  SELECT c.tenant_id, c.grifo_interno_id, c.codigo INTO t
    FROM combustible c WHERE c.id = p_combustible_id;
  INSERT INTO surtidores (tenant_id, grifo_interno_id, nombre, usa_totalizador, totalizador_tolerancia)
  VALUES (t.tenant_id, t.grifo_interno_id, 'Surtidor ' || t.codigo,
          COALESCE(p_usa_totalizador, false), COALESCE(p_tolerancia, 1))
  RETURNING id INTO v_surtidor;
  INSERT INTO surtidor_tanques (tenant_id, surtidor_id, combustible_id, conectado_en, motivo_conexion)
  VALUES (t.tenant_id, v_surtidor, p_combustible_id, '1900-01-01T00:00:00Z', 'El surtidor del tanque');
  RETURN v_surtidor;
END $$;

-- La cadena del totalizador por tanque (0094) ya no existe: es por surtidor
-- (idx_combustible_despachos_cadena_surtidor, 0098).
DROP INDEX IF EXISTS idx_combustible_despachos_totalizador;

-- Las columnas. El índice de la varilla (0096) cae con su columna.
ALTER TABLE combustible
  DROP COLUMN IF EXISTS usa_totalizador,
  DROP COLUMN IF EXISTS totalizador_tolerancia,
  DROP COLUMN IF EXISTS totalizador_actual;
ALTER TABLE combustible_lecturas DROP COLUMN IF EXISTS totalizador_lectura;
