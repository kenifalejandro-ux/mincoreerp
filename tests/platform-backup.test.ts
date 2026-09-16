/** tests/platform-backup.test.ts
 *
 * Backup y restore por tenant (migrations/0023_tenant_backups.sql,
 * platformBackup.service.ts). El caso central: exportar un tenant con
 * datos reales en varias tablas (incluidas las "hijas" de detalle) y
 * restaurarlo — sobre el mismo tenant (rollback / "punto de
 * restauración") y sobre un tenant vacío distinto (clonado).
 */
import bcrypt from "bcrypt";
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase, withTenant } from "../src/server/config/database";
import { leerBackup, guardarBackup } from "../src/server/services/platformBackupStorage";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];

async function nuevoTenant() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  return creado;
}

/** Carga un equipo + una plantilla + un checklist con un ítem — toca una
 *  tabla "padre" (checklists) y una "hija" de detalle (checklist_items),
 *  justo el caso que tests/helpers.ts no necesita cubrir pero un backup sí. */
async function cargarDatosDePrueba(tenantId: string, usuarioId: string) {
  return withTenant(tenantId, async (client) => {
    const equipo = await client.query(
      `INSERT INTO equipos (tenant_id, placa_codigo, tipo) VALUES ($1, $2, 'Camioneta') RETURNING id`,
      [tenantId, idUnico("EQ")]
    );
    const plantilla = await client.query(
      `INSERT INTO checklist_plantillas (tenant_id, nombre) VALUES ($1, 'Plantilla de prueba') RETURNING id`,
      [tenantId]
    );
    const checklist = await client.query(
      `INSERT INTO checklists (tenant_id, equipo_id, plantilla_id, usuario_id) VALUES ($1, $2, $3, $4) RETURNING id, creado_en`,
      [tenantId, equipo.rows[0].id, plantilla.rows[0].id, usuarioId]
    );
    // checklists está particionada por RANGE(creado_en) (migración 0037):
    // checklist_items necesita checklist_creado_en para la FK compuesta.
    await client.query(
      `INSERT INTO checklist_items (tenant_id, checklist_id, checklist_creado_en, descripcion, estado) VALUES ($1, $2, $3, 'Frenos', 'bien')`,
      [tenantId, checklist.rows[0].id, checklist.rows[0].creado_en]
    );
    return { equipoId: equipo.rows[0].id, checklistId: checklist.rows[0].id };
  });
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("exportarTenantService / POST .../backups", () => {
  it("crea un backup con el resumen correcto de filas por tabla", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await cargarDatosDePrueba(tenant.id, usuario.id);

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(201);
    expect(res.body.backup.tablas.usuarios).toBe(1);
    expect(res.body.backup.tablas.equipos).toBe(1);
    expect(res.body.backup.tablas.checklists).toBe(1);
    expect(res.body.backup.tablas.checklist_items).toBe(1);
    expect(res.body.backup.estado).toBe("completo");

    const auditoria = await pool.query(
      `SELECT resultado FROM platform_audit_log WHERE accion = 'crear_backup_tenant' AND tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows[0].resultado).toBe("success");
  });

  it("tamanoBytes viaja como number, no como string (tamano_bytes es BIGINT)", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);
    const listado = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);

    // node-pg devuelve los BIGINT como STRING. Sin la normalización, sumar
    // tamaños daría concatenación ("100"+"200"="100200") y cualquier
    // comparación estricta contra un number fallaría en silencio. Se
    // descubrió comparando contra el ContentLength real de S3.
    expect(typeof creado.body.backup.tamanoBytes).toBe("number");
    expect(typeof listado.body.backups[0].tamanoBytes).toBe("number");
    expect(creado.body.backup.tamanoBytes).toBeGreaterThan(0);
  });

  it("GET .../backups lista los backups del tenant, más nuevo primero", async () => {
    const { tenant } = await nuevoTenant();
    const primero = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);
    // El orden lo da creado_en (DEFAULT now(), sin desempate por otra
    // columna — tenant_backups.id es un UUID random, no sirve como
    // segundo criterio). Bajo carga pesada (suite completa en paralelo)
    // dos requests bien seguidos podían caer en el mismo timestamp y
    // volver el orden ambiguo — nada que ver con la lógica de la app, así
    // que se fuerza acá un desfasaje mínimo en vez de tocar el schema por
    // un empate de laboratorio.
    await new Promise((r) => setTimeout(r, 5));
    const segundo = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);

    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(200);
    expect(res.body.backups.length).toBeGreaterThanOrEqual(2);
    expect(res.body.backups[0].id).toBe(segundo.body.backup.id);
    expect(res.body.backups.some((b: any) => b.id === primero.body.backup.id)).toBe(true);
  });
});

/** OJO al testear backups de PLATAFORMA contra una base compartida: a
 *  diferencia de un backup de tenant (acotado a un tenant_id), éste captura
 *  y restaura TODA la base. Dos consecuencias para los tests:
 *
 *  1. Nunca afirmar sobre contadores globales del resultado
 *     (filasInsertadas / filasSalteadasPorFk): dependen de lo que otros
 *     archivos de test estén creando o borrando en paralelo. Hay que
 *     afirmar sobre las filas puntuales de este test.
 *
 *  2. El restore es aditivo, así que puede REVIVIR un tenant que otro
 *     archivo de test ya limpió en su afterAll (si lo borró entre el
 *     backup y el restore de acá). Deja filas inertes en la base de
 *     desarrollo; no rompe ningún test, pero explica por qué pueden
 *     aparecer tenants de prueba viejos.
 *
 *  ⚠ HISTORIAL DEL FLAKE DE ESTE BLOQUE — cerrado, vale la pena leerlo
 *  porque el patrón se repite:
 *
 *  Este describe falló ~1 de cada 20 corridas de la suite completa (nunca
 *  aislado), por DOS causas distintas encontradas en momentos distintos:
 *
 *    1. El restore de plataforma no corría en una transacción y podía
 *       quedar a medias. Ese fue un bug REAL de producción que el flake
 *       destapó — ver restaurarTablasPlataforma().
 *    2. Los tests afirmaban sobre los CONTADORES GLOBALES del resultado
 *       (`filasInsertadas.tenants === 1`), que dependen de lo que otros
 *       archivos estén borrando en paralelo. Es exactamente lo que advierte
 *       el punto 1 de arriba, y aun así se coló.
 *
 *  Moraleja para el próximo que toque esto: perseguir un test flaky en vez
 *  de reintentarlo encontró un bug de producción. Y la regla de no afirmar
 *  sobre contadores globales hay que aplicarla, no solo escribirla. */
describe("backup de plataforma / POST /backups/plataforma", () => {
  it("exporta las tablas de la capa de plataforma, sin datos de negocio de ningún tenant", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await cargarDatosDePrueba(tenant.id, usuario.id);

    const res = await request(app)
      .post("/api/platform/backups/plataforma")
      .set("Authorization", BEARER);

    expect(res.status).toBe(201);
    expect(res.body.backup.estado).toBe("completo");
    // El tenant recién creado y sus módulos tienen que estar.
    expect(res.body.backup.tablas.tenants).toBeGreaterThanOrEqual(1);
    expect(res.body.backup.tablas.tenant_modulos).toBeGreaterThanOrEqual(7);
    // Los datos de negocio NO: eso lo cubre el backup por tenant.
    expect(res.body.backup.tablas.equipos).toBeUndefined();
    expect(res.body.backup.tablas.checklists).toBeUndefined();
    // Ni el log de auditoría ni la cola de outbox (ver el service).
    expect(res.body.backup.tablas.platform_audit_log).toBeUndefined();
    expect(res.body.backup.tablas.platform_outbox).toBeUndefined();
  });

  it("la key va bajo backups/platform/, separada del prefijo de los tenants", async () => {
    const res = await request(app)
      .post("/api/platform/backups/plataforma")
      .set("Authorization", BEARER);

    expect(res.body.backup.storageKey).toMatch(
      /^backups\/platform\/\d{4}\/\d{2}\/platform_\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{6}\.json\.gz\.enc$/
    );
  });

  it("GET lista los backups de plataforma, más nuevo primero", async () => {
    const primero = await request(app)
      .post("/api/platform/backups/plataforma")
      .set("Authorization", BEARER);
    // Desfasaje mínimo para que "primero" y "segundo" no empaten en
    // creado_en bajo carga pesada — necesario para poder comparar el
    // orden relativo ENTRE ELLOS DOS (ver el comentario de abajo sobre
    // por qué no se puede afirmar más que eso).
    await new Promise((r) => setTimeout(r, 5));
    const segundo = await request(app)
      .post("/api/platform/backups/plataforma")
      .set("Authorization", BEARER);

    const res = await request(app)
      .get("/api/platform/backups/plataforma")
      .set("Authorization", BEARER);
    expect(res.status).toBe(200);

    // platform_backups es un recurso GLOBAL (sin tenant_id): a diferencia
    // del listado por tenant, acá SÍ puede haber otro archivo de test
    // corriendo en paralelo que cree su propio backup de plataforma justo
    // en el medio — así que no se puede afirmar que "segundo" quede
    // exactamente en la posición 0 (otro backup, de otro archivo, más
    // nuevo todavía, podría colarse antes). Lo único que este test puede
    // garantizar es el orden RELATIVO entre los dos propios.
    const ids = res.body.backups.map((b: any) => b.id);
    const posPrimero = ids.indexOf(primero.body.backup.id);
    const posSegundo = ids.indexOf(segundo.body.backup.id);
    expect(posPrimero).toBeGreaterThanOrEqual(0);
    expect(posSegundo).toBeGreaterThanOrEqual(0);
    expect(posSegundo).toBeLessThan(posPrimero);
  });

  it("restaurar es ADITIVO: reinserta un tenant borrado sin tocar los que existen", async () => {
    const { tenant: aBorrar } = await nuevoTenant();
    const { tenant: sobreviviente } = await nuevoTenant();

    const backup = await request(app)
      .post("/api/platform/backups/plataforma")
      .set("Authorization", BEARER);
    expect(backup.status).toBe(201);

    // Se le cambia el nombre al sobreviviente DESPUÉS del backup: el
    // restore aditivo no debe pisarlo (ON CONFLICT DO NOTHING).
    await pool.query(`UPDATE tenants SET nombre = 'Nombre cambiado' WHERE id = $1`, [
      sobreviviente.id,
    ]);
    // Y se borra el otro por completo (cascadea a sus dependencias).
    await borrarTenantDePrueba(aBorrar.id);
    expect(
      (await pool.query(`SELECT id FROM tenants WHERE id = $1`, [aBorrar.id])).rows
    ).toHaveLength(0);

    const res = await request(app)
      .post(`/api/platform/backups/plataforma/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ confirmar: true });

    expect(res.status).toBe(200);
    // NO se afirma `=== 1`: el backup de plataforma captura TODOS los
    // tenants, así que si otro archivo de test borró el suyo entre el backup
    // y este restore, éste también lo reinserta y el contador da 2. Lo que
    // este test tiene que probar es el comportamiento sobre SUS dos tenants,
    // y eso lo verifican las dos afirmaciones de abajo.
    expect(res.body.filasInsertadas.tenants).toBeGreaterThanOrEqual(1);

    const restaurado = await pool.query(`SELECT nombre FROM tenants WHERE id = $1`, [aBorrar.id]);
    expect(restaurado.rows).toHaveLength(1);

    // El sobreviviente conserva su nombre nuevo: aditivo no es "rollback".
    const intacto = await pool.query(`SELECT nombre FROM tenants WHERE id = $1`, [
      sobreviviente.id,
    ]);
    expect(intacto.rows[0].nombre).toBe("Nombre cambiado");
  });

  it("saltea usuario_modulos cuyos usuarios ya no existen (viven en los backups por tenant)", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const backup = await request(app)
      .post("/api/platform/backups/plataforma")
      .set("Authorization", BEARER);

    // El backup tiene que haber capturado los módulos de ESTE usuario.
    const antes = await pool.query(
      `SELECT count(*) AS total FROM usuario_modulos WHERE usuario_id = $1`,
      [usuario.id]
    );
    expect(Number(antes.rows[0].total)).toBeGreaterThan(0);

    // Borrar el tenant se lleva puestos sus usuarios; sus usuario_modulos
    // del backup quedan apuntando a ids inexistentes.
    await borrarTenantDePrueba(tenant.id);

    const res = await request(app)
      .post(`/api/platform/backups/plataforma/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ confirmar: true });

    // No explota por violación de FK: saltea esas filas y sigue.
    expect(res.status).toBe(200);

    // Se afirma sobre ESTE usuario y no sobre el contador global de
    // filasSalteadasPorFk: el backup de plataforma captura TODA la base,
    // así que ese contador depende de los tenants que otros archivos de
    // test estén creando/borrando en paralelo — assertarlo hacía el test
    // flaky (falló una vez en la suite completa, nunca aislado).
    const despues = await pool.query(
      `SELECT count(*) AS total FROM usuario_modulos WHERE usuario_id = $1`,
      [usuario.id]
    );
    expect(Number(despues.rows[0].total)).toBe(0);
  });

  it("da 400 sin confirmar:true", async () => {
    const backup = await request(app)
      .post("/api/platform/backups/plataforma")
      .set("Authorization", BEARER);

    const res = await request(app)
      .post(`/api/platform/backups/plataforma/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({});

    expect(res.status).toBe(400);
  });

  it("da 404 con un backupId de plataforma que no existe", async () => {
    const res = await request(app)
      .post("/api/platform/backups/plataforma/00000000-0000-0000-0000-000000000000/restaurar")
      .set("Authorization", BEARER)
      .send({ confirmar: true });

    expect(res.status).toBe(404);
  });

  it("queda auditado", async () => {
    const res = await request(app)
      .post("/api/platform/backups/plataforma")
      .set("Authorization", BEARER);

    const auditoria = await pool.query(
      `SELECT resultado, detalle FROM platform_audit_log
       WHERE accion = 'crear_backup_plataforma' ORDER BY creado_en DESC LIMIT 1`
    );
    expect(auditoria.rows[0].resultado).toBe("success");
    expect(auditoria.rows[0].detalle.backupId).toBe(res.body.backup.id);
  });
});

