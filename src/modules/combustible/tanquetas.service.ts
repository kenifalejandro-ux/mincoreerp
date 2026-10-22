/** src/modules/combustible/tanquetas.service.ts
 *
 * Tanquetas / cubetas (migración 0111): depósitos chicos (280 gal) sin varilla
 * ni medidor, con código propio. Alojan el excedente de una recepción que no
 * cabe en el tanque y sirven de previsión en ruta.
 *
 * El SALDO SE DERIVA: entradas (líneas de excedente de recepciones no
 * anuladas) menos salidas (la carga en ruta, entrega siguiente). No hay
 * columna de saldo que pueda divergir del historial.
 *
 * Pertenece a un grifo interno (la sede donde se llena): solo recibe el
 * excedente de los tanques de SU grifo.
 */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";
import { esViolacionUnicidad } from "../../server/shared/utils/pgError";
import { motivoGrifoNoAsignable } from "../../server/services/sedes.service";
import { LITROS_POR_GALON } from "../../server/shared/utils/unidades";
import { ALCANCE_TODO, type AlcanceCombustible } from "./alcance";
import { CombustibleRepository } from "./combustible.repository";

export const CAPACIDAD_TANQUETA_DEFECTO = 280;

/** Cuántas tanquetas puede llevar una unidad a la vez (0139). */
export const MAX_TANQUETAS_POR_UNIDAD = 3;

/** Lo que entró a la tanqueta: el excedente de recepciones vigentes (0111), los
 *  vales del tanque a "reserva en cubeta" que la eligieron (0114) y el saldo
 *  que otra tanqueta le pasó al recibirla de vuelta (0146). Anular una
 *  recepción o un vale devuelve el espacio. */
const SQL_ENTRADAS = `
  (COALESCE((
    SELECT SUM(x.cantidad)
      FROM combustible_recepcion_excedentes x
      JOIN combustible_recepciones r ON r.id = x.recepcion_id AND r.tenant_id = x.tenant_id
     WHERE x.tenant_id = t.tenant_id AND x.tanqueta_id = t.id AND r.anulada_en IS NULL
  ), 0) + COALESCE((
    SELECT SUM(d.cantidad) FROM combustible_despachos d
     WHERE d.tenant_id = t.tenant_id AND d.tanqueta_destino_id = t.id AND d.anulada_en IS NULL
  ), 0) + COALESCE((
    SELECT SUM(r.saldo_validado) FROM combustible_tanqueta_retornos r
     WHERE r.tenant_id = t.tenant_id AND r.tanqueta_destino_id = t.id AND r.destino = 'tanqueta'
  ), 0))`;

/** Lo que entró por cada camino, para que el panel muestre de dónde vino. */
const SQL_ENTRADAS_EXCEDENTE = `
  COALESCE((
    SELECT SUM(x.cantidad)
      FROM combustible_recepcion_excedentes x
      JOIN combustible_recepciones r ON r.id = x.recepcion_id AND r.tenant_id = x.tenant_id
     WHERE x.tenant_id = t.tenant_id AND x.tanqueta_id = t.id AND r.anulada_en IS NULL
  ), 0)`;
const SQL_ENTRADAS_PREVISION = `
  COALESCE((
    SELECT SUM(d.cantidad) FROM combustible_despachos d
     WHERE d.tenant_id = t.tenant_id AND d.tanqueta_destino_id = t.id AND d.anulada_en IS NULL
  ), 0)`;

const SQL_ENTRADAS_TRASLADO = `
  COALESCE((
    SELECT SUM(r.saldo_validado) FROM combustible_tanqueta_retornos r
     WHERE r.tenant_id = t.tenant_id AND r.tanqueta_destino_id = t.id AND r.destino = 'tanqueta'
  ), 0)`;

/** Lo que salió: las cargas desde la tanqueta, en ruta o en planta (0114/0115),
 *  y el saldo que se fue al pozo o a otra tanqueta al recibirla de vuelta
 *  (0145/0146). Lo que se va es lo que el grifero validó, en galones: la
 *  columna `cantidad_pozo` está en la unidad del tanque. */
const SQL_SALIDAS = `
  (COALESCE((
    SELECT SUM(d.cantidad) FROM combustible_despachos d
     WHERE d.tenant_id = t.tenant_id AND d.tanqueta_origen_id = t.id AND d.anulada_en IS NULL
  ), 0) + COALESCE((
    SELECT SUM(r.saldo_validado) FROM combustible_tanqueta_retornos r
     WHERE r.tenant_id = t.tenant_id AND r.tanqueta_id = t.id
       AND r.destino IN ('pozo', 'tanqueta')
  ), 0))`;

/** Lo que el grifero corrigió al recibir la tanqueta de vuelta (0143): la
 *  diferencia con signo entre lo que validó y lo que calculaba el sistema. */
const SQL_AJUSTES = `
  COALESCE((
    SELECT SUM(r.diferencia) FROM combustible_tanqueta_retornos r
     WHERE r.tenant_id = t.tenant_id AND r.tanqueta_id = t.id
  ), 0)`;

/** La asignación a una unidad (0139) vale mientras la tanqueta tenga saldo:
 *  al vaciarse deja de contar sola, sin columna de "libre" que pueda divergir. */
const SQL_ASIGNADA_VIGENTE = `(t.equipo_asignado_id IS NOT NULL AND ${SQL_ENTRADAS} + ${SQL_AJUSTES} - ${SQL_SALIDAS} > 0)`;

