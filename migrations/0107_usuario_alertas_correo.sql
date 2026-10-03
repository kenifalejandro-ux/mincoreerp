-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: A QUIÉN SE LE AVISA por correo, por módulo.
--
-- Hasta acá, "destinatario de las alertas de Combustible" no era un dato: se
-- DEDUCÍA de ser administrador (`findAdminsConModulo`, un `rol = 'admin'`
-- escrito en el SQL). Eso mezcla dos cosas que no son la misma:
--
--   administrar el módulo  ≠  querer que te lleguen sus avisos
--
-- Y las dos direcciones del error duelen. El jefe de planta que vive mirando
-- los tanques no recibe nada porque no es admin; el administrador de sistemas
-- que nunca pisó el grifo recibe todos los correos de descuadre y los termina
-- filtrando a una carpeta -- que es la forma más silenciosa de que una alerta
-- deje de existir.
--
-- Desde acá es una marca explícita por persona y por módulo, independiente
-- del rol: `recibe_alertas`.
--
-- ── Por qué no hay default ─────────────────────────────────────────────────
--
-- Sin fila, no se avisa. Nunca se asume "y si no está configurado, mandale a
-- los admins": ese default es justo lo que esta migración viene a sacar, y un
-- default implícito es el que se olvida de cambiar cuando alguien se va de la
-- empresa. Quién queda sin vigilancia se ve EN PANTALLA (el aviso de módulo
-- sin destinatarios), que es donde un humano puede hacer algo al respecto.
--
-- ── El seed preserva exactamente lo de hoy ─────────────────────────────────
--
-- Se marcan los administradores que HOY tienen el módulo asignado, que es
-- exactamente el conjunto que `findAdminsConModulo` devuelve. Nadie empieza
-- ni deja de recibir correos el día del deploy: la marca se hace visible y
-- editable, no se redefine.
--
-- A propósito NO se filtra por `tenant_modulos.estado`: una empresa en
-- 'rollout' hoy no recibe correos (eso lo sigue decidiendo la consulta en
-- runtime), pero si mañana le habilitan el módulo, sus admins ya tienen la
-- marca puesta en vez de quedar en silencio hasta que alguien se acuerde de
-- tildarla. Tampoco se filtra por `activo`: a quien se reactiva le vuelve su
-- configuración, y la consulta de runtime ya ignora a los inactivos.
--
-- EJECUTAR (después de 0008, que crea usuario_modulos y el enum modulo_erp):
--   psql -d mincoreerp -f migrations/0107_usuario_alertas_correo.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- `modulo_erp` y no TEXT: el nombre del módulo lo valida la base, así que un
-- typo ("combustibles") no puede quedar guardado como una suscripción que no
-- le llega a nadie y que nadie nota.
--
-- id BIGSERIAL propio (y no solo la PK compuesta natural) porque el backup
-- self-service de un tenant (platformBackup.service.ts) asume una columna
-- `id` en toda tabla que declara -- ver tests/backup-tablas-registradas.test.ts.
CREATE TABLE IF NOT EXISTS usuario_alertas_correo (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id      UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  modulo          modulo_erp NOT NULL,
  recibe_alertas  BOOLEAN NOT NULL,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, modulo)
);

-- El índice que usa la consulta caliente: "a quién le aviso de este módulo en
-- esta empresa". Parcial, porque las filas en false no se buscan nunca.
CREATE INDEX IF NOT EXISTS idx_usuario_alertas_correo_destinatarios
  ON usuario_alertas_correo (tenant_id, modulo)
  WHERE recibe_alertas;

ALTER TABLE usuario_alertas_correo ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_alertas_correo FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'usuario_alertas_correo'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON usuario_alertas_correo
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── Seed: los destinatarios que ya existían, ahora escritos ───────────────
-- Toca filas de TODAS las empresas a la vez, así que se apaga FORCE RLS para
-- el dueño solo durante el seed y se vuelve a prender antes de terminar, en la
-- misma transacción -- mismo mecanismo que 0057 y 0097. Sin esto, el SELECT
-- sobre `usuarios` (FORCE RLS desde 0010) falla con
-- `unrecognized configuration parameter "app.tenant_id"`.
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usuario_alertas_correo NO FORCE ROW LEVEL SECURITY;

INSERT INTO usuario_alertas_correo (tenant_id, usuario_id, modulo, recibe_alertas)
SELECT u.tenant_id, u.id, 'combustible'::modulo_erp, true
  FROM usuarios u
  JOIN usuario_modulos um ON um.usuario_id = u.id AND um.modulo = 'combustible'
 WHERE u.rol = 'admin'
ON CONFLICT (usuario_id, modulo) DO NOTHING;

ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
ALTER TABLE usuario_alertas_correo FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE usuario_alertas_correo IS
  'Quién recibe los correos de alerta de cada módulo. Independiente del rol: sin fila no se avisa, y no hay default por rol.';