describe("restaurarBackupService / POST /backups/:id/restaurar", () => {
  it("restaura sobre el MISMO tenant (punto de restauración): borra lo agregado después del backup", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await cargarDatosDePrueba(tenant.id, usuario.id);

    const backup = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);
    expect(backup.status).toBe(201);

    // Datos agregados DESPUÉS del backup — el restore tiene que borrarlos.
    await withTenant(tenant.id, (client) =>
      client.query(`INSERT INTO equipos (tenant_id, placa_codigo, tipo) VALUES ($1, $2, 'Otro')`, [
        tenant.id,
        idUnico("EQ-POST-BACKUP"),
      ])
    );
    const antesDeRestaurar = await withTenant(tenant.id, (client) =>
      client.query(`SELECT count(*) AS total FROM equipos WHERE tenant_id = $1`, [tenant.id])
    );
    expect(Number(antesDeRestaurar.rows[0].total)).toBe(2);

    const restaurar = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });

    expect(restaurar.status).toBe(200);
    expect(restaurar.body.tablasRestauradas.equipos).toBe(1);
    expect(restaurar.body.tablasRestauradas.checklists).toBe(1);
    expect(restaurar.body.tablasRestauradas.checklist_items).toBe(1);

    const despuesDeRestaurar = await withTenant(tenant.id, (client) =>
      client.query(`SELECT count(*) AS total FROM equipos WHERE tenant_id = $1`, [tenant.id])
    );
    expect(Number(despuesDeRestaurar.rows[0].total)).toBe(1); // el "post-backup" ya no está

    const itemsRestaurados = await withTenant(tenant.id, (client) =>
      client.query(`SELECT descripcion FROM checklist_items WHERE tenant_id = $1`, [tenant.id])
    );
    expect(itemsRestaurados.rows).toHaveLength(1);
    expect(itemsRestaurados.rows[0].descripcion).toBe("Frenos");
  });

  it("restaurar bumpea token_version de los usuarios restaurados (invalida sesiones viejas)", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const antes = await withTenant(tenant.id, (client) =>
      client.query(`SELECT token_version FROM usuarios WHERE id = $1`, [usuario.id])
    );

    const backup = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);
    await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });

    const despues = await withTenant(tenant.id, (client) =>
      client.query(`SELECT token_version FROM usuarios WHERE id = $1`, [usuario.id])
    );
    expect(despues.rows[0].token_version).toBeGreaterThan(antes.rows[0].token_version);
  });

  it("restaura en un tenant DISTINTO (clonado), reescribiendo tenant_id", async () => {
    const { tenant: origen, usuario } = await nuevoTenant();
    await cargarDatosDePrueba(origen.id, usuario.id);
    const backup = await request(app)
      .post(`/api/platform/tenants/${origen.id}/backups`)
      .set("Authorization", BEARER);

    const { tenant: destino } = await nuevoTenant();

    const restaurar = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: destino.id, confirmar: true });

    expect(restaurar.status).toBe(200);
    expect(restaurar.body.tablasRestauradas.equipos).toBe(1);

    const equiposDestino = await withTenant(destino.id, (client) =>
      client.query(`SELECT tenant_id FROM equipos WHERE tenant_id = $1`, [destino.id])
    );
    expect(equiposDestino.rows).toHaveLength(1);
    expect(equiposDestino.rows[0].tenant_id).toBe(destino.id);

    // El origen no se tocó.
    const equiposOrigen = await withTenant(origen.id, (client) =>
      client.query(`SELECT count(*) AS total FROM equipos WHERE tenant_id = $1`, [origen.id])
    );
    expect(Number(equiposOrigen.rows[0].total)).toBe(1);
  });

  // ── documentos_versiones: la tabla que apunta FUERA de Postgres ────────
  //
  // El archivo (PDF/imagen) vive en R2/disco, no en el backup. Lo que se
  // respalda es la fila que lo referencia por storage_key, y eso hace que
  // los dos caminos de restore tengan que comportarse DISTINTO — ver
  // `omitirAlClonar` en modules/types.ts.

  it("restaura documentos_versiones sobre el MISMO tenant, con su storage_key intacta", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const keyOriginal = await withTenant(tenant.id, async (client) => {
      const doc = await client.query(
        `INSERT INTO documentos (tenant_id, nombre_documento) VALUES ($1, 'Licencia') RETURNING id`,
        [tenant.id]
      );
      const version = await client.query(
        `INSERT INTO documentos_versiones
           (tenant_id, documento_id, storage_driver, storage_key, mime_type, tamano_bytes, nombre_original, subido_por)
         VALUES ($1, $2, 'local', $3, 'application/pdf', 100, 'licencia.pdf', $4) RETURNING storage_key`,
        [tenant.id, doc.rows[0].id, `documentos/tenants/${tenant.id}/1/archivo.pdf`, usuario.id]
      );
      return version.rows[0].storage_key;
    });

    const backup = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);

    // Se pierden las filas (el archivo en el storage NO se toca: es
    // justo el escenario que el restore tiene que poder deshacer).
    await withTenant(tenant.id, (client) =>
      client.query(`DELETE FROM documentos WHERE tenant_id = $1`, [tenant.id])
    );

    const restaurar = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });

    expect(restaurar.status).toBe(200);
    expect(restaurar.body.tablasRestauradas.documentos_versiones).toBe(1);

    const versiones = await withTenant(tenant.id, (client) =>
      client.query(`SELECT storage_key FROM documentos_versiones WHERE tenant_id = $1`, [tenant.id])
    );
    expect(versiones.rows).toHaveLength(1);
    // La key tiene que volver EXACTAMENTE igual: apunta a un archivo que
    // sigue existiendo en el storage bajo el prefijo de este tenant.
    expect(versiones.rows[0].storage_key).toBe(keyOriginal);
  });

  it("al CLONAR omite documentos_versiones: el destino no hereda punteros a archivos del origen", async () => {
    const { tenant: origen, usuario } = await nuevoTenant();
    await withTenant(origen.id, async (client) => {
      const doc = await client.query(
        `INSERT INTO documentos (tenant_id, nombre_documento) VALUES ($1, 'Licencia') RETURNING id`,
        [origen.id]
      );
      await client.query(
        `INSERT INTO documentos_versiones
           (tenant_id, documento_id, storage_driver, storage_key, mime_type, tamano_bytes, nombre_original, subido_por)
         VALUES ($1, $2, 'local', $3, 'application/pdf', 100, 'licencia.pdf', $4)`,
        [origen.id, doc.rows[0].id, `documentos/tenants/${origen.id}/1/archivo.pdf`, usuario.id]
      );
    });

    const backup = await request(app)
      .post(`/api/platform/tenants/${origen.id}/backups`)
      .set("Authorization", BEARER);

    const { tenant: destino } = await nuevoTenant();
    const restaurar = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: destino.id, confirmar: true });

    expect(restaurar.status).toBe(200);
    // El documento sí se clona; su archivo adjunto no.
    expect(restaurar.body.tablasRestauradas.documentos).toBe(1);
    expect(restaurar.body.tablasRestauradas.documentos_versiones).toBe(0);

    const versionesDestino = await withTenant(destino.id, (client) =>
      client.query(`SELECT storage_key FROM documentos_versiones WHERE tenant_id = $1`, [
        destino.id,
      ])
    );
    // Cero filas, y en particular NINGUNA apuntando al prefijo del origen:
    // si esto falla, un usuario del clon puede descargar el PDF del otro
    // cliente (RLS no lo detiene, la fila le pertenece de verdad).
    expect(versionesDestino.rows).toHaveLength(0);

    // El origen conserva la suya.
    const versionesOrigen = await withTenant(origen.id, (client) =>
      client.query(`SELECT count(*) AS total FROM documentos_versiones WHERE tenant_id = $1`, [
        origen.id,
      ])
    );
    expect(Number(versionesOrigen.rows[0].total)).toBe(1);
  });

  it("da 400 sin confirmar:true", async () => {
    const { tenant } = await nuevoTenant();
    const backup = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);

    const res = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id });

    expect(res.status).toBe(400);
  });

  it("da 404 con un backupId que no existe", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/backups/00000000-0000-0000-0000-000000000000/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });
    expect(res.status).toBe(404);
  });

  it("audita el fallo (resultado 'failure') cuando el objeto del backup no existe", async () => {
    const { tenant } = await nuevoTenant();
    const backup = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);

    // Se apunta la fila a una key inexistente: simula el objeto borrado por
    // fuera (lifecycle rule mal configurada, borrado manual en el bucket).
    await pool.query(`UPDATE tenant_backups SET storage_key = $1 WHERE id = $2`, [
      "backups/tenants/inexistente/2026/01/backup_fantasma.json.gz.enc",
      backup.body.backup.id,
    ]);

    const res = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });

    expect(res.status).toBe(500);

    const auditoria = await pool.query(
      `SELECT resultado, detalle FROM platform_audit_log
       WHERE accion = 'restaurar_backup_tenant' AND tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows[0].resultado).toBe("failure");
    expect(auditoria.rows[0].detalle.error).toBeTruthy();
  });

  it("queda auditado con antes/después de tablas restauradas", async () => {
    const { tenant } = await nuevoTenant();
    const backup = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);

    await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });

    const auditoria = await pool.query(
      `SELECT detalle, resultado FROM platform_audit_log WHERE accion = 'restaurar_backup_tenant' AND tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows).toHaveLength(1);
    expect(auditoria.rows[0].resultado).toBe("success");
    expect(auditoria.rows[0].detalle.backupId).toBe(backup.body.backup.id);
  });
});

