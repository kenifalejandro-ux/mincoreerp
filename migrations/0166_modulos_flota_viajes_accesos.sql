-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: accesos a `flota` y `viajes` (parte 2 de 2, ver 0165)
--
-- Quien ya tenía Equipos tiene `flota` desde 0165 (el valor se renombró, las
-- filas siguen siendo las mismas). Acá se le da acceso a lo que antes venía
-- dentro de Combustible y ahora es módulo propio:
--
--   - Empresas: `viajes` y `flota` a toda empresa que hoy tiene Combustible,
--     con el mismo estado. Viajes vivía dentro de Combustible y `viajes`
--     exige que la empresa tenga `flota`.
--   - Usuarios: solo `viajes`, con el mismo nivel (operar o consultas) que
--     tenían en Combustible. A los usuarios NO se les da `flota`: eso les
--     abriría Registro de unidades (crear, editar y borrar unidades) a gente
--     a la que el administrador nunca se lo dio. Quien ya tenía Equipos sigue
--     teniendo `flota` por el renombre de 0165.
--
-- Los módulos NO se activan solos (decisión de plataforma): por eso este
-- traspaso es explícito, una sola vez, y parte de lo que cada empresa y cada
-- usuario YA tenía. Una empresa o usuario sin Combustible no recibe nada.
--
-- tenant_modulos y usuario_modulos no tienen RLS (tablas de plataforma, ver
-- 0033 y auth.service.ts), así que esto corre sin ventana NO FORCE.
--
-- Idempotente: ON CONFLICT DO NOTHING no pisa lo que se haya cambiado después.
--
-- EJECUTAR (después de 0165):
--   psql -d mincoreerp -f migrations/0166_modulos_flota_viajes_accesos.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Empresas: `flota` y `viajes` copian el estado de Combustible (habilitado,
-- piloto, etc.), su porcentaje de rollout y su versión.
--
-- `flota` hereda la fila de `equipos` (0165): una empresa con Combustible pero
-- sin Equipos tiene esa fila DESHABILITADA, y dejarla así deja a `viajes`
-- habilitado sin el módulo que exige. Por eso, solo para `flota`, una fila
-- deshabilitada pasa al estado de Combustible. Una `flota` ya habilitada no se
-- toca, y `viajes` nunca pisa lo que el administrador ya haya decidido.
INSERT INTO tenant_modulos (tenant_id, modulo, estado, rollout_porcentaje, version)
SELECT tm.tenant_id, 'flota'::modulo_erp, tm.estado, tm.rollout_porcentaje, tm.version
  FROM tenant_modulos tm
 WHERE tm.modulo = 'combustible'
   AND tm.estado <> 'deshabilitado'
ON CONFLICT (tenant_id, modulo) DO UPDATE
   SET estado = EXCLUDED.estado,
       rollout_porcentaje = EXCLUDED.rollout_porcentaje,
       version = EXCLUDED.version
 WHERE tenant_modulos.estado = 'deshabilitado';

INSERT INTO tenant_modulos (tenant_id, modulo, estado, rollout_porcentaje, version)
SELECT tm.tenant_id, 'viajes'::modulo_erp, tm.estado, tm.rollout_porcentaje, tm.version
  FROM tenant_modulos tm
 WHERE tm.modulo = 'combustible'
   AND tm.estado <> 'deshabilitado'
ON CONFLICT (tenant_id, modulo) DO NOTHING;

-- Usuarios: solo `viajes`, mismo nivel que tenían en Combustible.
--
-- Solo para usuarios que EXISTEN: usuario_modulos puede tener filas de
-- usuarios que ya no están (en una base de desarrollo, restos de tests; en
-- cualquiera, un borrado que no cascadeó), y copiarlas rompe la FK y tumba el
-- arranque del server. `usuarios` tiene RLS forzado y esta migración no trae
-- `app.tenant_id`, así que para ver todas sus filas hace falta la ventana
-- NO FORCE de siempre (mismo patrón que 0134), cerrada al final.
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;

INSERT INTO usuario_modulos (usuario_id, modulo, nivel)
SELECT um.usuario_id, 'viajes'::modulo_erp, um.nivel
  FROM usuario_modulos um
 WHERE um.modulo = 'combustible'
   AND EXISTS (SELECT 1 FROM usuarios u WHERE u.id = um.usuario_id)
ON CONFLICT (usuario_id, modulo) DO NOTHING;

ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
