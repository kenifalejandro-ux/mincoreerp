/** src/modules/combustible/comprasCisterna.service.ts
 *
 * La compra de una cisterna, antes de que llegue (migración 0171): la encargada anota proveedor,
 * factura, fechas, cantidad facturada y costo. No es una orden de compra.
 *
 * El estado se DERIVA al leer (no hay columna): registrada (solo la ve quien gestiona compras),
 * por_llegar (la ve también la cancha: se habilitó o llegó el día estimado, en hora de Lima) y
 * anulada. Así no hace falta una tarea programada que se pueda caer.
 */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";
import { esViolacionUnicidad } from "../../server/shared/utils/pgError";
import { motivoGrifoNoAsignable } from "../../server/services/sedes.service";
import { LITROS_POR_GALON } from "../../server/shared/utils/unidades";
import type { CrearCompraCisternaInput } from "../../server/schemas/combustible.schema";
import { ALCANCE_TODO, type AlcanceCombustible } from "./alcance";
import { CombustibleRepository } from "./combustible.repository";

const repository = new CombustibleRepository();

export type EstadoDeCompra = "registrada" | "por_llegar" | "recibida" | "anulada";

const HOY_EN_LIMA = `(now() AT TIME ZONE 'America/Lima')::date`;

const COLUMNAS = `
  c.id, c.cliente_uuid, c.grifo_interno_id, c.grifo_id, g.nombre AS proveedor,
  c.tipo_combustible, c.unidad, c.tipo_documento, c.numero_documento,
  to_char(c.fecha_compra, 'YYYY-MM-DD') AS fecha_compra,
  to_char(c.llegada_estimada, 'YYYY-MM-DD') AS llegada_estimada,
  c.cantidad_facturada, c.costo_unitario, c.placa, c.chofer, c.transportista, c.transportista_ruc,
  c.habilitada_en, c.creado_en, c.anulada_en, c.motivo_anulacion, rv.id AS recepcion_id,
  CASE WHEN c.anulada_en IS NOT NULL THEN 'anulada'
       WHEN rv.id IS NOT NULL THEN 'recibida'
       WHEN c.habilitada_en IS NOT NULL OR c.llegada_estimada <= ${HOY_EN_LIMA} THEN 'por_llegar'
       ELSE 'registrada' END AS estado`;

// La recepción vigente de la compra (0173), si ya se descargó: es lo que la vuelve "recibida". Una
// recepción anulada no cuenta, así que anularla libera la compra sin tocarla.
const DESDE = `
  FROM combustible_compras_cisterna c
  JOIN combustible_grifos g ON g.id = c.grifo_id AND g.tenant_id = c.tenant_id
  LEFT JOIN LATERAL (
    SELECT r.id FROM combustible_recepciones r
     WHERE r.tenant_id = c.tenant_id AND r.compra_id = c.id AND r.anulada_en IS NULL
     LIMIT 1
  ) rv ON true`;

export const fueraDelAlcance = (alcance: AlcanceCombustible, grifoInternoId: number) =>
  !alcance.todo && !alcance.grifos.includes(Number(grifoInternoId));

/** La compra por id, o null si no existe o su sede está fuera del alcance. */
async function obtenerCompra(
  client: PoolClient,
  tenantId: string,
  id: number,
  alcance: AlcanceCombustible
) {
  const r = await client.query(`SELECT ${COLUMNAS} ${DESDE} WHERE c.tenant_id = $1 AND c.id = $2`, [
    tenantId,
    id,
  ]);
  const fila = r.rows[0] ?? null;
  return fila && !fueraDelAlcance(alcance, fila.grifo_interno_id) ? fila : null;
}

/** Registra la compra. Idempotente por `cliente_uuid`: un reintento devuelve la ya guardada
 *  (`creado: false`) sin crear otra. */
