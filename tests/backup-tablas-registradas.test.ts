/** tests/backup-tablas-registradas.test.ts
 *
 * Hermano de rls-coverage.test.ts, para el otro descuido silencioso que
 * puede sufrir una tabla nueva: que exista, tenga RLS, funcione perfecto...
 * y NO esté declarada en el `tablas` de su módulo (ver `ModuloDefinicion`
 * en src/modules/types.ts). Cuando eso pasa, el backup de un tenant no la
 * incluye y un restore la pierde en silencio -- sin ningún error, sin
 * ningún test rojo.
 *
 * ── Por qué existe: pasó de verdad ──────────────────────────────────────
 *
 * `combustible_alertas` (migración 0068, PR #122) estuvo así desde que se
 * creó hasta que se lo encontró explorando para la conciliación. El test
 * que ya había (`module-registry.test.ts`) no podía agarrarlo: solo
 * verifica que `raices ⊆ tablas`, o sea la consistencia INTERNA del
 * registry consigo mismo. Nunca lo compara contra las tablas que existen
 * de verdad en la base -- y ese es justo el eje por el que se escapa una
 * tabla olvidada.
 *
 * Este test recorre la base (igual que rls-coverage) y falla si aparece una
 * tabla con `tenant_id` que ningún módulo declara.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool, closeDatabase } from "../src/server/config/database";

afterAll(async () => {
  await closeDatabase();
});

/** Tablas con tenant_id que a propósito NO son de ningún módulo de
 *  negocio, así que no entran en el backup self-service de un tenant. */
const ALLOWLIST_FUERA_DEL_BACKUP = new Set([
  // Infraestructura de plataforma: las administra el dueño del ERP, no
  // viajan en el backup de negocio de un tenant.
  "tenant_modulos",
  "tenant_cuotas",
  "tenant_sso_config",
  "tenant_scim_config",
  "tenant_metricas_horarias",
  "platform_audit_log",
  "tenant_backups",
  // Sesión y credenciales: un backup de negocio no debe cargar tokens
  // vivos, y restaurarlos sería un problema de seguridad, no una feature.
  "refresh_tokens",
  "reset_tokens",
  "usuario_modulos",
  // `usuarios` y `ordenes_admin` NO son de ningún módulo, pero SÍ entran en
  // el backup: están declaradas a mano en TABLAS_TENANT
  // (platformBackup.service.ts), donde el orden importa -- usuarios primero,
  // después las órdenes que la referencian, y recién ahí los módulos. Están
  // en esta lista porque este test mira el registry de módulos, no ese array.
  "usuarios",
  "ordenes_admin",
  // Sedes y grifos internos (0097): de la empresa, no de un módulo, y en
  // TABLAS_TENANT antes de los módulos que las referencian.
  "sedes",
  "grifos_internos",
  // Buffers y bitácoras internas, no datos de negocio: se regeneran solos
  // o simplemente no tiene sentido restaurarlos.
  "eventos_tiempo_real",
  "idempotency_keys",
  "auditoria",
  // Facturación (migrations/0054): es la relación COMERCIAL entre el dueño
  // del ERP y el tenant, no datos operativos del tenant. Un tenant no
  // debería poder respaldar ni --sobre todo-- restaurar sus propias
  // facturas y cobros: eso reescribiría lo que debe.
  "facturas",
  "pagos",
  "cobros",
  "metodos_pago",
  "suscripciones",
]);

describe("cobertura de backup: tablas de negocio declaradas en su módulo", () => {
  it("toda tabla con tenant_id está declarada en el registry o en la allowlist", async () => {
    const { MODULOS } = await import("../src/modules/registry");
    const declaradas = new Set(MODULOS.flatMap((m) => m.tablas.map((t) => t.nombre)));

    const result = await pool.query<{ tabla: string }>(`
      SELECT c.relname AS tabla
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        -- 'r' = tabla normal, 'p' = tabla PARTICIONADA (checklists, ipercs
        -- desde migrations/0037): la padre es la que se declara y se
        -- respalda, así que tiene que entrar en el chequeo.
        AND c.relkind IN ('r', 'p')
        -- ...y sus particiones individuales NO: se respaldan a través de la
        -- padre, declararlas una por una sería imposible de mantener (nacen
        -- solas cada mes, ver particionado.worker.ts).
        AND c.relispartition = false
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name = 'tenant_id'
        )
      ORDER BY c.relname
    `);

    const sinDeclarar = result.rows
      .map((f) => f.tabla)
      .filter((tabla) => !declaradas.has(tabla) && !ALLOWLIST_FUERA_DEL_BACKUP.has(tabla));

    expect(
      sinDeclarar,
      `Tablas con tenant_id que ningún módulo declara en su \`tablas\`:\n` +
        JSON.stringify(sinDeclarar, null, 2) +
        `\n\nUna tabla sin declarar NO entra en el backup de un tenant y se PIERDE ` +
        `al restaurar. Agregala al array \`tablas\` de su módulo en ` +
        `src/modules/registry.ts (respetando el orden padre->hijo), o a ` +
        `ALLOWLIST_FUERA_DEL_BACKUP en este archivo con el motivo.`
    ).toEqual([]);
  });

  it("toda tabla declarada existe de verdad en la base", async () => {
    // El reverso: una tabla que se renombró o se borró y quedó declarada
    // haría fallar el backup entero con "relation does not exist", pero
    // recién en producción, al primer backup real.
    const { MODULOS } = await import("../src/modules/registry");
    const declaradas = MODULOS.flatMap((m) => m.tablas.map((t) => t.nombre));

    const result = await pool.query<{ tabla: string }>(
      `SELECT c.relname AS tabla
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1)`,
      [declaradas]
    );
    const existentes = new Set(result.rows.map((f) => f.tabla));
    const fantasma = declaradas.filter((t) => !existentes.has(t));

    expect(fantasma, `Tablas declaradas en el registry que no existen en la base`).toEqual([]);
  });
});
