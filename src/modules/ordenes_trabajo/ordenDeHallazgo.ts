/** src/modules/ordenes_trabajo/ordenDeHallazgo.ts
 *
 * Las órdenes de trabajo que nacen de las fallas de un checklist: sola, si falla un punto crítico (E5-2), o
 * al decidir la salida de una unidad con fallas menores. Corre en la MISMA transacción que quien la pide: o
 * quedan los dos o ninguno.
 *
 * NO SE REPITE: una falla que ya tiene una orden abierta para la misma unidad no genera otra; el checklist
 * queda anotado en esa orden. Si además hay una falla distinta, la orden nueva lleva solo esa. Y si ahora
 * la unidad no puede salir, la orden que ya existía se endurece: «no puede operar» y, como mínimo, la
 * prioridad que habría tenido la nueva. Nunca se ablanda.
 *
 * NO respeta la cuota de órdenes, a propósito: viene de una falla (seguridad) y se crea aunque la empresa
 * esté en su límite. Sí cuenta para el límite: las órdenes manuales siguen bloqueadas. */
import type { PoolClient } from "pg";

import { empresaTieneModulo } from "../../server/shared/utils/modulosEmpresa";

export interface Hallazgo {
  checklistId: number;
  equipoId: number | null;
  activoTexto: string | null;
  /** Cómo se nombra la unidad en el título: su placa/código, o el texto del activo. */
  nombreActivo: string;
  fallas: { descripcion: string; observacion?: string | null }[];
}

export interface TipoDeOrden {
  titulo: string;
  prioridad: "urgente" | "alta" | "media";
  noOpera: boolean;
}

/** ¿La empresa quiere la orden automática de una falla crítica? Hace falta Órdenes de trabajo. La regla «OT
 *  desde hallazgo crítico» es de Mantenimiento: sin ese módulo (o sin haberla tocado) queda encendida. */
export async function pideOrdenAutomatica(client: PoolClient, tenantId: string) {
  if (!(await empresaTieneModulo(client, tenantId, "ordenes_trabajo"))) return false;
  if (!(await empresaTieneModulo(client, tenantId, "mantenimiento"))) return true;
  const regla = await client.query<{ ot_de_hallazgo: boolean }>(
    `SELECT ot_de_hallazgo FROM mantenimiento_config WHERE tenant_id = $1`,
    [tenantId]
  );
  return regla.rows[0]?.ot_de_hallazgo ?? true;
}

const clave = (texto: string) => texto.trim().toLowerCase();

/** Anota las fallas en las órdenes: las ya cubiertas, en su orden abierta; el resto, en una nueva. Devuelve
 *  el id de la nueva, o null si no hizo falta. */
export async function ordenarFallas(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  hallazgo: Hallazgo,
  tipo: TipoDeOrden
): Promise<number | null> {
  // Dos checklists de la misma unidad a la vez hacen cola aquí: si no, cada uno vería «sin orden» y
  // crearía la suya.
  const unidad = hallazgo.equipoId ?? clave(hallazgo.activoTexto ?? "");
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `hallazgo:${tenantId}:${unidad}`,
  ]);

  const abiertas = await client.query<{ descripcion: string; orden_trabajo_id: number }>(
    `SELECT lower(btrim(h.descripcion)) AS descripcion, max(o.id)::int AS orden_trabajo_id
       FROM orden_trabajo_hallazgos h
       JOIN ordenes_trabajo o ON o.id = h.orden_trabajo_id AND o.tenant_id = h.tenant_id
      WHERE h.tenant_id = $1 AND o.estado IN ('abierta', 'en_progreso')
        AND CASE WHEN $2::int IS NULL
              THEN o.equipo_id IS NULL AND lower(btrim(o.activo_texto)) = $3
              ELSE o.equipo_id = $2::int END
      GROUP BY 1`,
    [tenantId, hallazgo.equipoId, clave(hallazgo.activoTexto ?? "")]
  );
  const cubiertas = new Map(abiertas.rows.map((r) => [r.descripcion, r.orden_trabajo_id]));
  const nuevas = hallazgo.fallas.filter((f) => !cubiertas.has(clave(f.descripcion)));

  let ordenNueva: number | null = null;
  if (nuevas.length > 0) {
    const detalle = nuevas
      .map((f) => `- ${f.descripcion}${f.observacion ? `: ${f.observacion}` : ""}`)
      .join("\n");
    const r = await client.query<{ id: number }>(
      `INSERT INTO ordenes_trabajo
         (tenant_id, equipo_id, activo_texto, titulo, descripcion, tipo, prioridad, creado_por, origen,
          checklist_id, unidad_no_opera)
       VALUES ($1, $2, $3, $4, $5, 'correctivo', $6, $7, 'checklist', $8, $9)
       RETURNING id`,
      [
        tenantId,
        hallazgo.equipoId,
        hallazgo.activoTexto,
        `${tipo.titulo}: ${hallazgo.nombreActivo}`.slice(0, 150),
        `Puntos que fallaron:\n${detalle}`.slice(0, 2000),
        tipo.prioridad,
        usuarioId,
        hallazgo.checklistId,
        tipo.noOpera,
      ]
    );
    ordenNueva = r.rows[0].id;
  }

  const yaExistentes = [
    ...new Set(
      hallazgo.fallas
        .map((f) => cubiertas.get(clave(f.descripcion)))
        .filter((id): id is number => id !== undefined)
    ),
  ];
  if (tipo.noOpera && yaExistentes.length > 0) {
    await client.query(
      `UPDATE ordenes_trabajo
          SET unidad_no_opera = true,
              prioridad = CASE
                WHEN array_position(ARRAY['baja', 'media', 'alta', 'urgente'], prioridad::text)
                     < array_position(ARRAY['baja', 'media', 'alta', 'urgente'], $3::text)
                THEN $3 ELSE prioridad END
        WHERE tenant_id = $1 AND id = ANY($2::int[])`,
      [tenantId, yaExistentes, tipo.prioridad]
    );
  }

  for (const falla of hallazgo.fallas) {
    await client.query(
      `INSERT INTO orden_trabajo_hallazgos (tenant_id, orden_trabajo_id, checklist_id, descripcion)
       VALUES ($1, $2, $3, $4)`,
      [
        tenantId,
        cubiertas.get(clave(falla.descripcion)) ?? ordenNueva,
        hallazgo.checklistId,
        falla.descripcion,
      ]
    );
  }
  return ordenNueva;
}