// ── Cuentas (migración 0087) ─────────────────────────────────────────────
//
// Restaurar tiene que devolverle a la gente la posibilidad de ENTRAR, y desde
// 0087 la clave de quien entra con correo no vive en el tenant: vive en su
// cuenta, que es de la persona y puede estar compartida con otras empresas.
// De ahí los tres casos de abajo.

describe("restore y cuentas", () => {
  /** Deja el objeto del backup como lo habría escrito el código anterior a
   *  0087: sin la sección `cuentas`, sin `cuenta_id` en los perfiles, y con la
   *  clave guardada en el propio perfil. Es la única forma de probar contra un
   *  backup viejo de verdad -- los que produce el sistema hoy son versión 2. */
  async function degradarAVersion1(backupId: string) {
    const fila = (
      await pool.query(`SELECT storage, storage_key FROM tenant_backups WHERE id = $1`, [backupId])
    ).rows[0];
    const ubicacion = { storage: fila.storage, key: fila.storage_key };
    const contenido = JSON.parse(await leerBackup(ubicacion));

    const clavePorCuenta = new Map<string, unknown>();
    for (const cuenta of contenido.cuentas ?? []) {
      clavePorCuenta.set(String(cuenta.id), cuenta.password_hash);
    }
    for (const perfil of contenido.tablas.usuarios ?? []) {
      if (perfil.cuenta_id) perfil.password_hash = clavePorCuenta.get(String(perfil.cuenta_id));
      delete perfil.cuenta_id;
    }
    delete contenido.cuentas;
    contenido.version = 1;

    await guardarBackup(fila.storage_key, JSON.stringify(contenido));
  }

  /** Borra la cuenta de una persona: el caso de restaurar en una base que
   *  nunca la tuvo (otra instalación) o donde ya se había limpiado. */
  async function borrarLaCuentaDe(tenantId: string, email: string) {
    await withTenant(tenantId, (client) =>
      client.query(`UPDATE usuarios SET cuenta_id = NULL WHERE tenant_id = $1`, [tenantId])
    );
    await pool.query(`DELETE FROM cuentas WHERE email = $1`, [email.toLowerCase()]);
  }

  const puedeEntrar = async (slug: string, email: string, clave: string) =>
    (await request(app).post("/api/auth/login").send({ tenantSlug: slug, email, password: clave }))
      .status;

  it("recrea la cuenta borrada y la persona vuelve a poder entrar", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const backup = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);
    expect(backup.status).toBe(201);

    await borrarLaCuentaDe(tenant.id, usuario.email);
    expect(await puedeEntrar(tenant.slug, usuario.email, password)).toBe(401);

    const restaurar = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });
    expect(restaurar.status).toBe(200);

    expect(await puedeEntrar(tenant.slug, usuario.email, password)).toBe(200);
  });

  it("NO le pisa la clave a una cuenta que ya existe", async () => {
    // La persona cambió su clave después del backup. Restaurar este tenant no
    // puede devolverle la vieja: con esa misma cuenta entra a otras empresas,
    // que no tienen nada que ver con este restore.
    const { tenant, usuario } = await nuevoTenant();
    const backup = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);

    const claveNueva = "ClaveCambiadaDespues1";
    await pool.query(`UPDATE cuentas SET password_hash = $1 WHERE email = $2`, [
      await bcrypt.hash(claveNueva, 12),
      usuario.email.toLowerCase(),
    ]);

    const restaurar = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });
    expect(restaurar.status).toBe(200);

    expect(await puedeEntrar(tenant.slug, usuario.email, claveNueva)).toBe(200);
    expect(await puedeEntrar(tenant.slug, usuario.email, password)).toBe(401);
  });

  it("un backup anterior a 0087 le arma la cuenta al perfil que no la tenía", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const backup = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);

    await degradarAVersion1(backup.body.backup.id);
    await borrarLaCuentaDe(tenant.id, usuario.email);

    const restaurar = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });
    expect(restaurar.status).toBe(200);

    // Lo que importa: puede entrar. Sin la conversión al restaurar, el perfil
    // quedaría con su clave vieja y el login --que la busca en la cuenta-- no
    // la encontraría nunca.
    expect(await puedeEntrar(tenant.slug, usuario.email, password)).toBe(200);

    const cuenta = (
      await pool.query(`SELECT id, password_hash FROM cuentas WHERE email = $1`, [
        usuario.email.toLowerCase(),
      ])
    ).rows[0];
    expect(cuenta.password_hash).toBeTruthy();

    const perfil = await withTenant(tenant.id, (client) =>
      client.query(`SELECT cuenta_id, password_hash FROM usuarios WHERE tenant_id = $1`, [
        tenant.id,
      ])
    );
    expect(perfil.rows[0].cuenta_id).toBe(cuenta.id);
    // La clave quedó en un solo lugar, no en dos.
    expect(perfil.rows[0].password_hash).toBeNull();
  });
});