export async function crearCompra(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  data: CrearCompraCisternaInput,
  alcance: AlcanceCombustible
) {
  if (fueraDelAlcance(alcance, data.grifo_interno_id)) {
    throw new AppError(404, "El grifo no existe");
  }
  if (data.cliente_uuid) {
    const previa = await client.query<{ id: string }>(
      `SELECT id FROM combustible_compras_cisterna WHERE tenant_id = $1 AND cliente_uuid = $2`,
      [tenantId, data.cliente_uuid]
    );
    if (previa.rows[0]) {
      return {
        fila: await obtenerCompra(client, tenantId, Number(previa.rows[0].id), alcance),
        creado: false,
      };
    }
  }
  const noAsignable = await motivoGrifoNoAsignable(client, tenantId, data.grifo_interno_id);
  if (noAsignable) throw new AppError(400, noAsignable);
  const proveedor = await repository.findGrifoPorId(client, tenantId, data.grifo_id);
  if (!proveedor) throw new AppError(400, "El proveedor no existe");
  if (!proveedor.activo)
    throw new AppError(400, `El proveedor "${proveedor.nombre}" está desactivado`);
  if (!proveedor.abastece_tanque) {
    throw new AppError(
      400,
      `El proveedor "${proveedor.nombre}" no está marcado como proveedor de tanque (interno): márcalo en Proveedores o elige otro`
    );
  }
  try {
    const r = await client.query<{ id: string }>(
      `INSERT INTO combustible_compras_cisterna
         (tenant_id, cliente_uuid, grifo_interno_id, grifo_id, tipo_combustible, unidad,
          tipo_documento, numero_documento, fecha_compra, llegada_estimada,
          cantidad_facturada, costo_unitario, placa, chofer, usuario_id,
          transportista, transportista_ruc)
       VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17)
       RETURNING id`,
      [
        tenantId,
        data.cliente_uuid ?? null,
        data.grifo_interno_id,
        data.grifo_id,
        data.tipo_combustible,
        data.unidad,
        data.tipo_documento,
        data.numero_documento,
        data.fecha_compra,
        data.llegada_estimada,
        data.cantidad_facturada,
        data.costo_unitario,
        data.placa || null,
        data.chofer || null,
        usuarioId,
        data.transportista || null,
        data.transportista_ruc || null,
      ]
    );
    return {
      fila: await obtenerCompra(client, tenantId, Number(r.rows[0].id), alcance),
      creado: true,
    };
  } catch (err) {
    if (esViolacionUnicidad(err)) {
      throw new AppError(
        409,
        `Ya hay una compra con el documento ${data.numero_documento} de ${proveedor.nombre}`
      );
    }
    throw err;
  }
}

/** Las compras de las sedes del alcance, las más recientes primero. Quien no gestiona compras
 *  (la cancha) solo recibe las que ya están por llegar; las anuladas y las que la encargada aún
 *  no habilita no existen para ella. */
export async function listarCompras(
  client: PoolClient,
  tenantId: string,
  alcance: AlcanceCombustible,
  gestiona: boolean
) {
  const valores: unknown[] = [tenantId];
  const condiciones = ["c.tenant_id = $1"];
  if (!alcance.todo) {
    valores.push(alcance.grifos);
    condiciones.push(`c.grifo_interno_id = ANY($${valores.length}::int[])`);
  }
  if (!gestiona) {
    condiciones.push(
      `c.anulada_en IS NULL AND rv.id IS NULL
       AND (c.habilitada_en IS NOT NULL OR c.llegada_estimada <= ${HOY_EN_LIMA})`
    );
  }
  const r = await client.query(
    `SELECT ${COLUMNAS} ${DESDE} WHERE ${condiciones.join(" AND ")}
      ORDER BY c.llegada_estimada DESC, c.id DESC`,
    valores
  );
  return r.rows;
}

