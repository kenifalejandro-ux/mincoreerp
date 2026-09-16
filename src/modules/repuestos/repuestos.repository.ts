/** src/modules/repuestos/repuestos.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type {
  CrearRepuestoInput,
  ActualizarRepuestoInput,
} from "../../server/schemas/repuestos.schema";

export const RepuestosRepository = {
  // =========================================================
  // 📥 LISTAR REPUESTOS (del tenant activo, paginado)
  // =========================================================
  async findAll(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(
      `
      SELECT
        id,
        codigo,
        nombre,
        categoria,
        stock,
        stock_minimo,
        stock_maximo,
        precio,
        fecha_creacion AS fecha,
        COUNT(*) OVER() AS total_count
      FROM repuestos
      WHERE tenant_id = $1
      ORDER BY id DESC
      LIMIT $2 OFFSET $3
    `,
      [tenantId, pageSize, offset]
    );

    return result.rows;
  },

  // =========================================================
  // ➕ CREAR REPUESTO
  // =========================================================
  async create(client: PoolClient, tenantId: string, data: CrearRepuestoInput) {
    const { codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio } = data;

    const result = await client.query(
      `
      INSERT INTO repuestos (
        tenant_id,
        codigo,
        nombre,
        categoria,
        stock,
        stock_minimo,
        stock_maximo,
        precio,
        fecha_creacion
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,NOW()
      )
      RETURNING *
      `,
      [tenantId, codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio]
    );

    return result.rows[0];
  },

  /** Una fila por id, para poder auditar QUÉ cambió en una edición. */
  async findById(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(`SELECT * FROM repuestos WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    return result.rows[0] ?? null;
  },

  // =========================================================
  // ✏️ ACTUALIZAR REPUESTO (solo si pertenece al tenant activo)
  // =========================================================
  /** EL STOCK NO SE EDITA POR ACÁ. Se mueve con movimientos, que dejan quién,
   *  cuándo, cuánto y por qué (POST /movimientos).
   *
   *  Hasta la 5ª auditoría este UPDATE escribía `stock` directo: un operador
   *  podía dejar la existencia en el número que quisiera y la auditoría
   *  guardaba `{ repuestoId }` -- ni el valor viejo, ni el nuevo, ni motivo.
   *  Con eso, el inventario de repuestos no podía delatar un faltante: se
   *  corregía la ficha y listo. Es la misma lección que el módulo de
   *  combustible ya había aprendido con el nivel del tanque (migración 0059):
   *  un saldo que se puede sobrescribir a mano no es un saldo, es una opinión.
   *
   *  Los demás campos de la ficha (nombre, categoría, mínimos, precio) sí se
   *  editan: no son existencias. */
  async update(client: PoolClient, tenantId: string, id: number, data: ActualizarRepuestoInput) {
    const { codigo, nombre, categoria, stock_minimo, stock_maximo, precio } = data;

    const result = await client.query(
      `
      UPDATE repuestos SET
        codigo = $1,
        nombre = $2,
        categoria = $3,
        stock_minimo = $4,
        stock_maximo = $5,
        precio = $6
      WHERE id = $7 AND tenant_id = $8
      RETURNING *
      `,
      [codigo, nombre, categoria, stock_minimo, stock_maximo, precio, id, tenantId]
    );

    return result.rows[0] ?? null;
  },

  // =========================================================
  // 🗑 ELIMINAR REPUESTO (solo si pertenece al tenant activo)
  // =========================================================
  async delete(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(`DELETE FROM repuestos WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    return (result.rowCount ?? 0) > 0;
  },

  // =========================================================
  // 📦 INSERCIÓN MASIVA
  // =========================================================
  /** Un INSERT por lote de 1.000 filas en vez de N INSERT en loop -- mismo
   *  motivo que DocumentosRepository.bulkCreate: cada round-trip mantiene
   *  tomada una conexión del pool COMPARTIDO, así que una importación
   *  grande en loop le sube la latencia al resto de los tenants. El lote
   *  de 1.000 respeta el techo de 65.535 parámetros por sentencia (acá
   *  usa 8 por fila).
   *
   *  Deduplicación DENTRO de cada lote, quedándose con la ÚLTIMA
   *  ocurrencia de cada `codigo`: Postgres RECHAZA un
   *  `ON CONFLICT DO UPDATE` que afecte la misma fila dos veces en la
   *  MISMA sentencia ("command cannot affect row a second time"). El loop
   *  anterior no tenía este problema porque cada fila era su propia
   *  sentencia -- un Excel con un código repetido simplemente aplicaba el
   *  último. Deduplicar acá preserva ese mismo resultado en vez de que la
   *  importación entera reviente. Entre lotes distintos no hace falta:
   *  son sentencias separadas, `ON CONFLICT` las resuelve solas. */
  async createBulk(client: PoolClient, tenantId: string, items: CrearRepuestoInput[]) {
    const TAMANO_LOTE = 1000;
    const results: unknown[] = [];

    for (let inicio = 0; inicio < items.length; inicio += TAMANO_LOTE) {
      const lote = items.slice(inicio, inicio + TAMANO_LOTE);

      const porCodigo = new Map<string, CrearRepuestoInput>();
      for (const fila of lote) porCodigo.set(fila.codigo, fila);
      const filasUnicas = [...porCodigo.values()];

      // ($1,...,$8,NOW()), ($9,...,$16,NOW()), ... -- los valores SIEMPRE
      // parametrizados, nunca interpolados en el SQL.
      const placeholders = filasUnicas
        .map(
          (_, i) =>
            `($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8}, NOW())`
        )
        .join(", ");

      const valores = filasUnicas.flatMap((d) => [
        tenantId,
        d.codigo,
        d.nombre,
        d.categoria,
        d.stock,
        d.stock_minimo,
        d.stock_maximo,
        d.precio,
      ]);

      const result = await client.query(
        `INSERT INTO repuestos (tenant_id, codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio, fecha_creacion)
         VALUES ${placeholders}
         ON CONFLICT (tenant_id, codigo) DO UPDATE SET
           nombre = EXCLUDED.nombre,
           categoria = EXCLUDED.categoria,
           -- stock NO se pisa al reimportar: la existencia de un repuesto
           -- que ya existe sale de sus movimientos, no de una planilla (ver
           -- el comentario de update()). En el alta sí entra, que es el
           -- inventario inicial.
           stock_minimo = EXCLUDED.stock_minimo,
           stock_maximo = EXCLUDED.stock_maximo,
           precio = EXCLUDED.precio
         RETURNING *`,
        valores
      );
      results.push(...result.rows);
    }

    return results;
  },

  // =========================================================
  // 📦 REGISTRAR MOVIMIENTO DE STOCK (entrada/salida)
  // =========================================================
  /** Aplica el delta a `stock` con un UPDATE atómico -- sin comparar contra
   *  ningún timestamp: a diferencia de una lectura absoluta (ver
   *  CombustibleRepository.registrarLectura), un delta es conmutativo, así
   *  que da igual en qué orden sincronicen dos movimientos offline (ver
   *  migrations/0046_repuestos_movimientos.sql).
   *
   *  Una `salida` lleva la guarda `stock >= cantidad`: si dejaría el stock
   *  negativo, el UPDATE no afecta ninguna fila y el movimiento se inserta
   *  igual pero con `estado = 'rechazado'`, SIN aplicar el delta -- a
   *  diferencia de una versión anterior de este método, un rechazo YA NO
   *  se descarta sin dejar rastro (ver migrations/0048): dos técnicos
   *  offline compitiendo por la última unidad dejaban al perdedor sin
   *  ninguna evidencia, ni en el servidor ni en el dispositivo (el banner
   *  de EstadoOffline.tsx es puro estado en memoria del navegador). Una
   *  `entrada` nunca se rechaza, no lleva guarda.
   *
   *  Lanza SOLO si `repuestoId` no existe en este tenant -- eso sigue
   *  siendo un dato inválido, no un conflicto de negocio (mismo patrón que
   *  `CombustibleRepository.registrarLectura` / `IpercController.crear`;
   *  el controller distingue el mensaje para responder 400). El rechazo
   *  por stock insuficiente ya NO lanza: el controller decide 201 vs. 409
   *  mirando `movimiento.estado`. */
  async registrarMovimiento(
    client: PoolClient,
    tenantId: string,
    data: {
      repuestoId: number;
      tipo: "entrada" | "salida";
      cantidad: number;
      motivo: string | null;
      registradoEn: string;
      usuarioId: string | null;
      metadata: Record<string, unknown>;
      ordenTrabajoId: number | null;
    }
  ) {
    const repuestoExiste = await client.query<{ id: number }>(
      `SELECT id FROM repuestos WHERE id = $1 AND tenant_id = $2`,
      [data.repuestoId, tenantId]
    );
    if (repuestoExiste.rows.length === 0) {
      throw new Error(`repuesto_id ${data.repuestoId} no existe en este tenant`);
    }

    // Mismo patrón que equipo_id/iperc_id en OrdenesTrabajoRepository.crear:
    // SELECT previo con mensaje distinguible, para que el controller
    // responda 400 en vez de dejar pasar la violación de FK cruda de
    // Postgres como un 500 genérico.
    if (data.ordenTrabajoId !== null) {
      const otExiste = await client.query<{ id: number }>(
        `SELECT id FROM ordenes_trabajo WHERE id = $1 AND tenant_id = $2`,
        [data.ordenTrabajoId, tenantId]
      );
      if (otExiste.rows.length === 0) {
        throw new Error(`orden_trabajo_id ${data.ordenTrabajoId} no existe en este tenant`);
      }
    }

    const delta = data.tipo === "entrada" ? data.cantidad : -data.cantidad;
    const actualizado = await client.query(
      data.tipo === "salida"
        ? `UPDATE repuestos SET stock = stock + $1
           WHERE id = $2 AND tenant_id = $3 AND stock >= $4
           RETURNING *`
        : `UPDATE repuestos SET stock = stock + $1
           WHERE id = $2 AND tenant_id = $3
           RETURNING *`,
      data.tipo === "salida"
        ? [delta, data.repuestoId, tenantId, data.cantidad]
        : [delta, data.repuestoId, tenantId]
    );

    const aplicado = actualizado.rows.length > 0;
    // Si no se aplicó, el repuesto no cambió -- se trae tal cual para que
    // la respuesta tenga la misma forma que el caso exitoso (el cliente no
    // tiene que distinguir de dónde salió `repuesto`).
    const repuesto = aplicado
      ? actualizado.rows[0]
      : (
          await client.query(`SELECT * FROM repuestos WHERE id = $1 AND tenant_id = $2`, [
            data.repuestoId,
            tenantId,
          ])
        ).rows[0];

    const movimiento = await client.query(
      `
      INSERT INTO repuestos_movimientos
        (tenant_id, repuesto_id, tipo, cantidad, motivo, registrado_en, usuario_id, metadata, estado, orden_trabajo_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, repuesto_id, tipo, cantidad, motivo, registrado_en, usuario_id, origen, metadata, creado_en, estado, orden_trabajo_id
      `,
      [
        tenantId,
        data.repuestoId,
        data.tipo,
        data.cantidad,
        data.motivo,
        data.registradoEn,
        data.usuarioId,
        JSON.stringify(data.metadata),
        aplicado ? "aplicado" : "rechazado",
        data.ordenTrabajoId,
      ]
    );

    return { movimiento: movimiento.rows[0], repuesto };
  },

  /** Para el reintento de un movimiento ya creado (mismo cliente_uuid) --
   *  responde igual que la primera vez (incluido su `estado`), sin volver
   *  a tocar `stock`. */
  async findMovimientoConRepuesto(client: PoolClient, tenantId: string, movimientoId: number) {
    const movimiento = await client.query(
      `SELECT id, repuesto_id, tipo, cantidad, motivo, registrado_en, usuario_id, origen, metadata, creado_en, estado, orden_trabajo_id
       FROM repuestos_movimientos
       WHERE id = $1 AND tenant_id = $2`,
      [movimientoId, tenantId]
    );
    if (movimiento.rows.length === 0) return null;

    const repuesto = await client.query(
      `SELECT * FROM repuestos WHERE id = $1 AND tenant_id = $2`,
      [movimiento.rows[0].repuesto_id, tenantId]
    );

    return { movimiento: movimiento.rows[0], repuesto: repuesto.rows[0] ?? null };
  },

  // =========================================================
  // 📊 KPIs DASHBOARD
  // =========================================================
  async getDashboardKPIs(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `
    SELECT
      (SELECT COUNT(*) FROM repuestos WHERE tenant_id = $1) AS total_repuestos,

      -- 🔴 Bajo mínimo
      (SELECT COUNT(*)
       FROM repuestos
       WHERE tenant_id = $1 AND stock <= stock_minimo) AS stock_bajo,

      -- 🟣 Sobre máximo
      (SELECT COUNT(*)
       FROM repuestos
       WHERE tenant_id = $1 AND stock >= stock_maximo) AS stock_sobre,

      -- 🟢 En rango saludable
      (SELECT COUNT(*)
       FROM repuestos
       WHERE tenant_id = $1 AND stock > stock_minimo
       AND stock < stock_maximo) AS stock_saludable,

      -- 💰 Valor inventario
      (SELECT COALESCE(ROUND(SUM(stock * precio),2),0)
       FROM repuestos WHERE tenant_id = $1) AS valor_inventario
  `,
      [tenantId]
    );

    return result.rows[0];
  },
};