const COLUMNAS = `
  t.id, t.grifo_interno_id, t.codigo, t.capacidad, t.activa, t.motivo_baja, t.creado_en,
  t.equipo_asignado_id, t.asignada_en,
  ${SQL_ASIGNADA_VIGENTE} AS asignada_vigente,
  ${SQL_ENTRADAS} AS entradas,
  ${SQL_ENTRADAS_EXCEDENTE} AS entradas_excedente,
  ${SQL_ENTRADAS_PREVISION} AS entradas_prevision,
  ${SQL_ENTRADAS_TRASLADO} AS entradas_traslado,
  ${SQL_SALIDAS} AS salidas,
  ${SQL_ENTRADAS} + ${SQL_AJUSTES} - ${SQL_SALIDAS} AS saldo,
  t.capacidad - (${SQL_ENTRADAS} + ${SQL_AJUSTES} - ${SQL_SALIDAS}) AS libre`;

export async function listarTanquetas(
  client: PoolClient,
  tenantId: string,
  alcance: AlcanceCombustible = ALCANCE_TODO,
  filtros: { grifoInternoId?: number; soloActivas?: boolean } = {}
) {
  const valores: unknown[] = [tenantId];
  const condiciones = ["t.tenant_id = $1"];
  if (!alcance.todo) {
    valores.push(alcance.grifos);
    condiciones.push(`t.grifo_interno_id = ANY($${valores.length}::int[])`);
  }
  if (filtros.grifoInternoId !== undefined) {
    valores.push(filtros.grifoInternoId);
    condiciones.push(`t.grifo_interno_id = $${valores.length}`);
  }
  if (filtros.soloActivas) condiciones.push("t.activa");
  const r = await client.query(
    `SELECT ${COLUMNAS}, g.nombre AS grifo_nombre, e.placa_codigo AS equipo_asignado
       FROM combustible_tanquetas t
       JOIN grifos_internos g ON g.id = t.grifo_interno_id AND g.tenant_id = t.tenant_id
       LEFT JOIN equipos e ON e.id = t.equipo_asignado_id AND e.tenant_id = t.tenant_id
      WHERE ${condiciones.join(" AND ")}
      ORDER BY t.activa DESC, lower(t.codigo)`,
    valores
  );
  return r.rows;
}

export async function getTanqueta(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(
    `SELECT ${COLUMNAS} FROM combustible_tanquetas t WHERE t.tenant_id = $1 AND t.id = $2`,
    [tenantId, id]
  );
  return r.rows[0] ?? null;
}

/** ¿Ya se avisó por correo el sobregiro en curso de esta tanqueta?
 *
 *  Un "episodio" de sobregiro empieza después de la última vez que el saldo
 *  SUBIÓ: una entrada (excedente o vale a reserva) o una carga anulada. Si ya
 *  hay otra alerta de sobregiro posterior a eso, el aviso de este episodio ya
 *  salió. Se cuentan también las entradas que luego se anularon: sobran
 *  límites, y eso a lo sumo repite un correo, nunca lo pierde.
 *
 *  No se decide con "el saldo antes de este vale" porque con cargas
 *  simultáneas cada una lee un saldo que ya incluye a las otras y ninguna se
 *  cree la que cruzó. Llamar con la tanqueta bloqueada (bloquearTanqueta) en la
 *  misma transacción que crea la alerta: así la segunda carga ve la alerta de
 *  la primera y sale exactamente un correo. */
export async function sobregiroYaAvisado(
  client: PoolClient,
  tenantId: string,
  tanquetaId: number,
  alertaId: number
): Promise<boolean> {
  const r = await client.query<{ previa: boolean }>(
    `
    WITH ultima_subida AS (
      SELECT COALESCE(GREATEST(
        (SELECT max(x.creado_en) FROM combustible_recepcion_excedentes x
          WHERE x.tenant_id = $1 AND x.tanqueta_id = $2),
        (SELECT max(d.creado_en) FROM combustible_despachos d
          WHERE d.tenant_id = $1 AND d.tanqueta_destino_id = $2),
        (SELECT max(d.anulada_en) FROM combustible_despachos d
          WHERE d.tenant_id = $1 AND d.tanqueta_origen_id = $2)
      ), '1900-01-01'::timestamptz) AS en
    )
    SELECT EXISTS (
      SELECT 1
        FROM combustible_alertas a
        JOIN combustible_despachos d ON d.tenant_id = a.tenant_id AND d.id = a.despacho_id
       WHERE a.tenant_id = $1 AND a.tipo = 'tanqueta_sobregirada'
         AND d.tanqueta_origen_id = $2 AND a.id <> $3
         AND a.creado_en >= (SELECT en FROM ultima_subida)
    ) AS previa
    `,
    [tenantId, tanquetaId, alertaId]
  );
  return r.rows[0].previa;
}

