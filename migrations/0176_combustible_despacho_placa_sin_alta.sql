-- Un vale del tanque propio a una unidad que todavía no está dada de alta.
--
-- El grifero no puede esperar a que la oficina registre la unidad: escribe la
-- placa a mano y el vale se guarda con ella. Es un destino propio
-- ('unidad_sin_alta') y no un 'equipo' sin equipo_id, a propósito: todo lo que
-- hoy lee tipo_destino='equipo' da por hecho que hay una unidad detrás (consumo,
-- medidor, sobredespacho, conductor), y así ese código sigue intacto y se salta
-- estos vales solo.
--
-- La placa se guarda ya normalizada (mayúsculas, sin espacios ni guiones). Cuando
-- la unidad se da de alta, el vínculo es una entrega aparte: acá solo queda la
-- placa visible en el historial.

ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS placa_sin_alta VARCHAR(20);

ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_tipo_destino_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_tipo_destino_check
  CHECK (tipo_destino IN ('equipo', 'planta', 'reserva_cubeta', 'unidad_sin_alta'));

-- La placa va si y solo si el destino es una unidad sin alta, y nunca junto a un equipo.
ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_placa_sin_alta_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_placa_sin_alta_check
  CHECK (
    (tipo_destino = 'unidad_sin_alta') = (placa_sin_alta IS NOT NULL)
    AND (placa_sin_alta IS NULL OR placa_sin_alta ~ '^[A-Z0-9]{3,20}$')
  );