/** La encargada abre la compra a la cancha antes del día estimado. Idempotente. */
export async function habilitarCompra(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  alcance: AlcanceCombustible
) {
  const compra = await obtenerCompra(client, tenantId, id, alcance);
  if (!compra) throw new AppError(404, "La compra no existe");
  if (compra.estado === "anulada") throw new AppError(409, "La compra está anulada");
  if (compra.estado === "recibida") throw new AppError(409, "La compra ya se recibió");
  await client.query(
    `UPDATE combustible_compras_cisterna
        SET habilitada_en = COALESCE(habilitada_en, now()),
            habilitada_por = COALESCE(habilitada_por, $3)
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, usuarioId]
  );
  return (await obtenerCompra(client, tenantId, id, alcance))!;
}

/** Anula una compra con motivo. Nunca se borra: queda como evidencia. */
export async function anularCompra(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  motivo: string,
  alcance: AlcanceCombustible
) {
  const compra = await obtenerCompra(client, tenantId, id, alcance);
  if (!compra) throw new AppError(404, "La compra no existe");
  if (compra.estado === "anulada") throw new AppError(409, "La compra ya está anulada");
  if (compra.estado === "recibida") {
    throw new AppError(409, "La compra ya se recibió: anula primero su recepción");
  }
  await client.query(
    `UPDATE combustible_compras_cisterna
        SET anulada_en = now(), anulada_por = $3, motivo_anulacion = $4
      WHERE tenant_id = $1 AND id = $2 AND anulada_en IS NULL`,
    [tenantId, id, usuarioId, motivo]
  );
  return (await obtenerCompra(client, tenantId, id, alcance))!;
}

// ── La recepción vinculada a su compra (migración 0173) ─────────────────────

/** Lo que dejó el documento menos lo que se descargó, en galones (negativo: llegó menos, por la
 *  evaporación del viaje). Cada cantidad viene en SU unidad (la compra, el tanque). */
export function diferenciaEnGalones(opciones: {
  cantidadDelDocumento: number;
  unidadDelDocumento: string;
  descargado: number;
  unidadDelTanque: string;
}): number {
  const aGalones = (cantidad: number, unidad: string) =>
    unidad === "L" ? cantidad / LITROS_POR_GALON : cantidad;
  const diferencia =
    aGalones(opciones.descargado, opciones.unidadDelTanque) -
    aGalones(opciones.cantidadDelDocumento, opciones.unidadDelDocumento);
  return Math.round(diferencia * 100) / 100;
}

/** La tolerancia de la empresa en galones; 3 mientras nadie la fije. */
export async function obtenerTolerancia(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query<{ t: string }>(
    `SELECT tolerancia_diferencia_compra AS t FROM combustible_config WHERE tenant_id = $1`,
    [tenantId]
  );
  return r.rows[0] ? Number(r.rows[0].t) : 3;
}

export async function fijarTolerancia(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  galones: number
): Promise<number> {
  await client.query(
    `INSERT INTO combustible_config (tenant_id, tolerancia_diferencia_compra, actualizado_por)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE
       SET tolerancia_diferencia_compra = EXCLUDED.tolerancia_diferencia_compra,
           actualizado_por = EXCLUDED.actualizado_por,
           actualizado_en = now()`,
    [tenantId, galones, usuarioId]
  );
  return obtenerTolerancia(client, tenantId);
}

/** La compra que se va a recibir, bloqueada para que dos descargas no la tomen a la vez. Quien no
 *  gestiona compras (la cancha) solo puede recibir las que ya están por llegar: las otras no
 *  existen para esa persona. Responde con `Error` simple, como el resto de validaciones de la
 *  recepción (el controlador lo vuelve 400). */
export async function cargarCompraParaRecepcion(
  client: PoolClient,
  tenantId: string,
  compraId: number,
  alcance: AlcanceCombustible | undefined,
  gestiona: boolean
) {
  const bloqueo = await client.query(
    `SELECT id FROM combustible_compras_cisterna WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, compraId]
  );
  const compra = bloqueo.rows[0]
    ? await obtenerCompra(client, tenantId, compraId, alcance ?? ALCANCE_TODO)
    : null;
  if (!compra || (!gestiona && compra.estado === "registrada")) {
    throw new AppError(
      400,
      `la compra ${compraId} no existe o todavía no está habilitada para recibirse`
    );
  }
  if (compra.estado === "anulada") throw new AppError(400, `la compra ${compraId} está anulada`);
  if (compra.estado === "recibida") {
    throw new AppError(
      400,
      `la compra ${compraId} ya tiene su recepción (#${compra.recepcion_id})`
    );
  }
  return compra;
}

