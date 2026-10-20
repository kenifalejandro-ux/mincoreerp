-- El grifo maneja su propio precio: una boleta que difiere del precio de
-- referencia ya no exige motivo. La diferencia se sigue guardando.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'combustible_compras_ruta'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%motivo_descuadre IS NOT NULL%'
      AND pg_get_constraintdef(oid) LIKE '%abs(diferencia)%'
  LOOP
    EXECUTE format('ALTER TABLE combustible_compras_ruta DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