/** Serializa las decisiones sobre UNA tanqueta (ver sobregiroYaAvisado). */
export async function bloquearTanqueta(client: PoolClient, tenantId: string, id: number) {
  await client.query(
    `SELECT 1 FROM combustible_tanquetas WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, id]
  );
}

/** Las tanquetas que lleva una unidad ahora (asignadas y con saldo), la más
 *  antigua primero: esa es la ACTIVA, la que el conductor carga primero. */
export async function tanquetasVigentesDeUnidad(
  client: PoolClient,
  tenantId: string,
  equipoId: number
) {
  const r = await client.query(
    `SELECT ${COLUMNAS} FROM combustible_tanquetas t
      WHERE t.tenant_id = $1 AND t.equipo_asignado_id = $2 AND t.activa AND ${SQL_ASIGNADA_VIGENTE}
      ORDER BY t.asignada_en, t.id`,
    [tenantId, equipoId]
  );
  return r.rows;
}

/** Asigna la tanqueta a una unidad (o la reasigna: se cambia de unidad sin
 *  pasar por "liberar"). Bloquea la tanqueta y la unidad, así dos asignaciones
 *  simultáneas no pasan del tope. */
export async function asignarTanqueta(
  client: PoolClient,
  tenantId: string,
  id: number,
  equipoId: number,
  /** Desde la pestaña Tanquetas (0141): el vale de esta salida, que queda en el
   *  historial. Los otros caminos de asignación ya llevan su propio vale. */
  vale?: { serie: string; numero: number; usuarioId: string }
) {
  await bloquearTanqueta(client, tenantId, id);
  const t = await getTanqueta(client, tenantId, id);
  if (!t) return null;
  if (!t.activa) throw new AppError(400, `La tanqueta ${t.codigo} está dada de baja`);
  if (Number(t.saldo) <= 0) {
    throw new AppError(400, `La tanqueta ${t.codigo} está vacía: no hay nada que asignar`);
  }
  const eq = await client.query<{ activo: boolean; placa_codigo: string }>(
    `SELECT activo, placa_codigo FROM equipos WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, equipoId]
  );
  if (eq.rowCount === 0) throw new AppError(400, "La unidad no existe");
  if (!eq.rows[0].activo) {
    throw new AppError(400, `La unidad ${eq.rows[0].placa_codigo} está dada de baja`);
  }
  // Una tanqueta con combustible que ya va con una unidad está en la línea
  // amarilla: no se pasa a otra. Se registra su retorno y se asigna de
  // nuevo (auditoría H-1 y H-9). Volver a asignarla a ESA unidad sí se permite.
  if (t.asignada_vigente && Number(t.equipo_asignado_id) !== equipoId) {
    throw new AppError(
      409,
      `La tanqueta ${t.codigo} ya va con otra unidad: registra su retorno y luego asígnala`
    );
  }
  const vigentes = await tanquetasVigentesDeUnidad(client, tenantId, equipoId);
  if (!vigentes.some((v) => Number(v.id) === id) && vigentes.length >= MAX_TANQUETAS_POR_UNIDAD) {
    throw new AppError(
      400,
      `La unidad ${eq.rows[0].placa_codigo} ya lleva ${MAX_TANQUETAS_POR_UNIDAD} tanquetas ` +
        `(${vigentes.map((v) => v.codigo).join(", ")}): libera una antes`
    );
  }
  if (vale) {
    // El mismo número no se usa dos veces: ni en un despacho, ni en un reparto,
    // ni en otra asignación (existeVale mira las tres).
    if (
      await new CombustibleRepository().existeVale(
        client,
        tenantId,
        "combustible",
        vale.serie,
        vale.numero
      )
    ) {
      throw new AppError(
        409,
        `El vale ${vale.numero} de la serie ${vale.serie} ya está registrado: usa el siguiente número libre del talonario`
      );
    }
    await client.query(
      `INSERT INTO combustible_tanqueta_asignaciones
         (tenant_id, tanqueta_id, equipo_id, serie_talonario, n_vale, usuario_id, cantidad)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      // La cantidad del vale es lo que la tanqueta lleva al salir (0142).
      [tenantId, id, equipoId, vale.serie, vale.numero, vale.usuarioId, Number(t.saldo)]
    );
  }
  await client.query(
    `UPDATE combustible_tanquetas SET equipo_asignado_id = $3, asignada_en = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, equipoId]
  );
  return getTanqueta(client, tenantId, id);
}

/** Margen del retorno de una tanqueta (0144): una corrección hacia ABAJO alerta
 *  si pasa de 5 gal o del 5 % del saldo calculado (lo que sea mayor); hacia
 *  ARRIBA siempre alerta, porque declarar que volvió más de lo calculado crea
 *  combustible que no salió de ningún tanque. */
const MARGEN_RETORNO_GAL = 5;
const MARGEN_RETORNO_PCT = 0.05;

export function retornoPideAlerta(calculado: number, validado: number): boolean {
  const diferencia = validado - calculado;
  if (diferencia > 0.005) return true;
  return -diferencia > Math.max(MARGEN_RETORNO_GAL, calculado * MARGEN_RETORNO_PCT);
}

/** El tanque de la misma sede que recibe el saldo de una tanqueta (0145), con
 *  lo que entra ya convertido a SU unidad y a SU costo por unidad. Trae la fila
 *  del tanque bloqueada: dos retornos al mismo pozo no se ven cabiendo cada uno
 *  por su lado. */
