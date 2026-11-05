-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: los permisos de la recepción pasan de Tanques a Cisternas
--
-- "Registrar recepción", "Validar recepciones" y "Decidir excedente" vivían bajo Tanques
-- (`tanques:registrar_recepcion`, `tanques:gestion_recepciones`, `tanques:decidir_excedente`). La
-- recepción ahora se hace desde Cisternas, y sus permisos viven ahí:
--   `cisternas:registrar_recepcion`, `cisternas:gestion_recepciones`, `cisternas:decidir_excedente`.
--
-- ── Lo que hace ─────────────────────────────────────────────────────────────
--
-- 1. Quien tenía un override explícito de cualquiera de los tres conserva el mismo valor en la
--    llave nueva (permitido o negado), para no perder lo que la administración decidió a mano. Los
--    perfiles sin override siguen sus defaults, que se calculan en código
--    (permisosPestanas.service.ts).
--
-- 2. Quien tenía la recepción dada a mano y su perfil NO trae la pestaña Cisternas por defecto
--    (por ejemplo un conductor o un encargado de urea) recibe también `cisternas` permitida:
--    la llave nueva tiene como padre a Cisternas, y sin ella perdería el botón que ya tenía.
--    Admin, operador, grifero y lectura la traen por defecto y no necesitan nada más; un
--    `cisternas` negado a mano se respeta (es una decisión explícita).
--
-- Las filas viejas NO se borran: un navegador abierto antes del despliegue todavía lee las llaves
-- de Tanques, y una fila sin uso no hace daño (mismo criterio que 0134 y 0167).
--
-- Idempotente: ON CONFLICT DO NOTHING no pisa lo que se haya marcado después.
--
-- ── Dos precauciones (las mismas de 0134 y 0167) ────────────────────────────
--
-- 1. Un INSERT de datos sobre una tabla con RLS forzado: sin `app.tenant_id` de sesión no vería
--    ninguna fila. Ventana NO FORCE dentro de la transacción que abre migrate.ts, y se vuelve a
--    forzar al final.
-- 2. Solo para usuarios que EXISTEN: la clave foránea hacia `usuarios` rechazaría la copia de una
--    fila cuyo usuario ya no está. Con la ventana abierta, `usuarios` también se ve completa.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usuario_permisos_pestana NO FORCE ROW LEVEL SECURITY;

INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
SELECT p.tenant_id, p.usuario_id, p.modulo,
       CASE p.pestana
         WHEN 'tanques:registrar_recepcion' THEN 'cisternas:registrar_recepcion'
         WHEN 'tanques:gestion_recepciones' THEN 'cisternas:gestion_recepciones'
         WHEN 'tanques:decidir_excedente'   THEN 'cisternas:decidir_excedente'
       END,
       p.permitido
  FROM usuario_permisos_pestana p
 WHERE p.modulo = 'combustible'
   AND p.pestana IN ('tanques:registrar_recepcion', 'tanques:gestion_recepciones',
                     'tanques:decidir_excedente')
   AND EXISTS (SELECT 1 FROM usuarios u WHERE u.id = p.usuario_id)
ON CONFLICT (usuario_id, modulo, pestana) DO NOTHING;

-- Quien recibe una recepción dada a mano en un perfil sin la pestaña Cisternas por defecto.
INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
SELECT DISTINCT p.tenant_id, p.usuario_id, 'combustible', 'cisternas', true
  FROM usuario_permisos_pestana p
  JOIN usuarios u ON u.id = p.usuario_id
 WHERE p.modulo = 'combustible'
   AND p.pestana IN ('cisternas:registrar_recepcion', 'cisternas:gestion_recepciones',
                     'cisternas:decidir_excedente')
   AND p.permitido
   AND u.rol NOT IN ('admin', 'operador', 'grifero', 'lectura')
ON CONFLICT (usuario_id, modulo, pestana) DO NOTHING;

ALTER TABLE usuario_permisos_pestana FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
