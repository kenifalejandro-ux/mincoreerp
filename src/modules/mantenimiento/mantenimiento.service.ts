/** src/modules/mantenimiento/mantenimiento.service.ts
 *
 * Ecosistema «Gestión de mantenimiento». Los equipos son del MAESTRO de unidades (`equipos`, con sus lecturas en
 * `equipo_lecturas`): una tabla base de la empresa que ningún módulo posee, así que Mantenimiento la usa tenga la
 * empresa Flota o no. Lo que es solo de Mantenimiento (el área de cada equipo y si es propio o alquilado) vive en
 * `mantenimiento_equipo_datos`, que cuelga del equipo; la tabla base no se entera de ella.
 *
 * Con solo este módulo la empresa registra, importa y ve sus equipos de punta a punta.
 */
import type { PoolClient } from "pg";

import type {
  ActualizarEquipoMantenimientoInput,
  CrearEquipoMantenimientoInput,
  ImportarEquiposMantenimientoInput,
} from "../../server/schemas/mantenimiento.schema";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { huellaDeRegistro, idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { empresaTieneModulo } from "../../server/shared/utils/modulosEmpresa";

export interface FiltrosEquipos {
  /** Busca en placa o código, tipo, marca, modelo y área. */
  q?: string;
  tipo?: string;
  /** Id del área, o `sin_area` para los que no tienen. */
  area?: string;
}

export interface EquipoMantenimiento {
  id: number;
  placa_codigo: string;
  tipo: string;
  marca: string | null;
  modelo: string | null;
  medidor: "horometro" | "odometro";
  /** La última lectura del medidor (de `equipo_lecturas`); 0 si todavía no tiene. */
  lectura: number;
  propiedad: "propia" | "alquilada";
  area_id: number | null;
  area: string | null;
  /** Unidad creada sin ficha (por ejemplo desde Combustible): falta completar sus datos. */
  por_completar: boolean;
}

/** Un equipo con su área, su propiedad y su última lectura. El medidor por defecto es el horómetro. */
const DESDE_EQUIPO = `
  FROM equipos e
  LEFT JOIN mantenimiento_equipo_datos d ON d.tenant_id = e.tenant_id AND d.equipo_id = e.id
  LEFT JOIN mantenimiento_areas a ON a.id = d.area_id
  LEFT JOIN LATERAL (
    SELECT valor FROM equipo_lecturas
     WHERE tenant_id = e.tenant_id AND equipo_id = e.id
       AND tipo = COALESCE(e.tipo_medidor, 'horometro') AND anulada_en IS NULL
     ORDER BY leido_en DESC, id DESC LIMIT 1
  ) l ON true`;

const COLUMNAS_EQUIPO = `e.id::int AS id, e.placa_codigo, e.tipo, e.marca, e.modelo,
  COALESCE(e.tipo_medidor, 'horometro') AS medidor, COALESCE(l.valor, 0)::float8 AS lectura,
  COALESCE(d.propiedad, 'propia') AS propiedad, d.area_id::int AS area_id, a.nombre AS area,
  e.por_completar`;

export class MantenimientoService {
  /** Los equipos activos de la empresa, con su área, filtrados. */
  async listarEquipos(
    client: PoolClient,
    tenantId: string,
    filtros: FiltrosEquipos
  ): Promise<{ equipos: EquipoMantenimiento[]; tipos: string[]; total: number }> {
    const where = ["e.tenant_id = $1", "e.activo"];
    const params: unknown[] = [tenantId];
    if (filtros.q) {
      params.push(`%${filtros.q.toLowerCase()}%`);
      where.push(
        `lower(concat_ws(' ', e.placa_codigo, e.tipo, e.marca, e.modelo, a.nombre)) LIKE $${params.length}`
      );
    }
    if (filtros.tipo) {
      params.push(filtros.tipo);
      where.push(`lower(e.tipo) = lower($${params.length})`);
    }
    if (filtros.area === "sin_area") {
      where.push("d.area_id IS NULL");
    } else if (filtros.area) {
      params.push(Number(filtros.area));
      where.push(`d.area_id = $${params.length}`);
    }
    const lista = await client.query(
      `SELECT ${COLUMNAS_EQUIPO} ${DESDE_EQUIPO}
        WHERE ${where.join(" AND ")}
        ORDER BY lower(e.placa_codigo)`,
      params
    );
    // Los tipos y el total salen de TODOS los equipos activos, no de la lista filtrada: así el filtro por
    // tipo sigue ofreciendo los demás tipos y la pantalla puede decir «N de M». Flota escribe «VOLQUETE» y
    // aquí se puede escribir «Volquete»: es el mismo tipo, y se ofrece una sola vez.
    const tipos = await client.query<{ tipo: string }>(
      `SELECT DISTINCT ON (lower(tipo)) tipo FROM equipos
        WHERE tenant_id = $1 AND activo ORDER BY lower(tipo), tipo`,
      [tenantId]
    );
    const total = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM equipos WHERE tenant_id = $1 AND activo",
      [tenantId]
    );
    return {
      equipos: lista.rows,
      tipos: tipos.rows.map((r) => r.tipo),
      total: total.rows[0].n,
    };
  }

  /** Un equipo con su área, o null si no existe en la empresa (o está quitado, salvo `incluirQuitados`). */
  async obtenerEquipo(
    client: PoolClient,
    tenantId: string,
    id: number,
    incluirQuitados = false
  ): Promise<EquipoMantenimiento | null> {
    const r = await client.query(
      `SELECT ${COLUMNAS_EQUIPO} ${DESDE_EQUIPO}
        WHERE e.tenant_id = $1 AND e.id = $2 ${incluirQuitados ? "" : "AND e.activo"}`,
      [tenantId, id]
    );
    return r.rows[0] ?? null;
  }

  /** El área tiene que ser de ESTA empresa: la clave foránea no mira la empresa, así que se comprueba aquí. */
  private async validarArea(
    client: PoolClient,
    tenantId: string,
    areaId: number | null | undefined
  ) {
    if (areaId == null) return;
    const r = await client.query(
      "SELECT 1 FROM mantenimiento_areas WHERE tenant_id = $1 AND id = $2",
      [tenantId, areaId]
    );
    if (r.rowCount === 0) throw new AppError(400, "El área elegida no existe");
  }

  /** El equipo de la empresa con esa placa o código (sin mirar mayúsculas), esté activo o quitado. */
  private async equipoConPlaca(client: PoolClient, tenantId: string, placa: string) {
    const r = await client.query<{ id: number; activo: boolean }>(
      `SELECT id::int AS id, activo FROM equipos
        WHERE tenant_id = $1 AND lower(trim(placa_codigo)) = lower(trim($2))
        ORDER BY activo DESC LIMIT 1`,
      [tenantId, placa]
    );
    return r.rows[0] ?? null;
  }

  /** Falla con 409 si la placa o el código ya lo tiene otro equipo activo de la empresa. */
  private async validarPlacaLibre(
    client: PoolClient,
    tenantId: string,
    placa: string,
    exceptoId?: number
  ) {
    const r = await client.query<{ id: number }>(
      `SELECT id::int AS id FROM equipos
        WHERE tenant_id = $1 AND activo AND lower(trim(placa_codigo)) = lower(trim($2))
          AND ($3::int IS NULL OR id <> $3)`,
      [tenantId, placa, exceptoId ?? null]
    );
    if (r.rowCount) throw new AppError(409, `Ya hay un equipo con la placa o el código «${placa}»`);
  }

  /** Guarda el área y la propiedad del equipo (una fila por equipo). */
  private async guardarDatos(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    equipoId: number,
    areaId: number | null,
    propiedad: "propia" | "alquilada"
  ) {
    await client.query(
      `INSERT INTO mantenimiento_equipo_datos (tenant_id, equipo_id, area_id, propiedad, actualizado_por)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, equipo_id)
       DO UPDATE SET area_id = EXCLUDED.area_id, propiedad = EXCLUDED.propiedad,
                     actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now()`,
      [tenantId, equipoId, areaId, propiedad, usuarioId]
    );
  }

  /** La lectura con la que se registra un equipo NUEVO: no hay lecturas anteriores, así que no puede retroceder. */
  private async lecturaInicial(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    equipoId: number,
    medidor: "horometro" | "odometro",
    lectura: number
  ) {
    if (lectura <= 0) return;
    await client.query(
      `INSERT INTO equipo_lecturas (tenant_id, equipo_id, tipo, valor, leido_en, origen, usuario_id)
       VALUES ($1, $2, $3, $4, now(), 'manual', $5)`,
      [tenantId, equipoId, medidor, lectura, usuarioId]
    );
  }

  /**
   * Alta de un equipo. Un reintento con el mismo `cliente_uuid` devuelve el que ya se creó. Si la placa era de
   * un equipo quitado, se reactiva en lugar de fallar (en el maestro la placa es única aunque esté inactiva).
   */
  async crearEquipo(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearEquipoMantenimientoInput
  ): Promise<{ equipo: EquipoMantenimiento | null; creado: boolean }> {
    const resultado = await idempotentInsert<EquipoMantenimiento>({
      client,
      tenantId,
      modulo: "mantenimiento",
      clienteUuid: data.cliente_uuid,
      huella: huellaDeRegistro("mantenimiento_equipo", {
        placa: data.placa_codigo.trim().toLowerCase(),
      }),
      insertar: async () => {
        await this.validarArea(client, tenantId, data.area_id);
        const previo = await this.equipoConPlaca(client, tenantId, data.placa_codigo);
        if (previo?.activo) {
          throw new AppError(
            409,
            `Ya hay un equipo con la placa o el código «${data.placa_codigo}»`
          );
        }
        let id: number;
        if (previo) {
          // Reactivar el quitado con los datos nuevos. Su historial de lecturas no se toca.
          await client.query(
            `UPDATE equipos SET activo = true, placa_codigo = $3, tipo = $4, marca = $5, modelo = $6,
                    tipo_medidor = $7
              WHERE tenant_id = $1 AND id = $2`,
            [
              tenantId,
              previo.id,
              data.placa_codigo,
              data.tipo,
              data.marca,
              data.modelo,
              data.medidor,
            ]
          );
          id = previo.id;
        } else {
          const r = await client.query<{ id: number }>(
            `INSERT INTO equipos (tenant_id, placa_codigo, tipo, marca, modelo, tipo_medidor)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::int AS id`,
            [tenantId, data.placa_codigo, data.tipo, data.marca, data.modelo, data.medidor]
          );
          id = r.rows[0].id;
          await this.lecturaInicial(client, tenantId, usuarioId, id, data.medidor, data.lectura);
        }
        await this.guardarDatos(
          client,
          tenantId,
          usuarioId,
          id,
          data.area_id ?? null,
          data.propiedad
        );
        return { id, fila: (await this.obtenerEquipo(client, tenantId, id))! };
      },
      recuperar: (id) => this.obtenerEquipo(client, tenantId, id, true),
    });
    return { equipo: resultado.fila, creado: resultado.creado };
  }

  /**
   * Edita un equipo. Devuelve el equipo y los nombres de los campos que cambiaron (sin sus valores). La lectura
   * NO se edita aquí: se registra con las reglas de las lecturas (no retroceder, corregir es anular), desde
   * un checklist o desde «Registro de unidades».
   */
  async actualizarEquipo(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    data: ActualizarEquipoMantenimientoInput
  ): Promise<{ equipo: EquipoMantenimiento; campos: string[] }> {
    const antes = await this.obtenerEquipo(client, tenantId, id);
    if (!antes) throw new AppError(404, "El equipo no existe");
    await this.validarArea(client, tenantId, data.area_id);
    await this.validarPlacaLibre(client, tenantId, data.placa_codigo, id);
    const nuevo = {
      placa_codigo: data.placa_codigo,
      tipo: data.tipo,
      marca: data.marca,
      modelo: data.modelo,
      medidor: data.medidor,
      propiedad: data.propiedad,
      area_id: data.area_id ?? null,
    };
    const campos = (Object.keys(nuevo) as (keyof typeof nuevo)[]).filter(
      (k) => nuevo[k] !== antes[k]
    );
    await client.query(
      `UPDATE equipos
          SET placa_codigo = $3, tipo = $4, marca = $5, modelo = $6, tipo_medidor = $7
        WHERE tenant_id = $1 AND id = $2 AND activo`,
      [tenantId, id, nuevo.placa_codigo, nuevo.tipo, nuevo.marca, nuevo.modelo, nuevo.medidor]
    );
    await this.guardarDatos(client, tenantId, usuarioId, id, nuevo.area_id, nuevo.propiedad);
    return { equipo: (await this.obtenerEquipo(client, tenantId, id))!, campos };
  }

  /** «Quitar» un equipo lo desactiva: nada se borra (sus lecturas, checklists y órdenes siguen ahí). */
  async quitarEquipo(client: PoolClient, tenantId: string, id: number) {
    const r = await client.query(
      "UPDATE equipos SET activo = false WHERE tenant_id = $1 AND id = $2 AND activo",
      [tenantId, id]
    );
    if (r.rowCount === 0) throw new AppError(404, "El equipo no existe");
  }

  /** Las áreas de la empresa con cuántos equipos activos tiene cada una. */
  async listarAreas(client: PoolClient, tenantId: string) {
    const r = await client.query<{ id: number; nombre: string; equipos: number }>(
      `SELECT a.id::int AS id, a.nombre, count(e.id)::int AS equipos
         FROM mantenimiento_areas a
         LEFT JOIN mantenimiento_equipo_datos d ON d.tenant_id = a.tenant_id AND d.area_id = a.id
         LEFT JOIN equipos e ON e.tenant_id = d.tenant_id AND e.id = d.equipo_id AND e.activo
        WHERE a.tenant_id = $1
        GROUP BY a.id
        ORDER BY lower(a.nombre)`,
      [tenantId]
    );
    return r.rows;
  }

  async crearArea(client: PoolClient, tenantId: string, usuarioId: string, nombre: string) {
    const repetida = await client.query(
      "SELECT 1 FROM mantenimiento_areas WHERE tenant_id = $1 AND lower(trim(nombre)) = lower(trim($2))",
      [tenantId, nombre]
    );
    if (repetida.rowCount) throw new AppError(409, `Ya hay un área llamada «${nombre}»`);
    const r = await client.query<{ id: number; nombre: string }>(
      `INSERT INTO mantenimiento_areas (tenant_id, nombre, creado_por)
       VALUES ($1, $2, $3) RETURNING id::int AS id, nombre`,
      [tenantId, nombre, usuarioId]
    );
    return { ...r.rows[0], equipos: 0 };
  }

  /** Un área con equipos activos no se quita: primero se cambian de área. */
  async quitarArea(client: PoolClient, tenantId: string, id: number) {
    const area = await this.listarAreas(client, tenantId).then((l) => l.find((a) => a.id === id));
    if (!area) throw new AppError(404, "El área no existe");
    if (area.equipos > 0) {
      throw new AppError(
        409,
        `El área tiene ${area.equipos} ${area.equipos === 1 ? "equipo" : "equipos"}: cámbialos de área antes de quitarla`
      );
    }
    await client.query("DELETE FROM mantenimiento_areas WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      id,
    ]);
  }

  /**
   * Las unidades que otro módulo (Flota) registró y Mantenimiento todavía no revisó: equipos activos sin fila
   * en `mantenimiento_equipo_datos`. Todo equipo que nace en Mantenimiento la trae desde el alta, así que estas
   * vienen de fuera. Comparten el maestro `equipos`: no hay nada que copiar, solo darles su área y su propiedad.
   *
   * Es un dato de Flota: sin ese módulo en la EMPRESA la lista sale vacía (la lectura no se ejecuta aunque las
   * filas sigan en la base), sin 403 ni pantalla rota.
   */
  async pendientesDeOperaciones(client: PoolClient, tenantId: string) {
    if (!(await empresaTieneModulo(client, tenantId, "flota"))) return [];
    const r = await client.query<EquipoMantenimiento>(
      `SELECT ${COLUMNAS_EQUIPO} ${DESDE_EQUIPO}
        WHERE e.tenant_id = $1 AND e.activo AND d.equipo_id IS NULL
        ORDER BY lower(e.placa_codigo), e.id`,
      [tenantId]
    );
    return r.rows;
  }

  /**
   * Completa unidades de Operaciones: les da el área y la propiedad con que Mantenimiento las lleva. Todo o
   * nada: si alguna ya no existe (o se quitó) no se completa ninguna. Las que ya estaban completas se omiten,
   * así un doble clic o un reintento no repite nada ni falla. Devuelve las que de verdad se completaron.
   */
  async completarEquipos(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: { ids: number[]; propiedad: "propia" | "alquilada"; area_id?: number | null }
  ): Promise<{ completados: number; ids: number[] }> {
    await this.validarArea(client, tenantId, data.area_id);
    const pedidos = [...new Set(data.ids)];
    const r = await client.query<{ id: number; completo: boolean }>(
      `SELECT e.id::int AS id, (d.equipo_id IS NOT NULL) AS completo
         FROM equipos e
         LEFT JOIN mantenimiento_equipo_datos d ON d.tenant_id = e.tenant_id AND d.equipo_id = e.id
        WHERE e.tenant_id = $1 AND e.activo AND e.id = ANY($2::int[])`,
      [tenantId, pedidos]
    );
    if (r.rows.length !== pedidos.length) {
      throw new AppError(404, "Alguna unidad ya no existe: actualiza la lista");
    }
    const porCompletar = r.rows.filter((f) => !f.completo).map((f) => f.id);
    for (const id of porCompletar) {
      await this.guardarDatos(
        client,
        tenantId,
        usuarioId,
        id,
        data.area_id ?? null,
        data.propiedad
      );
    }
    return { completados: porCompletar.length, ids: porCompletar };
  }

  /** Cuántos equipos tiene la empresa y cómo se reparten por área (para el Centro de control). */
  async resumen(client: PoolClient, tenantId: string) {
    const totales = await client.query<{
      total: number;
      propios: number;
      alquilados: number;
      sin_area: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE COALESCE(d.propiedad, 'propia') = 'propia')::int AS propios,
              count(*) FILTER (WHERE d.propiedad = 'alquilada')::int AS alquilados,
              count(*) FILTER (WHERE d.area_id IS NULL)::int AS sin_area
         FROM equipos e
         LEFT JOIN mantenimiento_equipo_datos d ON d.tenant_id = e.tenant_id AND d.equipo_id = e.id
        WHERE e.tenant_id = $1 AND e.activo`,
      [tenantId]
    );
    const areas = await this.listarAreas(client, tenantId);
    const por_importar = (await this.pendientesDeOperaciones(client, tenantId)).length;
    return { ...totales.rows[0], areas, por_importar };
  }

  /**
   * Importa equipos desde las filas de un Excel, TODO O NADA: si una fila falla no entra ninguna. Devuelve
   * `errores` con la ubicación de cada problema (índice de fila y columna) para que la pantalla diga qué
   * corregir; las filas que están bien no se guardan hasta que todo el archivo lo esté.
   *
   * Una placa ya registrada en la empresa (equipo activo), o repetida dentro del archivo, es un error (sin mirar
   * mayúsculas). Una placa de un equipo quitado se reactiva. Un área que no existe se crea.
   */
  async importarEquipos(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    filas: ImportarEquiposMantenimientoInput
  ): Promise<
    | { errores: { field: string; message: string }[] }
    | { importados: number; areasCreadas: string[] }
  > {
    const clave = (t: string) => t.trim().toLowerCase();
    const errores: { field: string; message: string }[] = [];

    // 1. Placas repetidas dentro del archivo y placas que la empresa ya tiene (activas o quitadas).
    const existentes = await client.query<{ id: number; placa: string; activo: boolean }>(
      "SELECT id::int AS id, lower(trim(placa_codigo)) AS placa, activo FROM equipos WHERE tenant_id = $1",
      [tenantId]
    );
    const porPlaca = new Map(existentes.rows.map((r) => [r.placa, r]));
    const primeraVez = new Map<string, number>();
    filas.forEach((f, i) => {
      const k = clave(f.placa_codigo);
      if (porPlaca.get(k)?.activo) {
        errores.push({
          field: `${i}.placa_codigo`,
          message: `La placa o el código «${f.placa_codigo}» ya está registrado`,
        });
      } else if (primeraVez.has(k)) {
        errores.push({
          field: `${i}.placa_codigo`,
          message: `La placa o el código «${f.placa_codigo}» está repetido en el archivo (filas ${primeraVez.get(k)! + 2} y ${i + 2})`,
        });
      } else {
        primeraVez.set(k, i);
      }
    });
    if (errores.length) return { errores };

    // 2. Las áreas por su nombre: las que existen se reusan y las que faltan se crean.
    const porNombre = new Map<string, number>();
    for (const a of await this.listarAreas(client, tenantId)) porNombre.set(clave(a.nombre), a.id);
    const areasCreadas: string[] = [];
    for (const f of filas) {
      if (!f.area || porNombre.has(clave(f.area))) continue;
      const r = await client.query<{ id: number }>(
        `INSERT INTO mantenimiento_areas (tenant_id, nombre, creado_por)
         VALUES ($1, $2, $3) RETURNING id::int AS id`,
        [tenantId, f.area, usuarioId]
      );
      porNombre.set(clave(f.area), r.rows[0].id);
      areasCreadas.push(f.area);
    }

    // 3. Los equipos nuevos, en un solo INSERT; los quitados que vuelven, reactivados uno a uno.
    const nuevas = filas.filter((f) => !porPlaca.has(clave(f.placa_codigo)));
    const vuelven = filas.filter((f) => porPlaca.has(clave(f.placa_codigo)));
    const idsPorPlaca = new Map<string, number>();
    if (nuevas.length) {
      const r = await client.query<{ id: number; placa: string }>(
        `INSERT INTO equipos (tenant_id, placa_codigo, tipo, marca, modelo, tipo_medidor)
         SELECT $1::uuid, x.placa, x.tipo, x.marca, x.modelo, x.medidor
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
                AS x(placa, tipo, marca, modelo, medidor)
         RETURNING id::int AS id, lower(trim(placa_codigo)) AS placa`,
        [
          tenantId,
          nuevas.map((f) => f.placa_codigo),
          nuevas.map((f) => f.tipo),
          nuevas.map((f) => f.marca),
          nuevas.map((f) => f.modelo),
          nuevas.map((f) => f.medidor),
        ]
      );
      for (const fila of r.rows) idsPorPlaca.set(fila.placa, fila.id);
      // La lectura de un equipo nuevo es su primera: no puede retroceder.
      for (const f of nuevas) {
        await this.lecturaInicial(
          client,
          tenantId,
          usuarioId,
          idsPorPlaca.get(clave(f.placa_codigo))!,
          f.medidor,
          f.lectura
        );
      }
    }
    for (const f of vuelven) {
      const id = porPlaca.get(clave(f.placa_codigo))!.id;
      await client.query(
        `UPDATE equipos SET activo = true, placa_codigo = $3, tipo = $4, marca = $5, modelo = $6,
                tipo_medidor = $7
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id, f.placa_codigo, f.tipo, f.marca, f.modelo, f.medidor]
      );
      idsPorPlaca.set(clave(f.placa_codigo), id);
    }
    for (const f of filas) {
      await this.guardarDatos(
        client,
        tenantId,
        usuarioId,
        idsPorPlaca.get(clave(f.placa_codigo))!,
        f.area ? porNombre.get(clave(f.area))! : null,
        f.propiedad
      );
    }
    // El conteo sale de los equipos que quedaron en la base (un id por placa), no del largo del arreglo que
    // llegó en la petición.
    return { importados: idsPorPlaca.size, areasCreadas };
  }
}