async function prepararEntradaAlPozo(
  client: PoolClient,
  tenantId: string,
  tanqueta: { id: string | number; codigo: string; grifo_interno_id: string | number },
  saldoValidado: number,
  tanqueId: number | undefined
) {
  if (tanqueId === undefined) throw new AppError(400, "Elige el tanque al que vuelve el saldo");
  if (saldoValidado <= 0.005) {
    throw new AppError(400, "La tanqueta volvió vacía: no hay saldo que devolver al pozo");
  }
  const r = await client.query<{
    codigo: string;
    unidad: string;
    capacidad_total: string;
    costo_promedio: string;
    activo: boolean;
    grifo_interno_id: string | null;
  }>(
    `SELECT codigo, unidad, capacidad_total, costo_promedio, activo, grifo_interno_id
       FROM combustible WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, tanqueId]
  );
  const tanque = r.rows[0];
  if (!tanque) throw new AppError(400, "El tanque elegido no existe");
  if (!tanque.activo) throw new AppError(400, `El tanque ${tanque.codigo} está dado de baja`);
  if (Number(tanque.grifo_interno_id) !== Number(tanqueta.grifo_interno_id)) {
    throw new AppError(
      400,
      `El tanque ${tanque.codigo} es de otra sede: el saldo solo vuelve a un tanque del grifo de la tanqueta`
    );
  }
  const enGalones = tanque.unidad === "gal";
  const cantidad = Number(
    (enGalones ? saldoValidado : saldoValidado * LITROS_POR_GALON).toFixed(2)
  );
  const repo = new CombustibleRepository();
  const nivel = await repo.findNivelTeoricoVigenteA(
    client,
    tenantId,
    tanqueId,
    new Date().toISOString()
  );
  if (nivel === null) {
    throw new AppError(
      400,
      `El tanque ${tanque.codigo} no tiene lectura de varilla: registra una antes de devolverle combustible`
    );
  }
  const capacidad = Number(tanque.capacidad_total);
  if (nivel + cantidad > capacidad + 0.005) {
    const libre = Math.max(0, Number((capacidad - nivel).toFixed(2)));
    throw new AppError(
      400,
      `El tanque ${tanque.codigo} solo tiene espacio para ${libre} ${tanque.unidad} ` +
        `(capacidad ${capacidad}, nivel teórico ${nivel}): no entran ${cantidad}`
    );
  }
  // El costo con que sale la tanqueta es por galón. Una tanqueta sin ningún
  // costo conocido (0) no puede hundir el promedio del tanque como si ese
  // combustible fuera gratis: entra al promedio que ya tiene.
  const costoGalon = await costoPromedioTanqueta(client, tenantId, Number(tanqueta.id));
  const costoPorUnidad =
    costoGalon > 0
      ? enGalones
        ? costoGalon
        : costoGalon / LITROS_POR_GALON
      : Number(tanque.costo_promedio);
  return { tanqueId, cantidad, costo: Number(costoPorUnidad.toFixed(4)) };
}

/** La tanqueta de la misma sede que recibe el saldo de otra (0146). Las dos ya
 *  están bloqueadas, en orden de id. Trae el costo por galón con que viaja el
 *  saldo: el de la tanqueta que se vacía. */
async function prepararTrasladoATanqueta(
  client: PoolClient,
  tenantId: string,
  origen: { id: string | number; codigo: string; grifo_interno_id: string | number },
  saldoValidado: number,
  destinoId: number | undefined
) {
  if (destinoId === undefined) throw new AppError(400, "Elige la tanqueta que recibe el saldo");
  if (destinoId === Number(origen.id)) {
    throw new AppError(400, "El saldo no puede pasar a la misma tanqueta que lo devuelve");
  }
  if (saldoValidado <= 0.005) {
    throw new AppError(400, "La tanqueta volvió vacía: no hay saldo que pasar a otra");
  }
  // Una tanqueta vacía que quedó con su unidad vieja la olvida antes de recibir.
  await limpiarAsignacionSiVacia(client, tenantId, destinoId);
  const d = await getTanqueta(client, tenantId, destinoId);
  if (!d) throw new AppError(400, "La tanqueta elegida no existe");
  if (!d.activa) throw new AppError(400, `La tanqueta ${d.codigo} está dada de baja`);
  if (Number(d.grifo_interno_id) !== Number(origen.grifo_interno_id)) {
    throw new AppError(
      400,
      `La tanqueta ${d.codigo} es de otra sede: el saldo solo pasa a una tanqueta del mismo grifo`
    );
  }
  if (saldoValidado > Number(d.libre) + 0.001) {
    throw new AppError(
      400,
      `La tanqueta ${d.codigo} solo tiene ${Number(d.libre)} gal libres ` +
        `(capacidad ${Number(d.capacidad)}): no entran ${saldoValidado}`
    );
  }
  // Una tanqueta sin ningún costo conocido no puede hundir el de la que recibe
  // como si ese combustible fuera gratis: viaja con el costo del destino.
  const costoOrigen = await costoPromedioTanqueta(client, tenantId, Number(origen.id));
  const costo =
    costoOrigen > 0 ? costoOrigen : await costoPromedioTanqueta(client, tenantId, destinoId);
  return { destinoId, costo };
}

/** El grifero recibe la tanqueta de vuelta (0143): confirma el saldo que
 *  calculó el sistema o escribe el que de verdad volvió (con motivo si es
 *  otro). El saldo queda en la tanqueta, sin unidad, o vuelve al pozo si el
 *  destino es un tanque de su sede (0145), o pasa a otra tanqueta de la sede
 *  (0146). `saldoCalculado` es el que
 *  el grifero tenía en pantalla: si cambió mientras tanto, se pide abrir de
 *  nuevo y no se registra una diferencia contra un número que no vio. */
export async function registrarRetornoTanqueta(
  client: PoolClient,
  tenantId: string,
  id: number,
  datos: {
    saldoCalculado: number;
    saldoValidado: number;
    motivo?: string;
    usuarioId: string;
    destino?: "reserva" | "pozo" | "tanqueta" | "unidad";
    tanqueId?: number;
    tanquetaDestinoId?: number;
    /** Para destino "unidad": la unidad que se la lleva y el vale de esa salida. */
    unidad?: { equipoId: number; serie: string; numero: number };
  }
) {
  // Con dos tanquetas se bloquea SIEMPRE en orden de id: si A le pasa a B y B a
  // A al mismo tiempo, cada una tomando primero la suya se esperarían entre sí.
  const aBloquear =
    datos.destino === "tanqueta" && datos.tanquetaDestinoId !== undefined
      ? [id, datos.tanquetaDestinoId].sort((a, b) => a - b)
      : [id];
  for (const x of aBloquear) await bloquearTanqueta(client, tenantId, x);
  const t = await getTanqueta(client, tenantId, id);
  if (!t) return null;
  if (!t.asignada_vigente) {
    throw new AppError(
      400,
      `La tanqueta ${t.codigo} no va con ninguna unidad: no hay retorno que registrar`
    );
  }
  const saldo = Number(t.saldo);
  if (Math.abs(saldo - datos.saldoCalculado) > 0.005) {
    throw new AppError(
      409,
      `El saldo de la tanqueta ${t.codigo} cambió (ahora ${saldo} gal): ábrela de nuevo`
    );
  }
  if (datos.saldoValidado > Number(t.capacidad) + 0.001) {
    throw new AppError(400, `La tanqueta ${t.codigo} no admite más de ${Number(t.capacidad)} gal`);
  }
  const motivo = datos.motivo?.trim() ?? "";
  if (Math.abs(datos.saldoValidado - saldo) > 0.005 && motivo.length < 3) {
    throw new AppError(400, "Si el saldo que volvió no coincide con el calculado, explica por qué");
  }
  const destino = datos.destino ?? "reserva";
  if (destino === "unidad" && Number(datos.unidad?.equipoId) === Number(t.equipo_asignado_id)) {
    throw new AppError(400, "La tanqueta volvió de esa unidad: elige otra");
  }
  const pozo =
    destino === "pozo"
      ? await prepararEntradaAlPozo(client, tenantId, t, datos.saldoValidado, datos.tanqueId)
      : null;
  const traslado =
    destino === "tanqueta"
      ? await prepararTrasladoATanqueta(
          client,
          tenantId,
          t,
          datos.saldoValidado,
          datos.tanquetaDestinoId
        )
      : null;
  const retorno = await client.query<{ id: string }>(
    `INSERT INTO combustible_tanqueta_retornos
       (tenant_id, tanqueta_id, equipo_id, saldo_calculado, saldo_validado, motivo, usuario_id,
        destino, combustible_id, cantidad_pozo, costo_unitario_pozo,
        tanqueta_destino_id, costo_unitario_tanqueta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      tenantId,
      id,
      t.equipo_asignado_id,
      saldo,
      datos.saldoValidado,
      motivo || null,
      datos.usuarioId,
      // Pasar a otra unidad es dejar el saldo en la tanqueta y asignarla (abajo).
      destino === "unidad" ? "reserva" : destino,
      pozo?.tanqueId ?? null,
      pozo?.cantidad ?? null,
      pozo?.costo ?? null,
      traslado?.destinoId ?? null,
      traslado?.costo ?? null,
    ]
  );
  // El costo promedio del tanque se rehace entero con lo que acaba de entrar.
  if (pozo) {
    await new CombustibleRepository().recalcularCostoPromedio(client, tenantId, pozo.tanqueId);
  }
  await client.query(
    `UPDATE combustible_tanquetas SET equipo_asignado_id = NULL, asignada_en = NULL
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  // Pasa a otra unidad: se asigna con el vale de esa salida, en la misma
  // transacción. Si el vale se repite o la unidad ya lleva sus tres tanquetas,
  // se deshace también el retorno y la tanqueta sigue como estaba.
  if (destino === "unidad" && datos.unidad) {
    await asignarTanqueta(client, tenantId, id, datos.unidad.equipoId, {
      serie: datos.unidad.serie,
      numero: datos.unidad.numero,
      usuarioId: datos.usuarioId,
    });
  }
  // La alerta se crea en la MISMA transacción: un retorno con diferencia
  // grande no puede quedar registrado sin su aviso.
  let alerta: Awaited<ReturnType<CombustibleRepository["crearAlertas"]>>[number] | null = null;
  if (retornoPideAlerta(saldo, datos.saldoValidado)) {
    const unidad = await client.query<{ placa_codigo: string }>(
      `SELECT placa_codigo FROM equipos WHERE tenant_id = $1 AND id = $2`,
      [tenantId, t.equipo_asignado_id]
    );
    [alerta] = await new CombustibleRepository().crearAlertas(client, tenantId, [
      {
        tipo: "tanqueta_retorno_diferencia",
        tanquetaRetornoId: Number(retorno.rows[0].id),
        detalle: {
          tanqueta: t.codigo,
          unidad: unidad.rows[0]?.placa_codigo ?? null,
          saldoCalculado: saldo,
          saldoValidado: datos.saldoValidado,
          diferencia: Number((datos.saldoValidado - saldo).toFixed(2)),
          motivo,
          usuarioId: datos.usuarioId,
        },
      },
    ]);
  }
  return { tanqueta: await getTanqueta(client, tenantId, id), alerta };
}

/** Antes de llenar una tanqueta vacía, olvida a qué unidad iba: con saldo 0 la
 *  asignación ya no cuenta, pero si se llenara de nuevo reviviría sola. */
export async function limpiarAsignacionSiVacia(client: PoolClient, tenantId: string, id: number) {
  const t = await getTanqueta(client, tenantId, id);
  if (t && t.equipo_asignado_id !== null && Number(t.saldo) <= 0) {
    await client.query(
      `UPDATE combustible_tanquetas SET equipo_asignado_id = NULL, asignada_en = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id]
    );
  }
}

