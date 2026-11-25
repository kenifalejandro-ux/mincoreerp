/** src/modules/checklists/checklists.versiones.ts
 *
 * Editar los formatos de checklist (E5-1). Cada cambio es una versión nueva con su «qué cambió»; volver a una
 * anterior crea otra versión (la historia no se reescribe). Los checklists ya llenados no cambian: guardan sus
 * propias preguntas.
 *
 * Dos personas editando a la vez: quien guarda manda la versión sobre la que trabajó (`version_base`) y, si ya no
 * es la vigente, recibe 409 en vez de pisar lo de la otra. */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";

export interface ItemDeFormato {
  descripcion: string;
  critica: boolean;
}

export interface Formato {
  nombre: string;
  tipo_equipo: string | null;
  items: ItemDeFormato[];
}

/** El formato vigente, con la fila tomada hasta el final de la transacción. */
async function tomar(client: PoolClient, tenantId: string, id: number, versionBase: number) {
  const p = await client.query<{ nombre: string; tipo_equipo: string | null; version: number }>(
    `SELECT nombre, tipo_equipo, version FROM checklist_plantillas
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, id]
  );
  const plantilla = p.rows[0];
  if (!plantilla) throw new AppError(404, "Plantilla no encontrada");
  if (plantilla.version !== versionBase) {
    throw new AppError(
      409,
      `Alguien cambió este formato mientras lo editabas (va en la versión ${plantilla.version}): vuelve a abrirlo`
    );
  }
  return plantilla;
}

/** La foto de la versión vigente, si todavía no la tiene (los formatos anteriores a las versiones). */
async function asegurarFoto(client: PoolClient, tenantId: string, id: number) {
  await client.query(
    `INSERT INTO checklist_plantilla_versiones (tenant_id, plantilla_id, version, nombre, tipo_equipo, items, creado_en)
     SELECT p.tenant_id, p.id, p.version, p.nombre, p.tipo_equipo,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('descripcion', i.descripcion, 'critica', i.critica)
                                       ORDER BY i.orden, i.id)
                        FROM checklist_plantilla_items i
                       WHERE i.tenant_id = p.tenant_id AND i.plantilla_id = p.id), '[]'::jsonb),
            p.creado_en
       FROM checklist_plantillas p
      WHERE p.tenant_id = $1 AND p.id = $2
     ON CONFLICT (plantilla_id, version) DO NOTHING`,
    [tenantId, id]
  );
}

/** Deja `formato` como versión nueva y vigente. */
async function publicar(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  version: number,
  formato: Formato,
  cambio: string
) {
  await client.query(
    `UPDATE checklist_plantillas SET nombre = $3, tipo_equipo = $4, version = $5
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, formato.nombre, formato.tipo_equipo, version]
  );
  await client.query(
    "DELETE FROM checklist_plantilla_items WHERE tenant_id = $1 AND plantilla_id = $2",
    [tenantId, id]
  );
  await client.query(
    `INSERT INTO checklist_plantilla_items (tenant_id, plantilla_id, descripcion, critica, orden)
     SELECT $1, $2, x.descripcion, x.critica, x.orden - 1
       FROM unnest($3::text[], $4::boolean[]) WITH ORDINALITY AS x(descripcion, critica, orden)`,
    [tenantId, id, formato.items.map((i) => i.descripcion), formato.items.map((i) => i.critica)]
  );
  await client.query(
    `INSERT INTO checklist_plantilla_versiones
       (tenant_id, plantilla_id, version, nombre, tipo_equipo, items, cambio, creado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      id,
      version,
      formato.nombre,
      formato.tipo_equipo,
      JSON.stringify(formato.items),
      cambio,
      usuarioId,
    ]
  );
}

export async function editarFormato(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  datos: Formato & { version_base: number; cambio: string }
): Promise<number> {
  await tomar(client, tenantId, id, datos.version_base);
  await asegurarFoto(client, tenantId, id);
  const version = datos.version_base + 1;
  await publicar(client, tenantId, usuarioId, id, version, datos, datos.cambio);
  return version;
}

export async function restaurarVersion(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  anterior: number,
  versionBase: number
): Promise<number> {
  await tomar(client, tenantId, id, versionBase);
  await asegurarFoto(client, tenantId, id);
  const r = await client.query<Formato>(
    `SELECT nombre, tipo_equipo, items FROM checklist_plantilla_versiones
      WHERE tenant_id = $1 AND plantilla_id = $2 AND version = $3`,
    [tenantId, id, anterior]
  );
  if (!r.rows[0]) throw new AppError(404, "Esa versión no existe");
  if (anterior === versionBase) throw new AppError(400, "Esa ya es la versión vigente");
  const version = versionBase + 1;
  await publicar(
    client,
    tenantId,
    usuarioId,
    id,
    version,
    r.rows[0],
    `Vuelve a la versión ${anterior}`
  );
  return version;
}

/** Las versiones de un formato, de la más nueva a la más vieja. Uno nunca editado muestra su versión 1. */
export async function listarVersiones(client: PoolClient, tenantId: string, id: number) {
  const p = await client.query(
    "SELECT 1 FROM checklist_plantillas WHERE tenant_id = $1 AND id = $2",
    [tenantId, id]
  );
  if (!p.rowCount) throw new AppError(404, "Plantilla no encontrada");
  await asegurarFoto(client, tenantId, id);
  const r = await client.query(
    `SELECT v.version, v.nombre, v.tipo_equipo, v.items, v.cambio, v.creado_en, u.nombre AS creado_por_nombre
       FROM checklist_plantilla_versiones v
       LEFT JOIN usuarios u ON u.id = v.creado_por
      WHERE v.tenant_id = $1 AND v.plantilla_id = $2
      ORDER BY v.version DESC`,
    [tenantId, id]
  );
  return r.rows;
}

/** Desactivar solo deja de ofrecer el formato: un checklist ya llenado sin señal con él se sigue aceptando. */
export async function cambiarActiva(
  client: PoolClient,
  tenantId: string,
  id: number,
  activa: boolean
) {
  const r = await client.query(
    `UPDATE checklist_plantillas SET activa = $3 WHERE tenant_id = $1 AND id = $2
     RETURNING id, nombre, tipo_equipo, version, activa`,
    [tenantId, id, activa]
  );
  if (!r.rows[0]) throw new AppError(404, "Plantilla no encontrada");
  return r.rows[0];
}
