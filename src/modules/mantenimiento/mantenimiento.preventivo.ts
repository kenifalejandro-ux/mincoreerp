/** src/modules/mantenimiento/mantenimiento.preventivo.ts
 *
 * El preventivo en la base (M9): el resumen (qué le toca a cada equipo) y los servicios realizados. Usa solo
 * tablas de Mantenimiento y las base (`equipos`, `equipo_lecturas`): no lee otros módulos. Todo corre dentro de
 * `withTenant`. */
import type { PoolClient } from "pg";

import type { RegistrarLecturaInput } from "../../server/schemas/equipos.schema";
import type { RegistrarServicioInput } from "../../server/schemas/mantenimientoServicios.schema";
import { verificarCuota } from "../../server/services/platformCuotas.service";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { huellaDeRegistro, idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { anularLectura, registrarLectura } from "../equipos/equipos.lecturas";
import {
  calcularProximo,
  cumplimiento,
  pasoDelNivel,
  pasoSiguiente,
  type EstadoPreventivo,
  type ServicioPrevio,
} from "./mantenimiento.calculo";
import { listarPlanes, tipoLimpio, type Plan } from "./mantenimiento.planes";
import { MantenimientoService } from "./mantenimiento.service";

const service = new MantenimientoService();

type Medida = "horometro" | "odometro";
const ETIQUETA_MEDIDA = { horometro: "horas", odometro: "km" } as const;

const COLUMNAS_SERVICIO = `s.id::int AS id, s.equipo_id, s.nivel, s.paso, s.medida,
  s.lectura::float8 AS lectura, s.hecho_en, s.observacion, s.creado_en,
  EXISTS (SELECT 1 FROM equipo_lecturas l
           WHERE l.tenant_id = s.tenant_id AND l.id = s.lectura_id
             AND l.anulada_en IS NOT NULL) AS lectura_anulada,
  u.nombre AS registrado_por, s.anulado_en, s.motivo_anulacion, ua.nombre AS anulado_por_nombre`;
const DESDE_SERVICIO = `FROM mantenimiento_servicios s
  LEFT JOIN usuarios u ON u.id = s.creado_por
  LEFT JOIN usuarios ua ON ua.id = s.anulado_por`;

/** Un servicio cuenta si no está anulado y su lectura tampoco (se puede anular desde la ficha de la unidad en
 *  Flota): con el dato declarado erróneo no se calcula nada. */
const CUENTA = `s.anulado_en IS NULL AND NOT EXISTS (
  SELECT 1 FROM equipo_lecturas l
   WHERE l.tenant_id = s.tenant_id AND l.id = s.lectura_id AND l.anulada_en IS NOT NULL)`;

async function leerServicio(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(
    `SELECT ${COLUMNAS_SERVICIO} ${DESDE_SERVICIO} WHERE s.tenant_id = $1 AND s.id = $2`,
    [tenantId, id]
  );
  return r.rows[0] ?? null;
}

/** Los servicios de un equipo, el más reciente primero, con los anulados y su motivo. */
export async function serviciosDeEquipo(client: PoolClient, tenantId: string, equipoId: number) {
  if (!(await service.obtenerEquipo(client, tenantId, equipoId, true))) {
    throw new AppError(404, "El equipo no existe");
  }
  const r = await client.query(
    `SELECT ${COLUMNAS_SERVICIO} ${DESDE_SERVICIO}
      WHERE s.tenant_id = $1 AND s.equipo_id = $2
      ORDER BY s.hecho_en DESC, s.id DESC LIMIT 200`,
    [tenantId, equipoId]
  );
  return r.rows;
}

/** El último servicio que cuenta de cada equipo en cada medida (si le cambian el medidor, lo anterior no cuenta). */
async function ultimosServicios(client: PoolClient, tenantId: string, equipoId?: number) {
  const r = await client.query<
    ServicioPrevio & { id: number; equipo_id: number; medida: Medida; hecho_en: Date }
  >(
    `SELECT DISTINCT ON (equipo_id, medida) id::int AS id, equipo_id, medida, nivel, paso,
            lectura::float8 AS lectura, hecho_en
       FROM mantenimiento_servicios s
      WHERE tenant_id = $1 AND ${CUENTA} AND ($2::int IS NULL OR equipo_id = $2)
      ORDER BY equipo_id, medida, hecho_en DESC, id DESC`,
    [tenantId, equipoId ?? null]
  );
  return new Map(r.rows.map((s) => [`${s.equipo_id}:${s.medida}`, s]));
}

/** Qué plan le toca a cada equipo activo (por su tipo, con la misma limpieza que al guardar el plan). */
async function planDeCadaEquipo(client: PoolClient, tenantId: string) {
  const r = await client.query<{ equipo_id: number; plan_id: number }>(
    `SELECT e.id::int AS equipo_id, p.id::int AS plan_id
       FROM equipos e
       JOIN mantenimiento_planes p
         ON p.tenant_id = e.tenant_id AND lower(p.tipo_equipo) = lower(${tipoLimpio("e.tipo")})
      WHERE e.tenant_id = $1 AND e.activo`,
    [tenantId]
  );
  return new Map(r.rows.map((f) => [f.equipo_id, f.plan_id]));
}

/** El resumen del preventivo: cada equipo con plan, lo que le toca, y los totales por nivel. Todo se calcula al
 *  consultar. */
export async function resumenPreventivo(client: PoolClient, tenantId: string) {
  const { planes } = await listarPlanes(client, tenantId);
  const porId = new Map<number, Plan>(planes.map((p) => [p.id, p]));
  const planDe = await planDeCadaEquipo(client, tenantId);
  const ultimos = await ultimosServicios(client, tenantId);
  const { equipos, total } = await service.listarEquipos(client, tenantId, {});
  const { meta_preventivo } = await service.obtenerConfig(client, tenantId);

  const filas = equipos.flatMap((e) => {
    const plan = porId.get(planDe.get(e.id) ?? 0);
    if (!plan) return [];
    const mismaMedida = plan.medida === e.medidor;
    const ultimo = mismaMedida ? (ultimos.get(`${e.id}:${plan.medida}`) ?? null) : null;
    const proximo = calcularProximo(plan, ultimo, e.lectura);
    const estado: EstadoPreventivo = proximo?.estado ?? "sin_datos";
    return [
      {
        equipo_id: e.id,
        placa_codigo: e.placa_codigo,
        tipo: e.tipo,
        area: e.area,
        propiedad: e.propiedad,
        plan_id: plan.id,
        medida: plan.medida,
        medidor_del_equipo: e.medidor,
        lectura: e.lectura,
        estado,
        // Por qué no se puede calcular.
        motivo: !mismaMedida ? "medidor_distinto" : !ultimo ? "sin_servicio" : null,
        ultimo,
        proximo,
      },
    ];
  });

  const contar = (estado: EstadoPreventivo, lista = filas) =>
    lista.filter((f) => f.estado === estado).length;
  const totales = (lista: typeof filas) => ({
    al_dia: contar("al_dia", lista),
    proximo: contar("proximo", lista),
    vencido: contar("vencido", lista),
  });
  return {
    meta: meta_preventivo,
    cumplimiento: cumplimiento(filas.map((f) => f.estado)),
    totales: { ...totales(filas), sin_datos: contar("sin_datos"), sin_plan: total - filas.length },
    niveles: [1, 2, 3].map((nivel) => ({
      nivel,
      ...totales(filas.filter((f) => f.proximo?.nivel === nivel)),
    })),
    equipos: filas,
  };
}

/** Bloquea el equipo (misma fuerza que las lecturas): dos registros del mismo equipo hacen cola. */
async function bloquearEquipo(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(
    `SELECT 1 FROM equipos WHERE tenant_id = $1 AND id = $2 AND activo FOR NO KEY UPDATE`,
    [tenantId, id]
  );
  if (!r.rowCount) throw new AppError(404, "El equipo no existe");
}

/** Mantenimiento muestra como horómetro el equipo que no tiene medidor definido: al anotarle un dato, queda
 *  guardado así en el maestro. */
async function definirMedidor(client: PoolClient, tenantId: string, equipoId: number) {
  await client.query(
    `UPDATE equipos SET tipo_medidor = 'horometro'
      WHERE tenant_id = $1 AND id = $2 AND tipo_medidor IS NULL`,
    [tenantId, equipoId]
  );
}

/** Una lectura anotada desde Mantenimiento: a un equipo quitado no se le agregan datos. El reintento de una que
 *  ya había entrado sí responde, aunque el equipo se haya quitado después. */
export async function registrarLecturaDeMantenimiento(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  equipoId: number,
  data: RegistrarLecturaInput
) {
  // El mismo candado que toma la lectura: nadie quita el equipo entre mirar y guardar.
  const r = await client.query<{ activo: boolean }>(
    "SELECT activo FROM equipos WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE",
    [tenantId, equipoId]
  );
  if (!r.rows[0]) throw new AppError(404, "El equipo no existe");
  await definirMedidor(client, tenantId, equipoId);
  await verificarCuota(tenantId, "equipo_lecturas", 1, client);
  const resultado = await registrarLectura(client, tenantId, usuarioId, equipoId, data);
  // Lanzar deshace todo, también el medidor que se acaba de definir.
  if (resultado.creado && !r.rows[0].activo) throw new AppError(404, "El equipo no existe");
  return resultado;
}

/** Anota un servicio hecho y deja la lectura del medidor de ese momento, con sus reglas (no retroceder). Si la
 *  lectura no cuadra, no se guarda nada. */
export async function registrarServicio(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  data: RegistrarServicioInput
) {
  return idempotentInsert({
    client,
    tenantId,
    modulo: "mantenimiento",
    clienteUuid: data.cliente_uuid,
    huella: huellaDeRegistro("mantenimiento_servicio", {
      equipo_id: data.equipo_id,
      nivel: data.nivel,
      lectura: data.lectura,
    }),
    insertar: async () => {
      await bloquearEquipo(client, tenantId, data.equipo_id);
      await definirMedidor(client, tenantId, data.equipo_id);
      const equipo = (await service.obtenerEquipo(client, tenantId, data.equipo_id))!;
      const planId = (await planDeCadaEquipo(client, tenantId)).get(equipo.id);
      const plan = (await listarPlanes(client, tenantId)).planes.find((p) => p.id === planId);
      if (!plan) {
        throw new AppError(409, `Todavía no hay un plan para el tipo «${equipo.tipo}»`);
      }
      if (plan.medida !== equipo.medidor) {
        throw new AppError(
          409,
          `El plan cuenta en ${ETIQUETA_MEDIDA[plan.medida]} y el equipo mide ` +
            `en ${ETIQUETA_MEDIDA[equipo.medidor]}: corrige uno de los dos`
        );
      }
      const repetido = await client.query(
        `SELECT 1 FROM mantenimiento_servicios s
          WHERE tenant_id = $1 AND equipo_id = $2 AND medida = $3 AND nivel = $4 AND lectura = $5
            AND ${CUENTA}`,
        [tenantId, equipo.id, plan.medida, data.nivel, data.lectura]
      );
      if (repetido.rowCount) {
        throw new AppError(409, `Ese MP${data.nivel} ya está registrado con esa lectura`);
      }
      const ultimo = (await ultimosServicios(client, tenantId, equipo.id)).get(
        `${equipo.id}:${plan.medida}`
      );
      const paso =
        data.paso ??
        pasoDelNivel(plan.ciclo, pasoSiguiente(plan.ciclo, ultimo ?? null), data.nivel);
      if (paso === null || plan.ciclo[paso] !== data.nivel) {
        throw new AppError(400, `El MP${data.nivel} no está en esa posición del ciclo del plan`);
      }
      await verificarCuota(tenantId, "equipo_lecturas", 1, client);
      const lectura = await registrarLectura(client, tenantId, usuarioId, equipo.id, {
        valor: data.lectura,
        leido_en: data.hecho_en,
      });
      const creado = await client.query<{ id: number }>(
        `INSERT INTO mantenimiento_servicios
           (tenant_id, equipo_id, nivel, paso, medida, lectura, lectura_id, hecho_en,
            observacion, creado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id::int AS id`,
        [
          tenantId,
          equipo.id,
          data.nivel,
          paso,
          plan.medida,
          data.lectura,
          lectura.fila.id,
          data.hecho_en,
          data.observacion,
          usuarioId,
        ]
      );
      const id = creado.rows[0].id;
      return { id, fila: await leerServicio(client, tenantId, id) };
    },
    recuperar: (id) => leerServicio(client, tenantId, id),
  });
}

/** Anula un servicio y la lectura que dejó (si el dato estaba mal, no debe seguir contando). */
export async function anularServicio(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  motivo: string
) {
  const previo = await client.query<{ equipo_id: number }>(
    "SELECT equipo_id FROM mantenimiento_servicios WHERE tenant_id = $1 AND id = $2",
    [tenantId, id]
  );
  if (!previo.rows[0]) throw new AppError(404, "El servicio no existe");
  const equipoId = previo.rows[0].equipo_id;
  // Primero el equipo (mismo orden que al registrar) y recién entonces se mira si ya está anulado.
  await client.query("SELECT 1 FROM equipos WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE", [
    tenantId,
    equipoId,
  ]);
  const r = await client.query<{ lectura_id: number | null }>(
    `UPDATE mantenimiento_servicios
        SET anulado_en = clock_timestamp(), anulado_por = $3, motivo_anulacion = $4
      WHERE tenant_id = $1 AND id = $2 AND anulado_en IS NULL
      RETURNING lectura_id::int AS lectura_id`,
    [tenantId, id, usuarioId, motivo]
  );
  if (!r.rows[0]) throw new AppError(409, "Ese servicio ya está anulado");
  const lecturaId = r.rows[0].lectura_id;
  if (lecturaId) {
    const vigente = await client.query(
      "SELECT 1 FROM equipo_lecturas WHERE tenant_id = $1 AND id = $2 AND anulada_en IS NULL",
      [tenantId, lecturaId]
    );
    if (vigente.rowCount) {
      await anularLectura(client, tenantId, usuarioId, equipoId, lecturaId, motivo);
    }
  }
  return leerServicio(client, tenantId, id);
}

/** La lectura de un servicio vigente se corrige anulando el servicio, no sola. */
export async function exigirLecturaSinServicio(
  client: PoolClient,
  tenantId: string,
  lecturaId: number
) {
  const r = await client.query(
    `SELECT 1 FROM mantenimiento_servicios
      WHERE tenant_id = $1 AND lectura_id = $2 AND anulado_en IS NULL`,
    [tenantId, lecturaId]
  );
  if (r.rowCount) {
    throw new AppError(409, "Esa lectura es de un servicio registrado: anula el servicio");
  }
}