/** Antes de anular un despacho que mueve una tanqueta (auditoría H-4 y H-5):
 *  - Un VALE DE LLENADO no se anula si ya se cargó combustible de esa tanqueta:
 *    el saldo quedaría en negativo y el vale ya entregó lo que dice. Primero se
 *    anulan esas cargas.
 *  - Una CARGA que se anula devuelve saldo: si la tanqueta estaba vacía, su
 *    asignación vieja ya no vale (igual que un llenado nuevo) y no revive
 *    pasando el tope de 3 de la unidad. */
export async function prepararAnulacionDeDespacho(
  client: PoolClient,
  tenantId: string,
  despachoId: number
) {
  const r = await client.query<{
    tanqueta_destino_id: string | null;
    tanqueta_origen_id: string | null;
    cantidad: string;
  }>(
    `SELECT tanqueta_destino_id, tanqueta_origen_id, cantidad FROM combustible_despachos
      WHERE tenant_id = $1 AND id = $2 AND anulada_en IS NULL`,
    [tenantId, despachoId]
  );
  const d = r.rows[0];
  if (!d) return;
  if (d.tanqueta_destino_id !== null) {
    const id = Number(d.tanqueta_destino_id);
    await bloquearTanqueta(client, tenantId, id);
    const t = await getTanqueta(client, tenantId, id);
    if (t && Number(t.saldo) - Number(d.cantidad) < -0.001) {
      throw new AppError(
        409,
        `No se puede anular este vale: de la tanqueta ${t.codigo} ya se cargaron ${Number(t.salidas)} gal. Anula primero esas cargas`
      );
    }
  }
  if (d.tanqueta_origen_id !== null) {
    const id = Number(d.tanqueta_origen_id);
    await bloquearTanqueta(client, tenantId, id);
    await limpiarAsignacionSiVacia(client, tenantId, id);
  }
}

