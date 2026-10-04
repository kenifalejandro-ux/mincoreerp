-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la compra externa deja de fingir que tiene un talonario.
--
-- Hasta acá TODO despacho exigía `serie_talonario` + `n_vale` (0062), sin
-- importar su origen. Para el tanque propio eso es correcto y es el control
-- central del módulo: el talonario es papel de la EMPRESA, numerado y
-- correlativo, y el hueco en esa secuencia es el único mecanismo real contra
-- la fuga (punto 1 del diseño, hallazgo 6 de la planilla real).
--
-- Para la compra en un grifo de terceros no significa nada. Nadie entrega un
-- vale de la empresa en PRIMAX: lo que vuelve del viaje a Bambamarca es una
-- BOLETA o una FACTURA del proveedor. Obligar a inventar un "serie + número"
-- tuvo dos costos concretos:
--
--   1. Datos inventados en la columna que sostiene el control anti-fuga. Un
--      número tipeado a mano para "pasar el formulario" entra en la misma
--      secuencia que los vales reales y genera huecos fantasma -- ruido en
--      el único control que no puede volverse ruidoso.
--   2. El comprobante real -- el que la contadora necesita para cuadrar
--      contra la factura que llega a fin de mes -- no se guardaba en ningún
--      lado.
--
-- ── Por qué el comprobante es OBLIGATORIO y no opcional ────────────────────
--
-- No es solo una regla contable. Hoy, lo que impide que la cola offline
-- duplique una compra al reintentar es el índice único del vale: el segundo
-- envío choca contra (tenant, producto, serie, n_vale) y el servidor
-- responde 409. Si se quita el vale sin poner nada en su lugar, esa red
-- desaparece y un reintento crea una compra gemela.
--
-- El comprobante único por proveedor la reemplaza exactamente: la misma
-- boleta del mismo grifo no puede entrar dos veces. (La tabla de
-- idempotencia por `cliente_uuid` de 0044 sigue siendo la primera red; esta
-- es la segunda, la que ataja también al humano que carga dos veces desde
-- dos dispositivos distintos.)
--
-- ── Por qué el CHECK acepta las DOS formas y no migra los datos viejos ─────
--
-- Ya hay filas de compra_externa cargadas con serie + n_vale. Tentador:
-- moverlas a `comprobante_numero` y limpiar el vale. No se hace, por dos
-- razones:
--
--   - Sería inventar el dato. No sabemos si ese número era una boleta, una
--     factura o un correlativo interno que alguien usó para pasar la
--     pantalla. Etiquetarlo 'boleta' es afirmar algo que nadie dijo.
--   - Un CHECK que solo acepte la forma nueva rompe el UPDATE de las filas
--     viejas -- y el UPDATE que más importa es `anulada_en`. Anular una
--     compra vieja fallaría. (Por eso tampoco sirve `NOT VALID`: deja pasar
--     las filas existentes, pero las vuelve a chequear en cuanto se tocan.)
--
-- Así que el CHECK exige EXACTAMENTE UNA de las dos formas: comprobante
-- (nueva) o vale (vieja, congelada). Nunca las dos, nunca ninguna. La base
-- sigue garantizando que una compra siempre sabe identificarse; que las
-- nuevas usen la forma nueva lo impone el schema Zod, que es donde vive la
-- regla de negocio que puede cambiar.
--
-- ── La urea conserva su talonario ──────────────────────────────────────────
--
-- La urea también es `origen = 'compra_externa'` (no hay tanque propio de
-- urea), pero el cliente SÍ aceptó un talonario propio para ella (ver 0092).
-- Su CHECK de forma es independiente y no se toca: sigue exigiendo vale y
-- prohíbe el comprobante.
--
-- ── El archivo del comprobante ─────────────────────────────────────────────
--
-- Columnas en la misma fila, no una tabla aparte: la relación es 1 a 1 y
-- toda consulta que muestra la compra quiere saber si tiene foto. Una tabla
-- aparte obligaría a un JOIN en cada listado para responder un booleano.
--
-- Se sube DESPUÉS del registro y es opcional: el conductor en ruta puede no
-- tener señal ni batería, y bloquear la carga de la compra por la foto es
-- cambiar un dato contable firme por una foto que puede llegar en una hora.
-- Que falte se avisa (entrega 2), no se impide.
--
-- `comprobante_driver` guarda CON QUÉ driver se subió cada archivo, no se
-- deduce del entorno al leer -- mismo criterio exacto que
-- `documentos_versiones.storage_driver` (0043): si mañana el tenant pasa de
-- local a S3, las fotos viejas se siguen descargando con el driver que las
-- escribió.
--
-- Un solo archivo por compra, sin versionado (a diferencia de Documentos):
-- una boleta no tiene revisiones. Reemplazarla es un acto correctivo y queda
-- en la bitácora con quién y por qué -- principio de "auditar quién Y por
-- qué".
--
-- ── El despacho como ancla de alerta ───────────────────────────────────────
--
-- `combustible_alertas_ancla_check` (0073, extendido en 0092) exige que toda
-- alerta pueda responder "¿sobre qué es?": un vale (serie + n_vale), un
-- tanque, una recepción o un conteo de urea. Una compra externa SIN vale que
-- dispare `medidor_inconsistente` (el horómetro retrocedió) o consumo
-- excedido no es ninguna de las cuatro: el INSERT de la alerta violaría el
-- CHECK y la alerta se perdería -- justo las dos alertas que son EXCLUSIVAS
-- de la compra externa, porque el horómetro solo existe ahí.
--
-- La columna `despacho_id` ya existe en las dos tablas desde 0068/0073; solo
-- nunca fue ancla aceptada. Se suma como quinta.
--
-- Aplicar:
--   psql -d mincoreerp -f migrations/0109_combustible_comprobante_compra_externa.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. El vale deja de ser obligatorio a nivel de columna ────────────────
-- La obligatoriedad pasa a ser condicional al origen, y eso solo lo puede
-- expresar un CHECK (abajo), no un NOT NULL.
ALTER TABLE combustible_despachos
  ALTER COLUMN serie_talonario DROP NOT NULL,
  ALTER COLUMN n_vale DROP NOT NULL;

