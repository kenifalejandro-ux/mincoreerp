/** tests/combustible-alertas-enrutadas.test.ts
 *
 * A DÓNDE va cada alerta de combustible: enrutamiento por alcance, en los dos
 * canales (correo y campanita).
 *
 * El hueco que cierra esto venía de antes: la columna `grifo_interno_id` de
 * `combustible_alertas` existe desde 0097 y un trigger le estampa a cada
 * alerta el grifo del hecho que la disparó, pero NADIE la leía. Entonces el
 * jefe de planta de una sede recibía por correo el descuadre de la otra y lo
 * veía en su campanita, y si hacía clic le salía 404 -- porque el alcance sí
 * se respeta en el tanque. Avisar de algo que el destinatario no puede abrir
 * es la forma más rápida de que se arme un filtro en el correo y las alertas
 * dejen de existir.
 *
 * Método de siempre: cada "no le llegó" va con su GEMELO "sí le llegó". Un
 * "no llegó" solo no prueba nada -- podría estar roto el envío entero, y el
 * síntoma de eso es silencio, que es justo lo que nadie nota.
 *
 * Y dos cosas que solo se ven con dos empresas a la vez: que el enrutamiento
 * no sea una puerta para que una empresa vea las alertas de otra, y que el
 * aviso de "este grifo no le quedó a cargo de nadie" aparezca -- porque el
 * propio enrutamiento abre ese agujero nuevo.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { withTenant, closeDatabase } from "../src/server/config/database";
import {
  destinatariosDeAlertasEnGrifo,
  grifosSinDestinatariosDeAlertas,
} from "../src/modules/combustible/alcance";

/** Se mockea el PRIMITIVO y no cada mensaje: por `enviarCorreoAlerta` pasan
 *  los veinte correos del módulo, así que un solo mock prueba la cadena
 *  entera -- incluido el `to`, que es lo único que este archivo mira. Mismo
 *  criterio que combustible-urea-stock.test.ts. */
const correos: { destinatarios: { email: string }[]; asunto: string }[] = [];
vi.mock("../src/server/shared/utils/alertaMailer", () => ({
  enviarCorreoAlerta: vi.fn(
    async (args: { destinatarios: { email: string }[]; asunto: string }) => {
      correos.push({ destinatarios: args.destinatarios, asunto: args.asunto });
    }
  ),
}));