/** El siguiente código libre "TQT-001". Mira solo los que ya siguen el
 *  patrón: un código a mano ("CUBETA ROJA") no lo altera. */
async function siguienteCodigo(client: PoolClient, tenantId: string): Promise<string> {
  const r = await client.query<{ n: number }>(
    `SELECT COALESCE(MAX(substring(codigo from '^TQT-(\\d+)$')::int), 0) + 1 AS n
       FROM combustible_tanquetas
      WHERE tenant_id = $1 AND codigo ~ '^TQT-\\d+$'`,
    [tenantId]
  );
  return `TQT-${String(r.rows[0].n).padStart(3, "0")}`;
}

export async function crearTanqueta(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  data: { grifo_interno_id: number; codigo?: string; capacidad: number }
) {
  const noAsignable = await motivoGrifoNoAsignable(client, tenantId, data.grifo_interno_id);
  if (noAsignable) throw new AppError(400, noAsignable);
  const codigo = data.codigo ?? (await siguienteCodigo(client, tenantId));
  try {
    const r = await client.query<{ id: string }>(
      `INSERT INTO combustible_tanquetas (tenant_id, grifo_interno_id, codigo, capacidad, creado_por)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, data.grifo_interno_id, codigo, data.capacidad, usuarioId]
    );
    return (await getTanqueta(client, tenantId, Number(r.rows[0].id)))!;
  } catch (err) {
    if (esViolacionUnicidad(err)) {
      throw new AppError(409, `Ya existe una tanqueta con el código ${codigo}`);
    }
    throw err;
  }
}

export async function actualizarTanqueta(
  client: PoolClient,
  tenantId: string,
  id: number,
  data: { codigo?: string; capacidad?: number; activa?: boolean; motivo?: string }
) {
  const actual = await getTanqueta(client, tenantId, id);
  if (!actual) return null;
  const saldo = Number(actual.saldo);
  if (data.capacidad !== undefined && data.capacidad < saldo) {
    throw new AppError(
      400,
      `La tanqueta tiene ${saldo} gal de saldo: su capacidad no puede ser menor (${data.capacidad})`
    );
  }
  const baja = data.activa === false && actual.activa;
  if (baja && saldo > 0) {
    throw new AppError(
      400,
      `La tanqueta tiene ${saldo} gal de saldo: no se puede dar de baja hasta vaciarla`
    );
  }
  if (baja && !data.motivo) throw new AppError(400, "Dar de baja una tanqueta pide un motivo");
  try {
    await client.query(
      `UPDATE combustible_tanquetas
          SET codigo = COALESCE($3, codigo),
              capacidad = COALESCE($4, capacidad),
              activa = COALESCE($5, activa),
              motivo_baja = CASE WHEN $5 IS TRUE THEN NULL ELSE COALESCE($6, motivo_baja) END
        WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        id,
        data.codigo ?? null,
        data.capacidad ?? null,
        data.activa ?? null,
        data.motivo ?? null,
      ]
    );
  } catch (err) {
    if (esViolacionUnicidad(err)) {
      throw new AppError(409, `Ya existe una tanqueta con el código ${data.codigo}`);
    }
    throw err;
  }
  return getTanqueta(client, tenantId, id);
}

/** Todo lo que entró y salió de la tanqueta, del más reciente al más viejo:
 *  excedentes de recepción, previsión desde el tanque y cargas en ruta. Las
 *  cargas y la previsión traen el conductor que quedó estampado en el vale
 *  (0083): es lo que permite seguir el combustible hasta quien lo recibió. */
export async function historialTanqueta(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(
    `SELECT * FROM (
       SELECT 'excedente' AS tipo, x.id::text AS id, x.cantidad, r.recibido_en AS fecha,
              r.anulada_en, c.codigo AS tanque_codigo, r.id AS recepcion_id,
              NULL::text AS equipo, NULL::numeric AS lectura_horometro,
              NULL::numeric AS lectura_odometro, NULL::text AS serie_talonario,
              NULL::int AS n_vale, u.nombre AS usuario,
              NULL::text AS conductor_nombre, NULL::text AS conductor_dni, NULL::text AS motivo
         FROM combustible_recepcion_excedentes x
         JOIN combustible_recepciones r ON r.id = x.recepcion_id AND r.tenant_id = x.tenant_id
         JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = r.tenant_id
         LEFT JOIN usuarios u ON u.id = x.decidido_por
        WHERE x.tenant_id = $1 AND x.tanqueta_id = $2
       UNION ALL
       SELECT 'prevision', d.id::text, d.cantidad, d.despachado_en, d.anulada_en,
              c.codigo, NULL, NULL, NULL, NULL, d.serie_talonario, d.n_vale, u.nombre,
              d.conductor_nombre, d.conductor_dni, NULL
         FROM combustible_despachos d
         JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = d.tenant_id
         LEFT JOIN usuarios u ON u.id = d.usuario_id
        WHERE d.tenant_id = $1 AND d.tanqueta_destino_id = $2
       UNION ALL
       SELECT 'carga_' || d.tanqueta_lugar, d.id::text, d.cantidad, d.despachado_en,
              d.anulada_en, NULL, NULL, e.placa_codigo, d.lectura_horometro,
              d.lectura_odometro, d.serie_talonario, d.n_vale, u.nombre,
              d.conductor_nombre, d.conductor_dni, NULL
         FROM combustible_despachos d
         LEFT JOIN equipos e ON e.id = d.equipo_id AND e.tenant_id = d.tenant_id
         LEFT JOIN usuarios u ON u.id = d.usuario_id
        WHERE d.tenant_id = $1 AND d.tanqueta_origen_id = $2
       UNION ALL
       SELECT 'retorno', r.id::text, r.diferencia, r.creado_en, NULL, NULL, NULL, e.placa_codigo,
              NULL, NULL, NULL, NULL, u.nombre, NULL, NULL, r.motivo
         FROM combustible_tanqueta_retornos r
         LEFT JOIN equipos e ON e.id = r.equipo_id AND e.tenant_id = r.tenant_id
         LEFT JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.tenant_id = $1 AND r.tanqueta_id = $2
       UNION ALL
       SELECT 'retorno_pozo', r.id::text, r.saldo_validado, r.creado_en, NULL, c.codigo, NULL,
              e.placa_codigo, NULL, NULL, NULL, NULL, u.nombre, NULL, NULL, NULL
         FROM combustible_tanqueta_retornos r
         JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = r.tenant_id
         LEFT JOIN equipos e ON e.id = r.equipo_id AND e.tenant_id = r.tenant_id
         LEFT JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.tenant_id = $1 AND r.tanqueta_id = $2 AND r.destino = 'pozo'
       UNION ALL
       SELECT 'retorno_traslado', r.id::text, r.saldo_validado, r.creado_en, NULL, q.codigo, NULL,
              e.placa_codigo, NULL, NULL, NULL, NULL, u.nombre, NULL, NULL, NULL
         FROM combustible_tanqueta_retornos r
         JOIN combustible_tanquetas q ON q.id = r.tanqueta_destino_id AND q.tenant_id = r.tenant_id
         LEFT JOIN equipos e ON e.id = r.equipo_id AND e.tenant_id = r.tenant_id
         LEFT JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.tenant_id = $1 AND r.tanqueta_id = $2 AND r.destino = 'tanqueta'
       UNION ALL
       SELECT 'traslado_recibido', r.id::text, r.saldo_validado, r.creado_en, NULL, q.codigo, NULL,
              NULL, NULL, NULL, NULL, NULL, u.nombre, NULL, NULL, NULL
         FROM combustible_tanqueta_retornos r
         JOIN combustible_tanquetas q ON q.id = r.tanqueta_id AND q.tenant_id = r.tenant_id
         LEFT JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.tenant_id = $1 AND r.tanqueta_destino_id = $2 AND r.destino = 'tanqueta'
     ) m
     ORDER BY fecha DESC, id DESC`,
    [tenantId, id]
  );
  return r.rows;
}

