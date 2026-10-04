/** tests/combustible-comprobante-adversario.test.ts
 *
 * Ronda adversaria del comprobante de la compra en ruta (0109, entrega 5).
 *
 * Método de siempre (ver combustible-alcance.test.ts): cada ataque con su
 * GEMELO legítimo. Si el gemelo también fallara, el "no pudo" del ataque no
 * probaría nada -- podría estar fallando por cualquier otra cosa.
 *
 * Lo que se ataca:
 *  1. La boleta disfrazada: el mismo papel con otra escritura del número
 *     (minúsculas, espacios, ceros a la izquierda) para cargarlo dos veces.
 *  2. El archivo disfrazado: un ejecutable o un texto que DICE ser imagen.
 *  3. La carrera: dos fotos distintas a la vez, para reemplazar la evidencia
 *     sin dar motivo.
 *  4. El uuid ajeno: el uuid de OTRA cosa del módulo (una lectura) usado para
 *     colgarle la foto a una compra que no corresponde.
 *  5. El alcance (0100): un usuario de planta tocando la compra de otro.
 *  6. Los roles: quién NO puede subir.
 *  7. El nombre del archivo como vector de inyección en la descarga.
 *  8. Que el reemplazo deje rastro con su motivo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";

const password = "ClaveDePrueba123";
let seq = 0;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 1, 2]);
const OTRO_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 9, 9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = Buffer.from("%PDF-1.4\n%comprobante\n");
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

type Agente = ReturnType<typeof request.agent>;

describe("combustible: comprobante de la compra en ruta -- ronda adversaria", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  let proveedor: number;
  let otroProveedor: number;
  let equipo: number;
  let grifoInterno: number;
  let otroGrifoInterno: number;

  const numeroUnico = () => `B${100 + (seq++ % 800)}-${Date.now().toString().slice(-6)}${seq}`;

  const compra = (ag: Agente, extra: Record<string, unknown> = {}) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "compra_externa",
      grifo_id: proveedor,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipo,
      comprobante_tipo: "boleta",
      comprobante_numero: numeroUnico(),
      cantidad: 40,
      lectura_horometro: 1000 + seq++,
      horas_abastecidas: 12,
      costo_unitario: 17.5,
      despachado_en: new Date().toISOString(),
      ...extra,
    });

  async function compraId(ag: Agente = admin, extra: Record<string, unknown> = {}) {
    const r = await compra(ag, extra);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  const subir = (
    ag: Agente,
    ruta: string,
    contenido: Buffer,
    tipo = "image/jpeg",
    nombre = "boleta.jpg",
    campos: Record<string, string> = {}
  ) => {
    const p = ag
      .post(`/api/erp/combustible/despachos/${ruta}/comprobante`)
      .attach("archivo", contenido, { filename: nombre, contentType: tipo });
    for (const [c, v] of Object.entries(campos)) p.field(c, v);
    return p;
  };

  async function persona(rol: string) {
    const agente = request.agent(app);
    const dni = String(87100000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `P ${rol}`, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const entrar = () =>
      agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    expect((await entrar()).status).toBe(200);
    return { agente, id: alta.body.id as string, entrar };
  }

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });

    equipo = (
      await admin
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("VOL"), tipo: "VOLQUETE", tipo_medidor: "horometro" })
    ).body.id;
    proveedor = (
      await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("PRIMAX") })
    ).body.id;
    otroProveedor = (
      await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("REPSOL") })
    ).body.id;
    const sede = (await admin.get("/api/erp/sedes")).body.sedes[0];
    grifoInterno = sede.grifos[0].id;
    otroGrifoInterno = (
      await admin.post("/api/erp/administracion/grifos").send({ sede_id: sede.id, nombre: "B" })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── 1. La boleta disfrazada ────────────────────────────────────────────
  describe("1. el mismo papel escrito distinto no entra dos veces", () => {
    const disfraces: [string, (n: string) => string][] = [
      ["en minúsculas", (n) => n.toLowerCase()],
      ["con espacios alrededor y en el medio", (n) => `  ${n.replace("-", " - ")}  `],
      ["sin los ceros a la izquierda del correlativo", (n) => n.replace(/-0+/, "-")],
      ["con ceros de más en el correlativo", (n) => n.replace("-", "-000")],
    ];

    for (const [como, disfrazar] of disfraces) {
      it(`ataque: ${como} -> 409`, async () => {
        const original = `B001-000${Date.now().toString().slice(-6)}${seq++}`;
        expect((await compra(admin, { comprobante_numero: original })).status).toBe(201);
        const r = await compra(admin, { comprobante_numero: disfrazar(original) });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
      });
    }

    it("gemelo: el número SIGUIENTE del mismo proveedor sí entra", async () => {
      const base = Date.now().toString().slice(-6) + seq++;
      expect((await compra(admin, { comprobante_numero: `B001-000${base}1` })).status).toBe(201);
      expect((await compra(admin, { comprobante_numero: `B001-000${base}2` })).status).toBe(201);
    });

    it("gemelo: el mismo número en OTRO proveedor sí entra (cada grifo numera aparte)", async () => {
      const n = `B001-000${Date.now().toString().slice(-6)}${seq++}`;
      expect((await compra(admin, { comprobante_numero: n })).status).toBe(201);
      expect((await compra(admin, { comprobante_numero: n, grifo_id: otroProveedor })).status).toBe(
        201
      );
    });

    it("se guarda el número tal como se escribió (sin espacios de los bordes)", async () => {
      const n = `B001-000${Date.now().toString().slice(-6)}${seq++}`;
      const r = await compra(admin, { comprobante_numero: `  ${n}  ` });
      expect(r.status).toBe(201);
      expect(r.body.comprobante_numero).toBe(n);
    });
  });

  // ── 2. El archivo disfrazado ──────────────────────────────────────────
  describe("2. el servidor mira el CONTENIDO, no lo que el archivo dice ser", () => {
    it("ataque: un ejecutable que dice ser JPEG -> 400", async () => {
      const id = await compraId();
      expect((await subir(admin, String(id), EXE, "image/jpeg", "boleta.jpg")).status).toBe(400);
    });

    it("ataque: un texto que dice ser PDF -> 400", async () => {
      const id = await compraId();
      const texto = Buffer.from("<script>alert(1)</script>");
      expect((await subir(admin, String(id), texto, "application/pdf", "b.pdf")).status).toBe(400);
    });

    it("ataque: un PNG que dice ser JPEG -> 400 (el tipo guardado tiene que ser el real)", async () => {
      const id = await compraId();
      expect((await subir(admin, String(id), PNG, "image/jpeg", "b.jpg")).status).toBe(400);
    });

    it("ataque: un archivo vacío -> 400", async () => {
      const id = await compraId();
      expect((await subir(admin, String(id), Buffer.alloc(0))).status).toBe(400);
    });

    it("gemelos: JPEG, PNG y PDF reales entran", async () => {
      expect((await subir(admin, String(await compraId()), JPEG)).status).toBe(201);
      expect((await subir(admin, String(await compraId()), PNG, "image/png", "b.png")).status).toBe(
        201
      );
      expect(
        (await subir(admin, String(await compraId()), PDF, "application/pdf", "b.pdf")).status
      ).toBe(201);
    });
  });

  // ── 3. La carrera ─────────────────────────────────────────────────────
  describe("3. dos fotos a la vez no reemplazan la evidencia sin motivo", () => {
    it("ataque: dos fotos DISTINTAS simultáneas -> solo una se guarda", async () => {
      const id = await compraId();
      const [a, b] = await Promise.all([
        subir(admin, String(id), JPEG),
        subir(admin, String(id), OTRO_JPEG),
      ]);
      const estados = [a.status, b.status].sort();
      expect(estados[0], "las dos se guardaron: una pisó a la otra sin motivo").toBe(201);
      expect([400, 409]).toContain(estados[1]);

      // Y lo que quedó guardado es la que respondió 201, no la otra.
      const ganadora = a.status === 201 ? JPEG : OTRO_JPEG;
      const bajada = await admin
        .get(`/api/erp/combustible/despachos/${id}/comprobante`)
        .buffer()
        .parse((res, cb) => {
          const t: Buffer[] = [];
          res.on("data", (x: Buffer) => t.push(x));
          res.on("end", () => cb(null, Buffer.concat(t)));
        });
      expect(Buffer.compare(bajada.body as Buffer, ganadora)).toBe(0);
    });

    it("gemelo: la MISMA foto dos veces a la vez (reintento de la cola) -> las dos 2xx", async () => {
      const id = await compraId();
      const [a, b] = await Promise.all([
        subir(admin, String(id), JPEG),
        subir(admin, String(id), JPEG),
      ]);
      expect([200, 201]).toContain(a.status);
      expect([200, 201]).toContain(b.status);
    });
  });

  // ── 4. El uuid ajeno ──────────────────────────────────────────────────
  describe("4. el uuid de otra cosa del módulo no resuelve a una compra", () => {
    it("ataque: un uuid de idempotencia que NO es de un despacho -> 404", async () => {
      // idempotency_keys guarda bajo 'combustible' los uuid de lecturas,
      // despachos y recepciones, y fila_id no dice de qué tabla es. Se
      // simula una lectura cuyo id coincide con el de una compra: su uuid no
      // puede terminar colgándole la foto a esa compra.
      const id = await compraId();
      const uuidDeLectura = crypto.randomUUID();
      await withTenant(tenantId, (client) =>
        client.query(
          `INSERT INTO idempotency_keys (tenant_id, modulo, cliente_uuid, fila_id)
           VALUES ($1, 'combustible', $2, $3)`,
          [tenantId, uuidDeLectura, id]
        )
      );
      expect((await subir(admin, `por-uuid/${uuidDeLectura}`, JPEG)).status).toBe(404);
    });

    it("gemelo: el uuid con que se registró la compra sí resuelve", async () => {
      const uuid = crypto.randomUUID();
      const id = await compraId(admin, { cliente_uuid: uuid });
      const r = await subir(admin, `por-uuid/${uuid}`, JPEG);
      expect(r.status).toBe(201);
      expect(r.body.id).toBe(id);
    });
  });

  // ── 5. El alcance ─────────────────────────────────────────────────────
  // Dueño y vecino en plantas DISTINTAS: entre compañeros de la misma planta
  // verse las compras es lo correcto (filtroVale en alcance.ts).
  describe("5. alcance (0100): un usuario de otra planta no toca la compra ajena", () => {
    let duenio: Awaited<ReturnType<typeof persona>>;
    let vecino: Awaited<ReturnType<typeof persona>>;
    let uuid: string;
    let id: number;

    beforeAll(async () => {
      duenio = await persona("operador");
      vecino = await persona("operador");
      for (const [p, grifo] of [
        [duenio, grifoInterno],
        [vecino, otroGrifoInterno],
      ] as const) {
        const r = await admin.put(`/api/erp/usuarios/${p.id}/permisos`).send({
          modulos: [],
          alcanceCombustible: { todo: false, sedes: [], grifos: [grifo], surtidores: [] },
          motivo: "Asignar planta",
        });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        await p.entrar();
      }
      uuid = crypto.randomUUID();
      id = await compraId(duenio.agente, { cliente_uuid: uuid });
    });

    it("ataque: el vecino sube por uuid a la compra del otro -> 404", async () => {
      expect((await subir(vecino.agente, `por-uuid/${uuid}`, JPEG)).status).toBe(404);
    });

    it("ataque: el vecino sube por id a la compra del otro -> 404", async () => {
      expect((await subir(vecino.agente, String(id), JPEG)).status).toBe(404);
    });

    it("ataque: el vecino descarga el comprobante del otro -> 404", async () => {
      expect((await subir(admin, String(id), JPEG)).status).toBe(201);
      const r = await vecino.agente.get(`/api/erp/combustible/despachos/${id}/comprobante`);
      expect(r.status).toBe(404);
    });

    it("gemelo: el dueño sí puede (reemplazo con motivo, porque ya tiene foto)", async () => {
      const r = await subir(duenio.agente, `por-uuid/${uuid}`, OTRO_JPEG, "image/jpeg", "b.jpg", {
        motivo: "la del admin estaba borrosa",
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    });
  });

  // ── 6. Los roles ──────────────────────────────────────────────────────
  describe("6. quién NO puede subir el comprobante", () => {
    for (const rol of ["grifero", "encargado_urea", "lectura"]) {
      it(`ataque: rol ${rol} -> 403`, async () => {
        const id = await compraId();
        const p = await persona(rol);
        const r = await subir(p.agente, String(id), JPEG);
        expect(r.status, JSON.stringify(r.body)).toBe(403);
      });
    }

    it("gemelo: el conductor de ruta sí puede", async () => {
      const p = await persona("conductor_ruta");
      const uuid = crypto.randomUUID();
      await compraId(p.agente, { cliente_uuid: uuid });
      expect((await subir(p.agente, `por-uuid/${uuid}`, JPEG)).status).toBe(201);
    });
  });

  // ── 7. El nombre del archivo ──────────────────────────────────────────
  describe("7. el nombre del archivo no inyecta nada en la descarga", () => {
    for (const nombre of ['"><img src=x onerror=alert(1)>.jpg', "../../etc/passwd.jpg"]) {
      it(`ataque: ${nombre}`, async () => {
        const id = await compraId();
        expect((await subir(admin, String(id), JPEG, "image/jpeg", nombre)).status).toBe(201);
        const r = await admin.get(`/api/erp/combustible/despachos/${id}/comprobante`);
        expect(r.status).toBe(200);
        expect(r.headers["content-disposition"]).toMatch(
          /^attachment; filename="[A-Za-z0-9._-]+"$/
        );
      });
    }
  });

  // ── 8. El rastro del reemplazo ────────────────────────────────────────
  describe("8. reemplazar la foto deja rastro con quién y por qué", () => {
    it("la bitácora guarda el motivo del reemplazo", async () => {
      const id = await compraId();
      await subir(admin, String(id), JPEG);
      const motivo = `ilegible ${idUnico("M")}`;
      expect(
        (await subir(admin, String(id), OTRO_JPEG, "image/jpeg", "b.jpg", { motivo })).status
      ).toBe(201);
      const r = await pool.query(
        `SELECT detalle FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'combustible.comprobante_reemplazar'
            AND detalle->>'despachoId' = $2`,
        [tenantId, String(id)]
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].detalle.motivo).toBe(motivo);
    });
  });
});
