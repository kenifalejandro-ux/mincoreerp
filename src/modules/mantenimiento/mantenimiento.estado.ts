/** src/modules/mantenimiento/mantenimiento.estado.ts
 *
 * El estado de cada unidad (M5). No se guarda: se calcula al consultar, leyendo las órdenes de trabajo y los
 * checklists. Se toma la primera regla que se cumpla:
 *
 *  1. DETENIDA: tiene una orden abierta urgente o marcada «no puede operar».
 *  2. DETENIDA: su último checklist dice que no sale (o espera autorización) y no generó ninguna orden. Si
 *     generó una, mandan las órdenes: al completarla o cancelarla la unidad queda libre. Un checklist
 *     posterior sin fallas reemplaza al anterior, así que también la libera (no cierra órdenes).
 *  3. EN MANTENIMIENTO: tiene una orden en progreso.
 *  4. OPERATIVA.
 *
 * Con la regla «exigir conformidad» encendida, una orden completada que la espera sigue pesando hasta que se
 * dé: detiene si detenía; si no, la unidad queda en mantenimiento.
 *
 * Sin Órdenes de trabajo cuentan solo los checklists, y al revés; sin ninguno, todas operativas. La lectura
 * del módulo que falta no se ejecuta. */
import type { PoolClient } from "pg";

export type EstadoDeUnidad = "detenida" | "en_mantenimiento" | "operativa";

export interface Estado {
  estado: EstadoDeUnidad;
  /** «Qué pasa»; null si está operativa. */
  motivo: string | null;
}

export interface Fuentes {
  conOrdenes: boolean;
  conChecklists: boolean;
}

const OPERATIVA: Estado = { estado: "operativa", motivo: null };

interface Orden {
  equipo_id: number;
  id: number;
  titulo: string;
  estado: string;
  detiene: boolean;
}

/** La orden que más pesa de cada unidad: primero las que la detienen, luego las en progreso y al final las
 *  completadas que esperan conformidad. */
async function ordenesQuePesan(client: PoolClient, tenantId: string) {
  const r = await client.query<Orden>(
    `SELECT DISTINCT ON (equipo_id) equipo_id, id, titulo, estado, detiene
       FROM (SELECT equipo_id, id, titulo, estado,
                    (prioridad = 'urgente' OR unidad_no_opera) AS detiene
               FROM ordenes_trabajo
              WHERE tenant_id = $1 AND equipo_id IS NOT NULL
                AND (estado IN ('abierta', 'en_progreso')
                     OR (requiere_conformidad AND conformidad_en IS NULL AND estado = 'completada'
                         AND EXISTS (SELECT 1 FROM mantenimiento_config m
                                      WHERE m.tenant_id = $1 AND m.exige_conformidad)))) o
      WHERE detiene OR estado <> 'abierta'
      ORDER BY equipo_id, detiene DESC, (estado = 'completada'), id DESC`,
    [tenantId]
  );
  return new Map(r.rows.map((o) => [o.equipo_id, o]));
}

interface Salida {
  equipo_id: number;
  salida: string | null;
  fallas: string | null;
  genero_orden: boolean;
}

/** El último checklist de cada unidad (el último que llegó al servidor). */
async function ultimosChecklists(client: PoolClient, tenantId: string, conOrdenes: boolean) {
  // «¿Generó orden?» solo se pregunta si se leen las órdenes: sin ese módulo manda el checklist.
  const generoOrden = conOrdenes
    ? `(EXISTS (SELECT 1 FROM ordenes_trabajo o
                 WHERE o.tenant_id = u.tenant_id AND o.checklist_id = u.id)
        OR EXISTS (SELECT 1 FROM orden_trabajo_hallazgos h
                    WHERE h.tenant_id = u.tenant_id AND h.checklist_id = u.id))`
    : "false";
  const r = await client.query<Salida>(
    `SELECT u.equipo_id, u.salida, ${generoOrden} AS genero_orden,
            (SELECT string_agg(i.descripcion, ', ' ORDER BY i.id) FROM checklist_items i
              WHERE i.tenant_id = u.tenant_id AND i.checklist_id = u.id AND i.estado = 'malo') AS fallas
       FROM (SELECT DISTINCT ON (equipo_id) tenant_id, id, equipo_id, salida
               FROM checklists
              WHERE tenant_id = $1 AND equipo_id IS NOT NULL
              ORDER BY equipo_id, id DESC) u`,
    [tenantId]
  );
  return new Map(r.rows.map((c) => [c.equipo_id, c]));
}

const MOTIVO_DE_SALIDA: Record<string, string> = {
  no_sale: "Checklist: no sale",
  rechazada: "Salida no autorizada",
  por_autorizar: "Espera autorización",
};

/** Devuelve cómo preguntar el estado de una unidad por su id. */
export async function estadosDeUnidades(client: PoolClient, tenantId: string, fuentes: Fuentes) {
  const ordenes = fuentes.conOrdenes
    ? await ordenesQuePesan(client, tenantId)
    : new Map<number, Orden>();
  const checklists = fuentes.conChecklists
    ? await ultimosChecklists(client, tenantId, fuentes.conOrdenes)
    : new Map<number, Salida>();

  return (equipoId: number): Estado => {
    const orden = ordenes.get(equipoId);
    const falta = orden?.estado === "completada" ? " (falta conformidad)" : "";
    if (orden?.detiene) {
      return { estado: "detenida", motivo: `OT #${orden.id}${falta}: ${orden.titulo}` };
    }
    const checklist = checklists.get(equipoId);
    const motivo = checklist?.salida ? MOTIVO_DE_SALIDA[checklist.salida] : undefined;
    if (checklist && motivo && !checklist.genero_orden) {
      return {
        estado: "detenida",
        motivo: checklist.fallas ? `${motivo}: ${checklist.fallas}` : motivo,
      };
    }
    if (orden) {
      const paso = falta || " en progreso";
      return { estado: "en_mantenimiento", motivo: `OT #${orden.id}${paso}: ${orden.titulo}` };
    }
    return OPERATIVA;
  };
}