/** El costo de un galón de la tanqueta: el promedio ponderado de lo que
 *  entró (la factura del excedente, o el costo del vale a reserva). Es el
 *  costo de la carga en ruta: el conductor no lo conoce ni lo tipea. 0 si
 *  todavía no entró nada con costo. */
export async function costoPromedioTanqueta(
  client: PoolClient,
  tenantId: string,
  id: number
): Promise<number> {
  const r = await client.query<{ costo: string | null }>(
    `SELECT SUM(cantidad * costo) / NULLIF(SUM(cantidad), 0) AS costo FROM (
       SELECT x.cantidad, r.costo_unitario AS costo
         FROM combustible_recepcion_excedentes x
         JOIN combustible_recepciones r ON r.id = x.recepcion_id AND r.tenant_id = x.tenant_id
        WHERE x.tenant_id = $1 AND x.tanqueta_id = $2 AND r.anulada_en IS NULL
       UNION ALL
       SELECT d.cantidad, d.costo_unitario
         FROM combustible_despachos d
        WHERE d.tenant_id = $1 AND d.tanqueta_destino_id = $2 AND d.anulada_en IS NULL
       UNION ALL
       SELECT r.saldo_validado, r.costo_unitario_tanqueta
         FROM combustible_tanqueta_retornos r
        WHERE r.tenant_id = $1 AND r.tanqueta_destino_id = $2 AND r.destino = 'tanqueta'
     ) e`,
    [tenantId, id]
  );
  return r.rows[0].costo === null ? 0 : Number(Number(r.rows[0].costo).toFixed(4));
}

/** Las unidades que maneja este DNI hoy (Equipos es la fuente única). */
async function unidadesDelConductor(client: PoolClient, tenantId: string, dni: string) {
  const d = dni.trim();
  if (!d) return new Set<number>();
  const r = await client.query<{ id: number }>(
    `SELECT id FROM equipos WHERE tenant_id = $1 AND activo AND trim(conductor_dni) = $2`,
    [tenantId, d]
  );
  return new Set(r.rows.map((u) => Number(u.id)));
}

/** ¿Este conductor tiene alguna unidad a su cargo en Equipos? Si no, el
 *  formulario viene vacío por eso y se le dice (auditoría H-10). */
export async function conductorSinUnidad(client: PoolClient, tenantId: string, dni: string) {
  return (await unidadesDelConductor(client, tenantId, dni)).size === 0;
}

/** El conductor solo carga una tanqueta asignada a SU unidad, y si lleva
 *  varias con saldo, primero la ACTIVA (la más antigua). Se valida en el
 *  servidor porque el formulario solo la muestra. Una tanqueta que ya se vació
 *  sigue aceptándose mientras no la liberen o la vuelvan a llenar: los galones
 *  en ruta son estimados y cargar de más no bloquea, deja la alerta de sobregiro. */
export async function exigirTanquetaDelConductor(
  client: PoolClient,
  tenantId: string,
  dni: string,
  tanquetaId: number,
  equipoId: number
) {
  if (!(await unidadesDelConductor(client, tenantId, dni)).has(equipoId)) {
    throw new AppError(403, "Esa unidad no está a tu cargo");
  }
  const t = await getTanqueta(client, tenantId, tanquetaId);
  if (!t || Number(t.equipo_asignado_id) !== equipoId) {
    throw new AppError(400, "La tanqueta no está asignada a tu unidad: pide que te la asignen");
  }
  const [activa] = await tanquetasVigentesDeUnidad(client, tenantId, equipoId);
  // `activa` puede no existir: otra carga simultánea pudo vaciar la lista entre
  // la lectura de arriba y esta (cola offline). Entonces no hay a quién ceder el turno.
  if (t.asignada_vigente && activa && Number(activa.id) !== tanquetaId) {
    throw new AppError(
      400,
      `Carga primero la tanqueta ${activa.codigo}: le quedan ${Number(activa.saldo)} gal`
    );
  }
}