const PASSWORD = "ClaveDePrueba123";
let seq = 0;
const serieUnica = () => `R${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

afterAll(async () => {
  await closeDatabase();
});

describe("combustible: las alertas van a quien tiene ese punto en su alcance", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  let sedeA: number;
  let grifoA: number;
  let grifoB: number;
  let tanqueA: number;
  let tanqueB: number;
  let equipoB: number;

  /** Los tres destinatarios: uno por grifo y uno que ve todo. Todos CON
   *  correo -- quien entra por DNI no tiene y la consulta ya lo excluye. */
  let jefeA: { id: string; email: string };
  let jefeB: { id: string; email: string };
  let jefeTodo: { id: string; email: string };

  async function persona(nombre: string) {
    // En minúsculas: el alta normaliza el correo, así que compararlo con la
    // mayúscula original daría un falso negativo.
    const email = `${nombre}-${slug}@test.local`.toLowerCase();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre, email, password: PASSWORD, rol: "operador" });
    expect(alta.status).toBe(201);
    return { id: alta.body.id as string, email };
  }

  const permisosDe = async (usuarioId: string) => {
    const r = await admin.get(`/api/erp/usuarios/${usuarioId}/permisos`);
    expect(r.status).toBe(200);
    return r.body as {
      modulos: { modulo: string; asignado: boolean; nivel: string }[];
      alertasCorreo: { modulo: string; recibeAlertas: boolean }[];
      grifosSinDestinatarios: string[];
    };
  };

  /** Marca a alguien como destinatario de combustible y le fija el alcance,
   *  mandando el estado completo como lo hace la pantalla. */
  async function configurar(
    usuarioId: string,
    opciones: { recibe: boolean; alcance?: { grifos?: number[]; sedes?: number[] } }
  ) {
    const actuales = await permisosDe(usuarioId);
    const r = await admin.put(`/api/erp/usuarios/${usuarioId}/permisos`).send({
      modulos: actuales.modulos.map((m) => ({
        modulo: m.modulo,
        asignado: m.modulo === "combustible" ? true : m.asignado,
        nivel: m.nivel,
      })),
      alertasCorreo: actuales.alertasCorreo.map((a) => ({
        modulo: a.modulo,
        recibeAlertas: a.modulo === "combustible" ? opciones.recibe : a.recibeAlertas,
      })),
      alcanceCombustible: opciones.alcance
        ? { todo: false, sedes: [], grifos: [], surtidores: [], ...opciones.alcance }
        : { todo: true, sedes: [], grifos: [], surtidores: [] },
      motivo: "prueba automatizada: enrutamiento de alertas",
    });
    expect(r.status).toBe(200);
  }

  async function tanque(grifo: number) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: grifo,
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  /** La consulta que de verdad arma el `to` del correo. */
  const destinatarios = (grifo: number | null) =>
    withTenant(tenantId, (client) => destinatariosDeAlertasEnGrifo(client, tenantId, grifo));

  const correosDe = (grifo: number | null) =>
    destinatarios(grifo).then((d) => d.map((x) => x.email));

  /** Una alerta puesta a mano sobre un tanque. El trigger de 0097 le estampa
   *  el grifo igual que a cualquiera, así que sirve para probar el ruteo sin
   *  depender de qué control la disparó.
   *
   *  Con `producto: "urea"` queda SIN grifo, que es como pasa en la realidad:
   *  el trigger sale antes de buscarlo porque el inventario de urea es de la
   *  empresa, no de un punto. El ancla (el tanque) igual hace falta -- el
   *  CHECK `combustible_alertas_ancla_check` exige al menos una. */
  const alertaEnTanque = (combustibleId: number, producto = "combustible") =>
    withTenant(tenantId, async (client) => {
      const r = await client.query<{ id: string; grifo_interno_id: number | null }>(
        `INSERT INTO combustible_alertas (tenant_id, tipo, combustible_id, producto, detalle)
         VALUES ($1, 'nivel_bajo', $2, $3, '{}'::jsonb)
         RETURNING id, grifo_interno_id`,
        [tenantId, combustibleId, producto]
      );
      return r.rows[0];
    });

  const alertasQueVe = async (agente: ReturnType<typeof request.agent>) => {
    const r = await agente.get("/api/erp/combustible/alertas?page_size=100");
    expect(r.status).toBe(200);
    return r.body.data as { id: string; combustible_id: number | null }[];
  };

  beforeAll(async () => {
    const c = await crearTenantDePrueba(PASSWORD);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    const sesion = await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password: PASSWORD });
    expect(sesion.status).toBe(200);

    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    sedeA = sedes[0].id;
    grifoA = sedes[0].grifos[0].id;
    grifoB = (
      await admin.post("/api/erp/administracion/grifos").send({ sede_id: sedeA, nombre: "Punto B" })
    ).body.id;

    tanqueA = await tanque(grifoA);
    tanqueB = await tanque(grifoB);
    equipoB = (
      await admin
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EB"), tipo: "Volquete", grifo_interno_id: grifoB })
    ).body.id;

    jefeA = await persona("jefeA");
    jefeB = await persona("jefeB");
    jefeTodo = await persona("jefeTodo");
    await configurar(jefeA.id, { recibe: true, alcance: { grifos: [grifoA] } });
    await configurar(jefeB.id, { recibe: true, alcance: { grifos: [grifoB] } });
    await configurar(jefeTodo.id, { recibe: true });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  // ── 1. El reparto, con su gemelo en cada dirección ────────────────────

  it("el destinatario de un grifo no recibe las alertas del otro, y sí las propias", async () => {
    const deA = await correosDe(grifoA);
    const deB = await correosDe(grifoB);

    // El ataque: lo de B no le llega al jefe de A.
    expect(deB).not.toContain(jefeA.email);
    // El gemelo: lo de A sí le llega. Sin esto, el "no" de arriba podría ser
    // simplemente que nadie recibe nada.
    expect(deA).toContain(jefeA.email);

    expect(deA).not.toContain(jefeB.email);
    expect(deB).toContain(jefeB.email);
  });

  it("quien tiene alcance a toda la empresa recibe las de los dos grifos", async () => {
    expect(await correosDe(grifoA)).toContain(jefeTodo.email);
    expect(await correosDe(grifoB)).toContain(jefeTodo.email);
  });

  it("una alerta SIN grifo es de la empresa entera y le llega a todos", async () => {
    // Urea y los hechos de talonario quedan sin grifo a propósito (ver el
    // trigger copiar_grifo_alerta). No tener grifo no puede significar que no
    // le llegue a nadie: significa que es de todos.
    const todos = await correosDe(null);
    expect(todos).toEqual(expect.arrayContaining([jefeA.email, jefeB.email, jefeTodo.email]));
  });

  it("una sede asignada alcanza para sus grifos, incluso uno creado después", async () => {
    // El alcance por SEDE se expande a sus grifos, así que un punto nuevo
    // entra solo -- si no, abrir un grifo dejaría sus alertas sin dueño hasta
    // que alguien se acordara de reasignar permisos.
    const porSede = await persona("jefeSede");
    await configurar(porSede.id, { recibe: true, alcance: { sedes: [sedeA] } });
    const nuevo = (
      await admin.post("/api/erp/administracion/grifos").send({ sede_id: sedeA, nombre: "Punto C" })
    ).body.id as number;

    expect(await correosDe(nuevo)).toContain(porSede.email);
    expect(await correosDe(grifoA)).toContain(porSede.email);
    // Y el de un solo grifo sigue sin ver el nuevo.
    expect(await correosDe(nuevo)).not.toContain(jefeA.email);
  });

  it("sin la marca de destinatario no recibe nada, aunque vea el grifo", async () => {
    // El enrutamiento se suma a la marca de 0107, no la reemplaza.
    const mirona = await persona("sinMarca");
    await configurar(mirona.id, { recibe: false, alcance: { grifos: [grifoA] } });
    expect(await correosDe(grifoA)).not.toContain(mirona.email);
  });

  // ── 2. La campanita dice lo mismo que el correo ────────────────────────

  it("el panel de alertas no muestra las de un grifo fuera del alcance", async () => {
    const a = await alertaEnTanque(tanqueA);
    const b = await alertaEnTanque(tanqueB);
    const sinGrifo = await alertaEnTanque(tanqueB, "urea");
    // El trigger hizo su parte: cada alerta nació con su grifo.
    expect(a.grifo_interno_id).toBe(grifoA);
    expect(b.grifo_interno_id).toBe(grifoB);
    expect(sinGrifo.grifo_interno_id).toBeNull();

    const agenteA = request.agent(app);
    expect(
      (
        await agenteA
          .post("/api/auth/login")
          .send({ tenantSlug: slug, email: jefeA.email, password: PASSWORD })
      ).status
    ).toBe(200);

    const vistas = (await alertasQueVe(agenteA)).map((x) => String(x.id));
    expect(vistas).toContain(String(a.id)); // gemelo: la propia sí
    expect(vistas).not.toContain(String(b.id)); // el ataque
    expect(vistas).toContain(String(sinGrifo.id)); // sin grifo = de todos

    // Y el admin, que ve todo, ve las tres.
    const todas = (await alertasQueVe(admin)).map((x) => String(x.id));
    expect(todas).toEqual(
      expect.arrayContaining([String(a.id), String(b.id), String(sinGrifo.id)])
    );
  });

  it("marcar todas como leídas no apaga la campanita de la otra sede", async () => {
    // El estado de leída es compartido (0068), así que esto es lo que antes
    // dejaba a alguien sin ver una alerta que sí tenía que atender.
    const a = await alertaEnTanque(tanqueA);
    const b = await alertaEnTanque(tanqueB);

    const agenteA = request.agent(app);
    await agenteA
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: jefeA.email, password: PASSWORD });
    const r = await agenteA.patch("/api/erp/combustible/alertas/leidas").send({});
    expect(r.status).toBe(204);

    const leidas = await withTenant(tenantId, async (client) => {
      const q = await client.query<{ id: string; leida_en: Date | null }>(
        `SELECT id, leida_en FROM combustible_alertas WHERE id = ANY($1::bigint[])`,
        [[a.id, b.id]]
      );
      return new Map(q.rows.map((f) => [String(f.id), f.leida_en]));
    });
    expect(leidas.get(String(a.id))).not.toBeNull(); // gemelo: la suya sí
    expect(leidas.get(String(b.id))).toBeNull(); // la de la otra sede, intacta
  });

  // ── 3. El correo de verdad, de punta a punta ──────────────────────────

  it("el correo de un vale anulado sale solo para quien ve ese grifo", async () => {
    const serie = serieUnica();
    const creado = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueB,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoB,
      serie_talonario: serie,
      n_vale: 1,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
      despachado_en: new Date().toISOString(),
    });
    expect(creado.status).toBe(201);

    correos.length = 0;
    const anulado = await admin
      .patch(`/api/erp/combustible/despachos/${creado.body.id}/anular`)
      .send({ motivo: "prueba automatizada: ejercitar el correo enrutado" });
    expect(anulado.status).toBe(200);

    const anulacion = correos.find((c) => c.asunto.toLowerCase().includes("anul"));
    expect(anulacion).toBeDefined();
    const paraQuien = anulacion!.destinatarios.map((d) => d.email);
    expect(paraQuien).toContain(jefeB.email); // gemelo: el dueño del punto
    expect(paraQuien).toContain(jefeTodo.email); // y el que ve todo
    expect(paraQuien).not.toContain(jefeA.email); // el ataque
  });

  // ── 4. El agujero que abre el propio enrutamiento ─────────────────────

  it("avisa cuando un grifo no le quedó a cargo de nadie, y deja de avisar al asignarlo", async () => {
    // Antes alcanzaba con UN destinatario en toda la empresa. Ahora cada
    // punto necesita a alguien que lo mire, y un grifo nuevo puede quedar en
    // silencio sin que nadie lo note. Por eso se vigila explícitamente.
    // En una sede NUEVA a propósito: a la sede A la cubre entera el
    // destinatario por sede, así que un grifo nuevo ahí nace con dueño.
    const sedeNueva = (
      await admin.post("/api/erp/administracion/sedes").send({ nombre: idUnico("Sede") })
    ).body.id as number;
    const huerfano = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sedeNueva, nombre: "Punto sin nadie" })
    ).body.id as number;

    // jefeTodo ve todo, así que mientras esté marcado ningún grifo queda
    // huérfano: se lo saca de la lista para poder ver el aviso.
    await configurar(jefeTodo.id, { recibe: false });
    const sinNadie = () =>
      withTenant(tenantId, (client) => grifosSinDestinatariosDeAlertas(client, tenantId));

    expect(await sinNadie()).toEqual(
      expect.arrayContaining([expect.stringContaining("Punto sin nadie")])
    );
    // Gemelo: el grifo que sí tiene a alguien no aparece.
    expect(await sinNadie()).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Punto B")])
    );
    // Y nadie recibiría nada de ese punto, que es el síntoma real.
    expect(await correosDe(huerfano)).toEqual([]);

    const dueño = await persona("jefeHuerfano");
    await configurar(dueño.id, { recibe: true, alcance: { grifos: [huerfano] } });
    expect(await sinNadie()).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Punto sin nadie")])
    );
    expect(await correosDe(huerfano)).toContain(dueño.email);

    await configurar(jefeTodo.id, { recibe: true });
  });
});

// ── 5. Dos empresas a la vez ────────────────────────────────────────────

describe("combustible: el enrutamiento no cruza empresas", () => {
  let unaId: string;
  let otraId: string;
  let unaEmail: string;
  let otraEmail: string;
  let grifoDeUna: number;
  let grifoDeOtra: number;

  /** Deja una empresa con un grifo y un destinatario marcado, y devuelve sus
   *  datos. Las dos se arman igual para que la única diferencia sea la
   *  empresa. */
  async function armar(nombre: string) {
    const c = await crearTenantDePrueba(PASSWORD);
    const agente = request.agent(app);
    expect(
      (
        await agente
          .post("/api/auth/login")
          .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password: PASSWORD })
      ).status
    ).toBe(200);
    const grifo = (await agente.get("/api/erp/sedes")).body.sedes[0].grifos[0].id as number;
    const email = `${nombre}-${c.tenant.slug}@test.local`.toLowerCase();
    const alta = await agente
      .post("/api/erp/usuarios")
      .send({ nombre, email, password: PASSWORD, rol: "operador" });
    expect(alta.status).toBe(201);
    const actuales = (await agente.get(`/api/erp/usuarios/${alta.body.id}/permisos`)).body as {
      modulos: { modulo: string; asignado: boolean; nivel: string }[];
      alertasCorreo: { modulo: string; recibeAlertas: boolean }[];
    };
    expect(
      (
        await agente.put(`/api/erp/usuarios/${alta.body.id}/permisos`).send({
          modulos: actuales.modulos.map((m) => ({
            modulo: m.modulo,
            asignado: m.modulo === "combustible" ? true : m.asignado,
            nivel: m.nivel,
          })),
          alertasCorreo: actuales.alertasCorreo.map((a) => ({
            modulo: a.modulo,
            recibeAlertas: a.modulo === "combustible" ? true : a.recibeAlertas,
          })),
          alcanceCombustible: { todo: true, sedes: [], grifos: [], surtidores: [] },
          motivo: "prueba automatizada: aislamiento entre empresas",
        })
      ).status
    ).toBe(200);
    return { tenantId: c.tenant.id as string, grifo, email };
  }

  beforeAll(async () => {
    const una = await armar("deUna");
    const otra = await armar("deOtra");
    unaId = una.tenantId;
    otraId = otra.tenantId;
    unaEmail = una.email;
    otraEmail = otra.email;
    grifoDeUna = una.grifo;
    grifoDeOtra = otra.grifo;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(unaId);
    await borrarTenantDePrueba(otraId);
  });

  it("cada empresa arma su lista con su propia gente, y nunca con la de la otra", async () => {
    const deUna = await withTenant(unaId, (client) =>
      destinatariosDeAlertasEnGrifo(client, unaId, grifoDeUna)
    );
    const deOtra = await withTenant(otraId, (client) =>
      destinatariosDeAlertasEnGrifo(client, otraId, grifoDeOtra)
    );

    expect(deUna.map((d) => d.email)).toEqual([unaEmail]);
    expect(deOtra.map((d) => d.email)).toEqual([otraEmail]);
  });

  it("con el id de grifo de otra empresa nunca aparece gente de esa otra empresa", async () => {
    // Los ids de grifo son seriales GLOBALES, así que el id de la otra empresa
    // es un número perfectamente válido acá. Lo que corta el cruce es el
    // tenant de la consulta, no que el id no exista.
    //
    // Ojo con lo que se afirma: la lista NO vuelve vacía, y está bien. Quien
    // tiene alcance a toda su empresa recibe TODAS las alertas de SU empresa,
    // sin importar qué grifo se pregunte -- el grifo solo filtra a los que
    // tienen alcance asignado. Lo que no puede pasar nunca es que asome
    // alguien del otro lado.
    const colado = await withTenant(unaId, (client) =>
      destinatariosDeAlertasEnGrifo(client, unaId, grifoDeOtra)
    );
    expect(colado.map((d) => d.email)).not.toContain(otraEmail);
    expect(colado.map((d) => d.email)).toEqual([unaEmail]);
  });

  it("una alerta sin grifo tampoco se escapa a la otra empresa", async () => {
    // El camino `null` saltea el filtro de alcance entero: hay que probar que
    // igual queda encerrado en su empresa.
    const deUna = await withTenant(unaId, (client) =>
      destinatariosDeAlertasEnGrifo(client, unaId, null)
    );
    expect(deUna.map((d) => d.email)).toEqual([unaEmail]);
    expect(deUna.map((d) => d.email)).not.toContain(otraEmail);
  });
});
