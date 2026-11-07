-- Despacho a «Otros»: combustible que sale del tanque sin unidad ni tanqueta (0181).
--
-- A veces el grifero entrega galones sueltos al personal u otro uso: no es una
-- tanqueta ni una unidad, solo combustible que sale del tanque con su vale. Es un
-- destino propio ('otro') y no un 'equipo' sin equipo_id, a propósito: todo lo que hoy
-- lee tipo_destino='equipo' da por hecho que hay una unidad detrás (consumo, medidor,
-- sobredespacho, conductor), y así ese código sigue intacto y se salta estos vales solo.
--
-- Sale del tanque, así que descuenta su nivel y entra en sus umbrales y en la
-- reconciliación como cualquier otra salida. Lo que el grifero redacta (a quién y para qué)
-- se guarda como texto libre en `otro_detalle` y se ve en el historial y el kardex.

ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS otro_detalle VARCHAR(250);

ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_tipo_destino_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_tipo_destino_check
  CHECK (tipo_destino IN ('equipo', 'planta', 'reserva_cubeta', 'unidad_sin_alta', 'otro'));

-- El detalle va si y solo si el destino es 'otro', y no puede estar vacío.
ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_otro_detalle_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_otro_detalle_check
  CHECK (
    (tipo_destino = 'otro') = (otro_detalle IS NOT NULL)
    AND (otro_detalle IS NULL OR length(btrim(otro_detalle)) > 0)
  );