/** Para los formularios del vale (0114): las tanquetas activas del alcance,
 *  con su saldo y espacio. Lo lee quien registra despachos, que no siempre
 *  tiene el panel de Tanquetas. */
export async function tanquetasParaFormulario(
  client: PoolClient,
  tenantId: string,
  alcance: AlcanceCombustible,
  conductorDni?: string
) {
  let todas = await listarTanquetas(client, tenantId, alcance, { soloActivas: true });
  // El conductor (0139) solo ve las tanquetas que le asignaron a SU unidad: la
  // más antigua primero, que es la que carga ahora.
  if (conductorDni !== undefined) {
    const unidades = await unidadesDelConductor(client, tenantId, conductorDni);
    todas = todas
      .filter((t) => t.asignada_vigente && unidades.has(Number(t.equipo_asignado_id)))
      .sort((a, b) => new Date(a.asignada_en).getTime() - new Date(b.asignada_en).getTime());
  }
  const resultado = [];
  for (const t of todas) {
    resultado.push({
      id: Number(t.id),
      codigo: t.codigo as string,
      grifo_interno_id: Number(t.grifo_interno_id),
      capacidad: Number(t.capacidad),
      saldo: Number(t.saldo),
      libre: Number(t.libre),
      // El C.U de una carga desde esta tanqueta: el mismo que fija el
      // servidor al guardarla (0115). El formulario lo muestra, no lo edita.
      costo_promedio: await costoPromedioTanqueta(client, tenantId, Number(t.id)),
      equipo_asignado_id: t.equipo_asignado_id === null ? null : Number(t.equipo_asignado_id),
      equipo_asignado: (t.equipo_asignado as string | null) ?? null,
    });
  }
  return resultado;
}

/** El vale del tanque a "reserva en cubeta" que llena una tanqueta (0114):
 *  activa, de la sede del tanque y con espacio. Bloquea la tanqueta para que
 *  dos vales simultáneos no la llenen de más. Lanza Error con "la tanqueta"
 *  en el mensaje (el controller lo traduce a 400). */
export async function validarLlenadoDeTanqueta(
  client: PoolClient,
  tenantId: string,
  tanquetaId: number,
  grifoDelTanque: number,
  cantidad: number
) {
  await client.query(
    `SELECT id FROM combustible_tanquetas WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, tanquetaId]
  );
  const t = await getTanqueta(client, tenantId, tanquetaId);
  if (!t) throw new Error("la tanqueta elegida no existe en este tenant");
  if (!t.activa) throw new Error(`la tanqueta ${t.codigo} está dada de baja`);
  if (Number(t.grifo_interno_id) !== grifoDelTanque) {
    throw new Error(
      `la tanqueta ${t.codigo} es de otra sede: solo se llena desde los tanques de su grifo`
    );
  }
  if (cantidad > Number(t.libre) + 0.001) {
    throw new Error(
      `la tanqueta ${t.codigo} solo tiene ${Number(t.libre)} gal libres (capacidad ${Number(t.capacidad)}): no entran ${cantidad}`
    );
  }
  await limpiarAsignacionSiVacia(client, tenantId, tanquetaId);
}

/** Las tanquetas activas de un grifo con su espacio libre, para proponer el
 *  reparto del excedente (de la más vacía a la más llena no: se llena primero
 *  la que ya tiene combustible, para no abrir una tanqueta nueva de más). */
export async function tanquetasLibresDelGrifo(
  client: PoolClient,
  tenantId: string,
  grifoInternoId: number
) {
  const todas = await listarTanquetas(client, tenantId, ALCANCE_TODO, {
    grifoInternoId,
    soloActivas: true,
  });
  return todas
    .map((t) => ({
      id: Number(t.id),
      codigo: t.codigo as string,
      capacidad: Number(t.capacidad),
      saldo: Number(t.saldo),
      libre: Number(t.libre),
    }))
    .filter((t) => t.libre > 0)
    .sort((a, b) => b.saldo - a.saldo || a.codigo.localeCompare(b.codigo));
}

/** Valida las líneas del reparto que van a una tanqueta: que exista, esté
 *  activa, sea del grifo del tanque y que lo que se le suma (todas las líneas
 *  que apunten a ella) quepa en su espacio libre. Lanza Error con un mensaje
 *  que contiene "el reparto del excedente" (el controller lo traduce a 400). */
export async function validarLineasATanquetas(
  client: PoolClient,
  tenantId: string,
  grifoInternoId: number,
  lineas: { destino: string; cantidad: number; tanqueta_id?: number }[]
) {
  const porTanqueta = new Map<number, number>();
  for (const l of lineas) {
    if (l.destino !== "cubeta" || l.tanqueta_id === undefined) continue;
    porTanqueta.set(l.tanqueta_id, (porTanqueta.get(l.tanqueta_id) ?? 0) + l.cantidad);
  }
  for (const [id, suma] of porTanqueta) {
    const t = await getTanqueta(client, tenantId, id);
    if (!t) throw new Error("el reparto del excedente nombra una tanqueta que no existe");
    if (!t.activa)
      throw new Error(`el reparto del excedente usa la tanqueta ${t.codigo}, dada de baja`);
    if (Number(t.grifo_interno_id) !== grifoInternoId) {
      throw new Error(
        `el reparto del excedente usa la tanqueta ${t.codigo}, que es de otra sede: solo se llenan las del grifo del tanque`
      );
    }
    if (suma > Number(t.libre) + 0.001) {
      throw new Error(
        `el reparto del excedente le pone ${suma} gal a la tanqueta ${t.codigo}, que solo tiene ${Number(t.libre)} gal libres (capacidad ${Number(t.capacidad)})`
      );
    }
    await limpiarAsignacionSiVacia(client, tenantId, id);
  }
}