-- ── 2. El comprobante del proveedor ──────────────────────────────────────
ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS comprobante_tipo       VARCHAR(10),
  ADD COLUMN IF NOT EXISTS comprobante_numero     VARCHAR(40),
  -- Archivo adjunto (foto o PDF). Todo-o-nada: ver el CHECK de coherencia.
  ADD COLUMN IF NOT EXISTS comprobante_driver     TEXT,
  ADD COLUMN IF NOT EXISTS comprobante_key        TEXT,
  ADD COLUMN IF NOT EXISTS comprobante_mime       TEXT,
  ADD COLUMN IF NOT EXISTS comprobante_bytes      INTEGER,
  ADD COLUMN IF NOT EXISTS comprobante_nombre     TEXT,
  ADD COLUMN IF NOT EXISTS comprobante_subido_en  TIMESTAMPTZ;

-- La FK va dentro de la ventana NO FORCE de abajo (gotcha de 0097): la
-- validación inicial de un ADD CONSTRAINT ... FOREIGN KEY sí pasa por RLS y
-- acá no hay `app.tenant_id` de sesión.
ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS comprobante_subido_por UUID;

-- `usuarios` también entra en la ventana: la consulta de validación de la FK
-- es un LEFT JOIN entre LAS DOS tablas, así que la policy de cualquiera de
-- ellas basta para que falte `app.tenant_id` y todo se caiga con 42704.
-- (0097 no lo necesitó porque sus FK apuntaban a tablas que ya estaban en su
-- propia lista de NO FORCE.)
ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'combustible_despachos_comprobante_subido_por_fkey'
  ) THEN
    -- SET NULL y no CASCADE: borrar un usuario no puede borrar la evidencia
    -- de una compra -- mismo criterio que `usuario_id` en esta misma tabla y
    -- que `documentos_versiones.subido_por`.
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_comprobante_subido_por_fkey
      FOREIGN KEY (comprobante_subido_por) REFERENCES usuarios(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;

-- ── 3. Dominios y coherencia del comprobante ─────────────────────────────

ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_comprobante_tipo_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_comprobante_tipo_check
  CHECK (comprobante_tipo IS NULL OR comprobante_tipo IN ('boleta', 'factura'));

ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_comprobante_driver_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_comprobante_driver_check
  CHECK (comprobante_driver IS NULL OR comprobante_driver IN ('local', 's3'));

-- El archivo es todo-o-nada. Media fila de archivo (key sin driver, driver
-- sin key) es una descarga rota que nadie descubre hasta que la contadora
-- hace clic. Y `comprobante_numero` es su requisito previo: no existe una
-- foto de un comprobante que no se declaró.
ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_comprobante_archivo_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_comprobante_archivo_check
  CHECK (
    (comprobante_key IS NULL
      AND comprobante_driver IS NULL
      AND comprobante_mime IS NULL
      AND comprobante_bytes IS NULL
      AND comprobante_nombre IS NULL
      AND comprobante_subido_en IS NULL)
    OR
    (comprobante_key IS NOT NULL
      AND comprobante_driver IS NOT NULL
      AND comprobante_mime IS NOT NULL
      AND comprobante_bytes IS NOT NULL
      AND comprobante_nombre IS NOT NULL
      AND comprobante_subido_en IS NOT NULL
      AND comprobante_numero IS NOT NULL)
  );

-- ── 4. Forma por origen: el vale y el comprobante se excluyen ────────────
-- Se reemplazan enteros los dos CHECK de 0092 (Postgres no permite
-- extender un CHECK). Lo que agrega esta migración está marcado [0109].

ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_forma_tanque_propio_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_tanque_propio_check
  CHECK (
    producto <> 'combustible' OR origen <> 'tanque_propio' OR (
      combustible_id IS NOT NULL
      AND tipo_combustible IS NOT NULL
      AND lectura_contometro IS NOT NULL
      AND grifo_id IS NULL
      AND horas_abastecidas IS NULL
      AND (lectura_horometro IS NULL OR lectura_odometro IS NULL)
      AND (tipo_destino = 'equipo' OR (lectura_horometro IS NULL AND lectura_odometro IS NULL))
      -- [0109] El talonario es el control del tanque propio: sigue siendo
      -- obligatorio acá. Y un comprobante de proveedor no tiene sentido en
      -- combustible que salió del tanque de la empresa.
      AND serie_talonario IS NOT NULL
      AND n_vale IS NOT NULL
      AND comprobante_tipo IS NULL
      AND comprobante_numero IS NULL
      AND comprobante_key IS NULL
    )
  );

ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_forma_compra_externa_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_compra_externa_check
  CHECK (
    producto <> 'combustible' OR origen <> 'compra_externa' OR (
      combustible_id IS NULL
      AND tipo_combustible IS NOT NULL
      AND lectura_contometro IS NULL
      AND grifo_id IS NOT NULL
      AND horas_abastecidas IS NOT NULL
      AND (
        (lectura_horometro IS NOT NULL AND lectura_odometro IS NULL)
        OR (lectura_horometro IS NULL AND lectura_odometro IS NOT NULL)
      )
      -- [0109] Exactamente una de las dos formas de identificación:
      --   nueva  -> comprobante del proveedor, sin vale
      --   vieja  -> vale, sin comprobante (filas anteriores a esta
      --             migración; se conservan tal cual y se pueden anular)
      AND (
        (comprobante_tipo IS NOT NULL
          AND comprobante_numero IS NOT NULL
          AND serie_talonario IS NULL
          AND n_vale IS NULL)
        OR
        (serie_talonario IS NOT NULL
          AND n_vale IS NOT NULL
          AND comprobante_tipo IS NULL
          AND comprobante_numero IS NULL)
      )
    )
  );

-- La urea mantiene su talonario propio (0092) y nunca lleva comprobante:
-- se reemplaza solo para sumarle esa prohibición explícita.
ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_forma_urea_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_urea_check
  CHECK (
    producto <> 'urea' OR (
      origen = 'compra_externa'
      AND tipo_destino = 'equipo'
      AND equipo_id IS NOT NULL
      AND grifo_id IS NOT NULL
      AND combustible_id IS NULL
      AND tipo_combustible IS NULL
      AND lectura_contometro IS NULL
      AND lectura_horometro IS NULL
      AND lectura_odometro IS NULL
      AND horas_abastecidas IS NULL
      AND presentacion IS NOT NULL
      AND factor_litros IS NOT NULL
      AND cantidad_bultos IS NOT NULL
      AND cantidad = cantidad_bultos * factor_litros
      -- [0109]
      AND serie_talonario IS NOT NULL
      AND n_vale IS NOT NULL
      AND comprobante_tipo IS NULL
      AND comprobante_numero IS NULL
      AND comprobante_key IS NULL
    )
  );

-- ── 5. La misma boleta no entra dos veces ────────────────────────────────
-- Es el reemplazo exacto de `idx_combustible_despachos_vale_vigente` para la
-- compra externa, y sigue su misma filosofía: solo las VIGENTES compiten.
-- Una compra anulada libera su número, porque el caso real es "la cargué mal
-- y la vuelvo a cargar con el mismo papel en la mano".
--
-- El proveedor entra en la clave: dos grifos distintos numeran sus boletas
-- cada uno por su cuenta y la boleta 001 de PRIMAX no tiene nada que ver con
-- la 001 de PETROPLUS -- mismo razonamiento que (serie, n_vale) en 0062.
CREATE UNIQUE INDEX IF NOT EXISTS idx_combustible_despachos_comprobante_vigente
  ON combustible_despachos(tenant_id, grifo_id, comprobante_tipo, comprobante_numero)
  WHERE comprobante_numero IS NOT NULL AND anulada_en IS NULL;

-- Cobertura de la FK nueva (tests/db-index-coverage.test.ts lo exige).
-- Parcial: la enorme mayoría de las filas no tiene archivo subido.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_comprobante_subido_por
  ON combustible_despachos(comprobante_subido_por)
  WHERE comprobante_subido_por IS NOT NULL;

-- "¿Qué compras externas siguen sin foto del comprobante?" -- la consulta
-- que alimenta el aviso de la entrega 2. Parcial para que el índice pese lo
-- que pesan las pendientes, no todo el historial.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_comprobante_sin_archivo
  ON combustible_despachos(tenant_id, despachado_en)
  WHERE comprobante_numero IS NOT NULL AND comprobante_key IS NULL AND anulada_en IS NULL;

-- ── 6. El despacho, quinta ancla de alerta ───────────────────────────────
-- Ver el encabezado. Sin esto, `medidor_inconsistente` sobre una compra
-- externa sin vale no se puede guardar.
DO $$
BEGIN
  ALTER TABLE combustible_alertas DROP CONSTRAINT IF EXISTS combustible_alertas_ancla_check;
  ALTER TABLE combustible_alertas
    ADD CONSTRAINT combustible_alertas_ancla_check
    CHECK (
      (serie_talonario IS NOT NULL AND n_vale IS NOT NULL)
      OR combustible_id IS NOT NULL
      OR recepcion_id IS NOT NULL
      OR urea_conteo_id IS NOT NULL
      OR despacho_id IS NOT NULL
    );

  ALTER TABLE combustible_anomalias DROP CONSTRAINT IF EXISTS combustible_anomalias_ancla_check;
  ALTER TABLE combustible_anomalias
    ADD CONSTRAINT combustible_anomalias_ancla_check
    CHECK (
      (serie_talonario IS NOT NULL AND n_vale IS NOT NULL)
      OR combustible_id IS NOT NULL
      OR recepcion_id IS NOT NULL
      OR urea_conteo_id IS NOT NULL
      OR despacho_id IS NOT NULL
    );
END $$;

-- ── 7. Si el despacho es el ancla, no puede quedar huérfana ─────────────
-- `despacho_id` nació en 0068/0072 con ON DELETE SET NULL, y estaba bien:
-- era decorativo, el ancla real era el vale, así que perderlo no dejaba a
-- la alerta sin saber de qué hablaba.
--
-- Desde el punto 6 el despacho PUEDE ser el único ancla. Con SET NULL,
-- borrar un despacho deja una fila que viola su propio CHECK: el DELETE
-- falla y la alerta bloquea para siempre el borrado de su despacho. Lo
-- encontró el teardown de la suite al borrar un tenant de prueba.
--
-- CASCADE es la única opción coherente, y además la que ya usan los otros
-- cuatro anclas (combustible_id, recepcion_id, urea_conteo_id, ver 0073 y
-- 0092): una alerta sobre un despacho que ya no existe no tiene de qué
-- hablar. En operación normal un despacho no se borra nunca --se ANULA, y
-- anular conserva la fila y su alerta-- así que esto solo se ejecuta al
-- eliminar datos de prueba o un tenant entero.
ALTER TABLE combustible_alertas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_anomalias NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_despacho_id_fkey;
ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_despacho_id_fkey
  FOREIGN KEY (despacho_id) REFERENCES combustible_despachos(id) ON DELETE CASCADE;

ALTER TABLE combustible_anomalias
  DROP CONSTRAINT IF EXISTS combustible_anomalias_despacho_id_fkey;
ALTER TABLE combustible_anomalias
  ADD CONSTRAINT combustible_anomalias_despacho_id_fkey
  FOREIGN KEY (despacho_id) REFERENCES combustible_despachos(id) ON DELETE CASCADE;

ALTER TABLE combustible_alertas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_anomalias FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN combustible_despachos.comprobante_tipo IS
  'boleta|factura del proveedor. Solo en compra_externa de combustible; reemplaza al talonario, que ahí nunca existió (0109).';
COMMENT ON COLUMN combustible_despachos.comprobante_numero IS
  'Número del comprobante tal como lo imprime el proveedor (ej. F001-00012345). Único por proveedor entre las compras vigentes.';
COMMENT ON COLUMN combustible_despachos.comprobante_key IS
  'Key del archivo (foto/PDF) en el storage. NULL = todavía sin adjuntar: se avisa, no se impide (el conductor puede estar sin señal).';