/** La compra tiene que ser del mismo combustible, de la misma sede y del mismo proveedor que la
 *  recepción: lo contrario es un error de selección que ninguna alerta debería tapar. */
export function motivoCompraNoCoincide(
  compra: { tipo_combustible: string; grifo_interno_id: number; grifo_id: number },
  tanque: { tipo_combustible: string; grifo_interno_id: number },
  grifoId: number
): string | null {
  if (compra.tipo_combustible !== tanque.tipo_combustible) {
    return "la compra es de otro tipo de combustible que el del tanque";
  }
  if (Number(compra.grifo_interno_id) !== Number(tanque.grifo_interno_id)) {
    return "la compra llega a otro grifo que el del tanque";
  }
  if (Number(compra.grifo_id) !== Number(grifoId)) {
    return "el proveedor de la recepción no es el de la compra";
  }
  return null;
}

/** ¿La empresa ya usa las compras de cisterna? Sin ninguna compra registrada no tiene sentido
 *  avisar "descarga sin compra" en cada recepción: el aviso solo corre para quien adoptó el flujo. */
export async function empresaUsaCompras(client: PoolClient, tenantId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM combustible_compras_cisterna WHERE tenant_id = $1 AND anulada_en IS NULL LIMIT 1`,
    [tenantId]
  );
  return r.rows.length > 0;
}

/** Vincula una compra a una recepción que se hizo antes (la cancha descargó sin que la compra
 *  estuviera registrada). Resuelve la alerta "sin compra" y revisa la diferencia. */
export async function vincularCompra(
  client: PoolClient,
  tenantId: string,
  compraId: number,
  recepcionId: number,
  alcance: AlcanceCombustible
) {
  const compra = await cargarCompraParaRecepcion(client, tenantId, compraId, alcance, true).catch(
    (e: Error) => {
      throw new AppError(409, e.message);
    }
  );
  const r = await client.query<{
    id: string;
    producto: string;
    grifo_id: number;
    compra_id: string | null;
    anulada_en: Date | null;
    cantidad: string;
    cantidad_derivada: string;
    combustible_id: number;
    tipo_combustible: string;
    unidad: string;
    grifo_interno_id: number;
  }>(
    `SELECT r.id, r.producto, r.grifo_id, r.compra_id, r.anulada_en, r.cantidad, r.cantidad_derivada,
            c.id AS combustible_id, c.tipo_combustible, c.unidad, c.grifo_interno_id
       FROM combustible_recepciones r
       JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.id = $2 AND r.producto = 'combustible'
      FOR UPDATE OF r`,
    [tenantId, recepcionId]
  );
  const rec = r.rows[0];
  if (!rec || fueraDelAlcance(alcance, rec.grifo_interno_id)) {
    throw new AppError(404, "La recepción no existe");
  }
  if (rec.anulada_en) throw new AppError(409, "La recepción está anulada");
  if (rec.compra_id !== null) throw new AppError(409, "La recepción ya tiene una compra");
  const motivo = motivoCompraNoCoincide(compra, rec, rec.grifo_id);
  if (motivo) throw new AppError(400, motivo);

  await client.query(
    `UPDATE combustible_recepciones SET compra_id = $3 WHERE tenant_id = $1 AND id = $2`,
    [tenantId, recepcionId, compraId]
  );
  await client.query(
    `UPDATE combustible_alertas SET resuelta_en = now()
      WHERE tenant_id = $1 AND recepcion_id = $2 AND tipo = 'recepcion_sin_compra'
        AND resuelta_en IS NULL`,
    [tenantId, recepcionId]
  );
  const descargado = Number(rec.cantidad) + Number(rec.cantidad_derivada);
  await avisarDiferencia(client, tenantId, {
    compra,
    recepcionId,
    combustibleId: rec.combustible_id,
    descargado,
    unidadDelTanque: rec.unidad,
  });
  return (await obtenerCompra(client, tenantId, compraId, alcance))!;
}

/** Abre la alerta `compra_diferencia` si lo descargado se aparta del documento más que la tolerancia
 *  de la empresa. Devuelve la diferencia en galones (negativa: llegó menos). */
export async function avisarDiferencia(
  client: PoolClient,
  tenantId: string,
  datos: {
    compra: {
      id: string;
      cantidad_facturada: string;
      unidad: string;
      numero_documento: string;
      proveedor: string;
    };
    recepcionId: number;
    combustibleId: number;
    descargado: number;
    unidadDelTanque: string;
  }
): Promise<number> {
  const diferencia = diferenciaEnGalones({
    cantidadDelDocumento: Number(datos.compra.cantidad_facturada),
    unidadDelDocumento: datos.compra.unidad,
    descargado: datos.descargado,
    unidadDelTanque: datos.unidadDelTanque,
  });
  const tolerancia = await obtenerTolerancia(client, tenantId);
  if (Math.abs(diferencia) > tolerancia) {
    await repository.crearAlertas(client, tenantId, [
      {
        tipo: "compra_diferencia",
        recepcionId: datos.recepcionId,
        combustibleId: datos.combustibleId,
        detalle: {
          compraId: Number(datos.compra.id),
          documento: datos.compra.numero_documento,
          proveedor: datos.compra.proveedor,
          cantidadDelDocumento: Number(datos.compra.cantidad_facturada),
          descargado: datos.descargado,
          diferenciaGalones: diferencia,
          toleranciaGalones: tolerancia,
        },
      },
    ]);
  }
  return diferencia;
}

/** Una descarga sin compra: queda anotada hasta que la encargada la vincule. Solo para quien ya usa
 *  las compras (ver empresaUsaCompras). */
export async function avisarDescargaSinCompra(
  client: PoolClient,
  tenantId: string,
  recepcionId: number,
  combustibleId: number
): Promise<void> {
  if (!(await empresaUsaCompras(client, tenantId))) return;
  await repository.crearAlertas(client, tenantId, [
    { tipo: "recepcion_sin_compra", recepcionId, combustibleId, detalle: {} },
  ]);
}

/** Lo que necesita el formulario de "Registrar compra": los proveedores de tanque activos, las sedes
 *  del alcance y el último precio de compra de cada proveedor por combustible. Va en un solo
 *  pedido y detrás del permiso de registrar compras: no depende de los listados de despacho. */
export async function datosParaElFormulario(
  client: PoolClient,
  tenantId: string,
  alcance: AlcanceCombustible
) {
  const proveedores = await client.query(
    `SELECT id, nombre FROM combustible_grifos
      WHERE tenant_id = $1 AND activo AND abastece_tanque AND NOT es_otros
      ORDER BY lower(nombre)`,
    [tenantId]
  );
  const valores: unknown[] = [tenantId];
  let filtro = "";
  if (!alcance.todo) {
    valores.push(alcance.grifos);
    filtro = "AND g.id = ANY($2::int[])";
  }
  const sedes = await client.query(
    `SELECT g.id, g.nombre, s.nombre AS sede
       FROM grifos_internos g
       JOIN sedes s ON s.id = g.sede_id AND s.tenant_id = g.tenant_id
      WHERE g.tenant_id = $1 AND g.activo ${filtro}
      ORDER BY s.nombre, g.nombre`,
    valores
  );
  // El precio vigente HOY de cada proveedor por combustible (el más reciente que ya rige).
  const precios = await client.query(
    `SELECT DISTINCT ON (grifo_id, tipo_combustible)
            grifo_id, tipo_combustible, precio_unitario
       FROM combustible_precios
      WHERE tenant_id = $1 AND grifo_id IS NOT NULL AND anulada_en IS NULL
        AND vigente_desde <= now()
      ORDER BY grifo_id, tipo_combustible, vigente_desde DESC, id DESC`,
    [tenantId]
  );
  return { proveedores: proveedores.rows, sedes: sedes.rows, precios: precios.rows };
}
