/** tests/combustible-tanqueta-kardex.test.ts
 *
 * El kardex de la tanqueta del conductor (GET /tanquetas/mias y /tanquetas/:id/kardex):
 *  1. la función pura `armarKardex` con datos armados a mano: saldo acumulado, orden, vales,
 *     conductor por DNI, filtros y tope;
 *  2. la API: la última fila es el saldo del cilindro, el conductor solo ve las tanquetas de SU
 *     unidad (el mismo 404 para lo ajeno, lo inexistente y lo de otra empresa) y nada interno
 *     (costos, quién registró, motivos, DNI) sale en la respuesta.
 *
 * Cada permiso concedido con su gemelo negado (método de combustible-comprobante-adversario.test.ts).
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  app,
  crearTenantDePrueba,
  borrarTenantDePrueba,
  idUnico,
  recibirTanqueta,
} from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import {
  armarKardex,
  type MovimientoBruto,
  type VentanaDeVale,
} from "../src/modules/combustible/kardexTanqueta";

const t = (iso: string) => new Date(`2026-10-${iso}:00.000Z`);

function mov(m: Partial<MovimientoBruto> & Pick<MovimientoBruto, "tipo" | "id" | "fecha">) {
  return {
    cantidad: null,
    anulada: false,
    referencia: null,
    unidad: null,
    serie: null,
    nVale: null,
    conductor: null,
    conductorDni: null,
    ...m,
  } satisfies MovimientoBruto;
}

describe("kardex de la tanqueta: el cálculo", () => {
  const llenado = mov({
    tipo: "prevision",
    id: "1",
    fecha: t("01T08:00"),
    cantidad: 100,
    referencia: "TQ-1",
    serie: "HMC",
    nVale: 1,
  });
  const asignacion = mov({
    tipo: "asignacion",
    id: "1",
    fecha: t("01T09:00"),
    cantidad: 100,
    unidad: "VQ-1",
    serie: "ASG",
    nVale: 2,
  });
  const carga = (
    id: string,
    hora: string,
    cantidad: number,
    extra: Partial<MovimientoBruto> = {}
  ) =>
    mov({
      tipo: "carga_ruta",
      id,
      fecha: t(`01T${hora}`),
      cantidad,
      unidad: "VQ-1",
      conductor: "Ana",
      conductorDni: "111",
      ...extra,
    });
  const ventana: VentanaDeVale = { vale: "ASG-2", inicio: t("01T09:00"), fin: null };

  it("suma entradas y resta salidas; la asignación y una anulada no mueven el saldo", () => {
    const k = armarKardex(
      [
        llenado,
        asignacion,
        carga("1", "10:00", 30),
        carga("2", "11:00", 20, { anulada: true }),
        carga("3", "12:00", 10),
      ],
      [ventana],
      60
    );
    expect(k.saldoFinal).toBe(60);
    expect(k.cuadra).toBe(true);
    // Más reciente primero; el saldo es el de DESPUÉS de cada fila.
    expect(k.filas.map((f) => [f.tipo, f.saldo])).toEqual([
      ["carga_ruta", 60],
      ["carga_ruta", 70], // la anulada: no movió nada
      ["carga_ruta", 70],
      ["asignacion", 100],
      ["prevision", 100],
    ]);
    const anulada = k.filas.find((f) => f.anulada)!;
    expect([anulada.entra, anulada.sale, anulada.cantidad]).toEqual([0, 0, 20]);
    expect(k.filas.find((f) => f.tipo === "asignacion")!.lleva).toBe(100);
  });

  it("marca que no cuadra cuando la última fila no es el saldo de la tanqueta", () => {
    const k = armarKardex([llenado, carga("1", "10:00", 30)], [], 75);
    expect(k.saldoFinal).toBe(70);
    expect(k.cuadra).toBe(false);
  });

  it("dos filas del grifero en el mismo instante: el ajuste va antes y el saldo no baja de cero", () => {
    const retorno = t("02T08:00");
    const k = armarKardex(
      [
        llenado,
        // Pozo guardado "antes" que el ajuste en el arreglo: el orden lo decide la prioridad.
        mov({ tipo: "retorno_pozo", id: "9", fecha: retorno, cantidad: 97, referencia: "T-1" }),
        mov({ tipo: "retorno", id: "9", fecha: retorno, cantidad: -3, unidad: "VQ-1" }),
      ],
      [],
      0
    );
    expect(k.filas.map((f) => [f.tipo, f.saldo])).toEqual([
      ["retorno_pozo", 0],
      ["retorno", 97],
      ["prevision", 100],
    ]);
    expect(Math.min(...k.filas.map((f) => f.saldo))).toBe(0);
    expect(k.cuadra).toBe(true);
  });

  it("un ajuste de cero no es una fila; uno positivo entra", () => {
    const k = armarKardex(
      [
        llenado,
        mov({ tipo: "retorno", id: "1", fecha: t("02T08:00"), cantidad: 0 }),
        mov({ tipo: "retorno", id: "2", fecha: t("02T09:00"), cantidad: 2 }),
      ],
      [],
      102
    );
    expect(k.filas.map((f) => f.tipo)).toEqual(["retorno", "prevision"]);
    expect(k.filas[0].entra).toBe(2);
    expect(k.cuadra).toBe(true);
  });

  it("cada carga lleva el vale de SU salida; una fuera de toda salida no lleva ninguno", () => {
    const vieja: VentanaDeVale = { vale: "ASG-2", inicio: t("01T09:00"), fin: t("01T12:00") };
    const nueva: VentanaDeVale = { vale: "ASG-7", inicio: t("01T12:00"), fin: null };
    const k = armarKardex(
      [asignacion, carga("1", "10:00", 5), carga("2", "12:00", 5), carga("3", "08:00", 5)],
      [nueva, vieja],
      0
    );
    const vale = (id: string) => k.filas.find((f) => f.clave === `carga_ruta-${id}`)!.vale;
    expect(vale("1")).toBe("ASG-2");
    expect(vale("2")).toBe("ASG-7"); // en el instante en que empieza la nueva ya es de la nueva
    expect(vale("3")).toBeNull(); // antes de toda asignación
    // La asignación y el llenado llevan su propio vale.
    expect(k.filas.find((f) => f.tipo === "asignacion")!.vale).toBe("ASG-2");
  });

  it("una carga con vale propio (en planta) muestra el vale de su salida, como el listado", () => {
    const k = armarKardex(
      [asignacion, carga("1", "10:00", 5, { serie: "HMC", nVale: 9, tipo: "carga_planta" })],
      [ventana],
      0
    );
    expect(k.filas.find((f) => f.clave === "carga_planta-1")!.vale).toBe("ASG-2");
  });

  it("una asignación anterior a la 0142 (sin cantidad) no rompe nada", () => {
    const k = armarKardex([mov({ ...asignacion, cantidad: null })], [ventana], 0);
    expect(k.filas[0].lleva).toBeNull();
    expect(k.saldoFinal).toBe(0);
  });

  it("al abrir se muestra desde la salida en curso; sin ninguna, desde el principio", () => {
    expect(armarKardex([asignacion], [ventana], 0).desdeSalidaActual).toBe(
      ventana.inicio.toISOString()
    );
    const cerrada: VentanaDeVale = { ...ventana, fin: t("02T00:00") };
    expect(armarKardex([asignacion], [cerrada], 0).desdeSalidaActual).toBeNull();
    expect(armarKardex([], [], 0).desdeSalidaActual).toBeNull();
  });

  describe("el conductor es la persona (su DNI), no el texto del nombre", () => {
    const movs = [
      carga("1", "10:00", 10, { conductor: "Juan Perez", conductorDni: "40111111" }),
      carga("2", "11:00", 10, { conductor: "Juan Pérez Rojas", conductorDni: "40111111" }),
      carga("3", "12:00", 10, { conductor: "Luis Soto", conductorDni: "40222222" }),
      carga("4", "13:00", 10, { conductor: "Sin Dni", conductorDni: null }),
      carga("5", "14:00", 10, { conductor: "Sin Dni", conductorDni: " " }),
    ];

    it("el mismo DNI con dos nombres sale una vez, con el más reciente", () => {
      const k = armarKardex(movs, [], 0);
      expect(k.conductores).toEqual(["Juan Pérez Rojas", "Luis Soto", "Sin Dni"]);
      const deJuan = armarKardex(movs, [], 0, { conductor: "Juan Pérez Rojas" });
      expect(deJuan.filas.map((f) => f.clave).sort()).toEqual(["carga_ruta-1", "carga_ruta-2"]);
      // El nombre viejo ya no es una opción: el filtro es por el nombre que se muestra.
      expect(armarKardex(movs, [], 0, { conductor: "Juan Perez" }).total).toBe(0);
    });

    it("dos DNI distintos no se mezclan; sin DNI se agrupa por nombre", () => {
      const k = armarKardex(movs, [], 0, { conductor: "Luis Soto" });
      expect(k.filas.map((f) => f.clave)).toEqual(["carga_ruta-3"]);
      expect(armarKardex(movs, [], 0, { conductor: "Sin Dni" }).total).toBe(2);
    });

    it("el DNI no sale en la respuesta", () => {
      const json = JSON.stringify(armarKardex(movs, [], 0));
      expect(json).not.toContain("40111111");
      expect(json).not.toContain("40222222");
    });
  });

  describe("filtros y tope", () => {
    const movs = [
      llenado,
      carga("1", "10:00", 10),
      carga("2", "11:00", 10, { unidad: "VQ-2", conductor: "Luis", conductorDni: "222" }),
      carga("3", "12:00", 10),
    ];

    it("el saldo de cada fila sigue siendo el real aunque se filtre", () => {
      const k = armarKardex(movs, [], 70, { unidad: "VQ-2" });
      expect(k.filas.map((f) => [f.clave, f.saldo])).toEqual([["carga_ruta-2", 80]]);
      // Las opciones de los filtros no se achican con el filtro.
      expect(k.unidades).toEqual(["VQ-1", "VQ-2"]);
      expect(k.conductores).toEqual(["Ana", "Luis"]);
    });

    it("desde y hasta incluyen sus extremos; unidad y conductor se suman", () => {
      const k = armarKardex(movs, [], 70, { desde: t("01T10:00"), hasta: t("01T11:00") });
      expect(k.filas.map((f) => f.clave)).toEqual(["carga_ruta-2", "carga_ruta-1"]);
      const ana = armarKardex(movs, [], 70, { conductor: "Ana", unidad: "VQ-2" });
      expect(ana.total).toBe(0);
    });

    it("el tope devuelve las más recientes y avisa que hay más", () => {
      const k = armarKardex(movs, [], 70, {}, 2);
      expect(k.filas.map((f) => f.clave)).toEqual(["carga_ruta-3", "carga_ruta-2"]);
      expect([k.total, k.truncado]).toEqual([4, true]);
      expect(armarKardex(movs, [], 70, {}, 4).truncado).toBe(false);
    });
  });
});

describe("kardex de la tanqueta del conductor: la API", () => {
  const password = "ClaveDePrueba123";
  const base = "/api/erp/combustible";
  let tenantId: string;
  let slug: string;
  let otro: Awaited<ReturnType<typeof crearTenantDePrueba>>;
  const admin = request.agent(app);
  let grifo: number;
  let tanque: number;
  let nVale = 1;
  let medidor = 1000;
  let seq = 0;

  interface Persona {
    agente: ReturnType<typeof request.agent>;
    dni: string;
    equipo: number;
    placa: string;
  }

  async function usuario(rol: string, overrides: Record<string, boolean> = {}) {
    const agente = request.agent(app);
    const dni = String(87100000 + Math.floor(Math.random() * 700000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `T ${rol}`, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    for (const [pestana, permitido] of Object.entries(overrides)) {
      await withTenant(tenantId, (c) =>
        c.query(
          `INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
           VALUES ($1,$2,'combustible',$3,$4)`,
          [tenantId, alta.body.id, pestana, permitido]
        )
      );
    }
    const entrar = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(entrar.status).toBe(200);
    return { agente, dni };
  }

  /** Un conductor con su unidad a cargo en Equipos (el DNI del usuario = el de la unidad). */
  async function conductorConUnidad(nombre: string): Promise<Persona> {
    const { agente, dni } = await usuario("conductor_ruta");
    const placa = idUnico("VQ");
    const equipo = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: placa,
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: grifo,
        conductor_nombre: nombre,
        conductor_dni: dni,
      })
    ).body.id as number;
    return { agente, dni, equipo, placa };
  }

  /** Una tanqueta con `cantidad` galones, asignada a la unidad con su vale. */
  async function tanquetaDe(p: Persona, cantidad = 100) {
    const id = Number(
      (await admin.post(`${base}/tanquetas`).send({ grifo_interno_id: grifo })).body.id
    );
    const llenado = await admin.post(`${base}/despachos`).send({
      origen: "tanque_propio",
      combustible_id: tanque,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: id,
      serie_talonario: "HMC",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
    });
    expect(llenado.status, JSON.stringify(llenado.body)).toBe(201);
    const vale = nVale++;
    const asignada = await admin
      .put(`${base}/tanquetas/${id}/asignar`)
      .send({ equipo_id: p.equipo, serie_talonario: "ASG", n_vale: vale });
    expect(asignada.status, JSON.stringify(asignada.body)).toBe(200);
    return { id, vale: `ASG-${vale}` };
  }

  const cargar = (quien: ReturnType<typeof request.agent>, tanqueta: number, p: Persona, n = 10) =>
    quien.post(`${base}/despachos`).send({
      origen: "tanqueta",
      tanqueta_origen_id: tanqueta,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: p.equipo,
      cantidad: n,
      lectura_horometro: medidor++,
    });

  const kardex = (quien: ReturnType<typeof request.agent>, id: number | string, qs = "") =>
    quien.get(`${base}/tanquetas/${id}/kardex${qs}`);

  const saldoEnElPanel = async (id: number) =>
    Number(
      ((await admin.get(`${base}/tanquetas`)).body as { id: string; saldo: string }[]).find(
        (x) => Number(x.id) === id
      )!.saldo
    );

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    grifo = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    tanque = (
      await admin.post("/api/erp/combustible").send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Huamachuco",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 10000,
        nivel_actual: 8000,
        requiere_documento: false,
        grifo_interno_id: grifo,
      })
    ).body.id;
    otro = await crearTenantDePrueba(password);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(otro.tenant.id);
    await closeDatabase();
  });

  describe("la última fila es el saldo del cilindro", () => {
    let ana: Persona;
    let otra: Persona;
    let t1: { id: number; vale: string };
    let cargaDelAdmin: number;
    let cargaAnulada: number;

    beforeAll(async () => {
      ana = await conductorConUnidad("Ana Quispe");
      otra = await conductorConUnidad("Berta Ruiz");
      t1 = await tanquetaDe(ana, 100);
      await tanquetaDe(otra, 50);
      expect((await cargar(ana.agente, t1.id, ana, 10)).status).toBe(201);
      const delAdmin = await cargar(admin, t1.id, ana, 5);
      expect(delAdmin.status, JSON.stringify(delAdmin.body)).toBe(201);
      cargaDelAdmin = delAdmin.body.id;
      const anulable = await cargar(ana.agente, t1.id, ana, 7);
      expect(anulable.status).toBe(201);
      cargaAnulada = anulable.body.id;
      const anulada = await admin
        .patch(`${base}/despachos/${cargaAnulada}/anular`)
        .send({ motivo: "Digitada de más" });
      expect(anulada.status, JSON.stringify(anulada.body)).toBe(200);
    });

    it("cuadra con el saldo del panel, con el llenado, la asignación, las cargas y la anulada", async () => {
      const r = await kardex(ana.agente, t1.id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await saldoEnElPanel(t1.id)).toBe(85);
      expect(r.body.cuadra).toBe(true);
      expect(r.body.saldoFinal).toBe(85);
      expect(r.body.tanqueta).toMatchObject({ id: t1.id, capacidad: 280, saldo: 85 });
      expect(r.body.filas[0].saldo).toBe(85);
      expect(r.body.filas.map((f: { tipo: string }) => f.tipo)).toEqual([
        "carga_ruta",
        "carga_ruta",
        "carga_ruta",
        "asignacion",
      ]);
      // El llenado de la tanqueta es anterior a su salida: el saldo lo cuenta, la fila no se ve.
      expect(r.body.filas[r.body.filas.length - 1].saldo).toBe(100);
      const anulada = r.body.filas.find((f: { anulada: boolean }) => f.anulada);
      expect(anulada).toMatchObject({ entra: 0, sale: 0, cantidad: 7 });
    });

    it("el vale de las cargas es el de la asignación, también el de la que registró otro", async () => {
      const r = await kardex(ana.agente, t1.id);
      const cargas = r.body.filas.filter((f: { tipo: string }) => f.tipo === "carga_ruta");
      expect(cargas.every((f: { vale: string }) => f.vale === t1.vale)).toBe(true);
      const asignacion = r.body.filas.find((f: { tipo: string }) => f.tipo === "asignacion");
      expect(asignacion).toMatchObject({ vale: t1.vale, lleva: 100, unidad: ana.placa });
      expect(r.body.desdeSalidaActual).toBe(asignacion.fecha);
    });

    it("lo que dice el kardex coincide con el vale_salida del listado de cargas del conductor", async () => {
      const lista = await ana.agente.get(`${base}/despachos?origen=tanqueta`);
      expect(lista.status).toBe(200);
      const k = await kardex(ana.agente, t1.id);
      const delKardex = k.body.filas.filter((x: { tipo: string }) => x.tipo === "carga_ruta");
      let comparadas = 0;
      for (const f of delKardex) {
        const id = String(f.clave).replace("carga_ruta-", "");
        // Los ids vienen como texto en una respuesta y como número en la otra.
        const deLaLista = lista.body.data.find((d: { id: number | string }) => String(d.id) === id);
        if (deLaLista) {
          comparadas++;
          expect(deLaLista.vale_salida, `carga ${id}`).toBe(f.vale);
          expect(f.vale).toBe(t1.vale);
        }
      }
      // Las dos de Ana (la anulada incluida); la del admin no es suya y no está en su lista.
      expect(comparadas).toBe(2);
      expect(
        lista.body.data.some((d: { id: number | string }) => String(d.id) === String(cargaDelAdmin))
      ).toBe(false);
    });

    it("nada interno sale: ni costos, ni quién registró, ni motivos, ni DNI", async () => {
      const r = await kardex(ana.agente, t1.id);
      const texto = JSON.stringify(r.body);
      for (const prohibido of [ana.dni, "costo", "usuario", "Digitada de más", "conductor_dni"]) {
        expect(texto, prohibido).not.toContain(prohibido);
      }
      // El motivo del ajuste solo sale en el cierre de salida, nunca en las filas.
      expect(JSON.stringify(r.body.filas)).not.toContain("motivo");
      const mias = await ana.agente.get(`${base}/tanquetas/mias`);
      expect(JSON.stringify(mias.body)).not.toContain("costo");
    });

    it("la carga de otra persona en su unidad (un relevo) no se muestra, ni su nombre", async () => {
      // Un relevo: la carga del admin queda a nombre de otro conductor (otro DNI).
      await withTenant(tenantId, (c) =>
        c.query(
          `UPDATE combustible_despachos SET conductor_nombre = 'Carlos Relevo', conductor_dni = '40999000'
            WHERE id = $1`,
          [cargaDelAdmin]
        )
      );
      const r = await kardex(ana.agente, t1.id);
      expect(r.body.conductores).toEqual(["Ana Quispe"]);
      expect(JSON.stringify(r.body)).not.toContain("Carlos");
      expect(
        r.body.filas.some((f: { clave: string }) => f.clave === `carga_ruta-${cargaDelAdmin}`)
      ).toBe(false);
      // Ocultar la fila no cambia el saldo: el cilindro sigue siendo el real.
      expect(r.body.saldoFinal).toBe(85);
      expect(r.body.cuadra).toBe(true);
      const deCarlos = await kardex(ana.agente, t1.id, "?conductor=Carlos%20Relevo");
      expect(deCarlos.body.filas).toEqual([]);
      const dePlaca = await kardex(ana.agente, t1.id, `?unidad=${encodeURIComponent(ana.placa)}`);
      expect(dePlaca.body.total).toBeGreaterThanOrEqual(3);
      const deOtra = await kardex(ana.agente, t1.id, "?unidad=NO-EXISTE");
      expect(deOtra.body.filas).toEqual([]);
    });

    it("el mismo DNI escrito de dos maneras es una sola persona en el filtro", async () => {
      await withTenant(tenantId, (c) =>
        c.query(
          `UPDATE combustible_despachos SET conductor_nombre = 'Ana Quispe Lopez'
            WHERE tanqueta_origen_id = $1 AND conductor_dni = $2
              AND despachado_en = (SELECT max(despachado_en) FROM combustible_despachos
                                    WHERE tanqueta_origen_id = $1 AND conductor_dni = $2)`,
          [t1.id, ana.dni]
        )
      );
      const r = await kardex(ana.agente, t1.id);
      expect(r.body.conductores.filter((n: string) => n.startsWith("Ana"))).toEqual([
        "Ana Quispe Lopez",
      ]);
      const deAna = await kardex(ana.agente, t1.id, "?conductor=Ana%20Quispe%20Lopez");
      expect(deAna.body.total).toBe(2); // sus dos cargas, la anulada incluida
    });

    it("desde y hasta acotan; con desde mayor que hasta o fechas rotas es 400, no 500", async () => {
      const futuro = encodeURIComponent("2099-01-01T00:00:00Z");
      const vacio = await kardex(ana.agente, t1.id, `?desde=${futuro}`);
      expect(vacio.status).toBe(200);
      expect(vacio.body.filas).toEqual([]);
      expect(vacio.body.saldoFinal).toBe(85); // lo filtrado no cambia el saldo real
      for (const qs of [
        `?desde=${futuro}&hasta=${encodeURIComponent("2020-01-01T00:00:00Z")}`,
        "?desde=ayer",
        "?hasta=2026-13-45",
        `?unidad=${"x".repeat(61)}`,
        `?conductor=${"x".repeat(151)}`,
        "?unidad=",
      ]) {
        const r = await kardex(ana.agente, t1.id, qs);
        expect(r.status, qs).toBe(400);
      }
    });

    it("el panel de la tanqueta de otro conductor no se mezcla en el kardex de Ana", async () => {
      const mias = await otra.agente.get(`${base}/tanquetas/mias`);
      expect(mias.body).toHaveLength(1);
      const k = await kardex(otra.agente, mias.body[0].id);
      expect(k.body.cuadra).toBe(true);
      expect(k.body.saldoFinal).toBe(50);
      expect(JSON.stringify(k.body)).not.toContain("Ana Quispe");
    });
  });

  describe("quién ve qué (cada permiso con su gemelo negado)", () => {
    let ana: Persona;
    let otra: Persona;
    let t1: { id: number };
    let t2: { id: number };

    beforeAll(async () => {
      ana = await conductorConUnidad("Ana Aislada");
      otra = await conductorConUnidad("Berta Aislada");
      t1 = await tanquetaDe(ana, 40);
      t2 = await tanquetaDe(otra, 40);
    });

    it("/mias trae solo las de su unidad, y sin ninguna unidad viene vacío con la marca", async () => {
      const r = await ana.agente.get(`${base}/tanquetas/mias`);
      expect(r.status).toBe(200);
      expect(r.body.map((x: { id: number }) => x.id)).toEqual([t1.id]);
      expect(r.headers["x-conductor-sin-unidad"]).toBeUndefined();
      expect(r.body[0]).toMatchObject({
        equipo_asignado: ana.placa,
        capacidad: 280,
        saldo: 40,
        asignada_vigente: true,
      });
      const sinUnidad = await usuario("conductor_ruta");
      const vacia = await sinUnidad.agente.get(`${base}/tanquetas/mias`);
      expect(vacia.status).toBe(200);
      expect(vacia.body).toEqual([]);
      expect(vacia.headers["x-conductor-sin-unidad"]).toBe("1");
    });

    it("la tanqueta de otra unidad, la que no existe y la de otra empresa dan el mismo 404", async () => {
      const ajena = await kardex(ana.agente, t2.id);
      const inexistente = await kardex(ana.agente, 99999999);
      expect(ajena.status).toBe(404);
      expect(inexistente.status).toBe(404);
      expect(ajena.body).toEqual(inexistente.body);

      // Una empresa ajena: su conductor, con sesión propia, pide la tanqueta de esta.
      const dni = String(87900000 + Math.floor(Math.random() * 90000));
      const otroAdmin = request.agent(app);
      await otroAdmin
        .post("/api/auth/login")
        .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
      const alta = await otroAdmin
        .post("/api/erp/usuarios")
        .send({ nombre: "Foráneo", dni, password, rol: "conductor_ruta" });
      expect(alta.status, JSON.stringify(alta.body)).toBe(201);
      const foraneo = request.agent(app);
      const entrar = await foraneo
        .post("/api/auth/login")
        .send({ tenantSlug: otro.tenant.slug, identificador: dni, password });
      expect(entrar.status).toBe(200);
      const r = await kardex(foraneo, t1.id);
      expect(r.status).toBe(404);
      expect(r.body).toEqual(inexistente.body);
    });

    it("el id roto es 400, no 500", async () => {
      const propio = t1.id;
      for (const id of [
        "abc",
        "0",
        "-3",
        "1.5",
        "99999999999999999999",
        // Formas que Number() acepta y apuntan a la tanqueta propia: no son un id.
        `${propio}.0`,
        `+${propio}`,
        `${propio}e0`,
        `0x${propio.toString(16)}`,
        `%20${propio}`,
        `0${propio}`,
      ]) {
        expect((await kardex(ana.agente, id)).status, id).toBe(400);
      }
    });

    it("el permiso se concede con su gemelo: sin el permiso, o con otro rol, es 403", async () => {
      const sinPermiso = await usuario("conductor_ruta", { "tanques:registrar_despacho": false });
      const grifero = await usuario("grifero");
      for (const quien of [sinPermiso.agente, grifero.agente, admin]) {
        expect((await quien.get(`${base}/tanquetas/mias`)).status).toBe(403);
        expect((await kardex(quien, t1.id)).status).toBe(403);
      }
      expect((await ana.agente.get(`${base}/tanquetas/mias`)).status).toBe(200);
      expect((await kardex(ana.agente, t1.id)).status).toBe(200);
    });

    it("sin sesión es 401", async () => {
      expect((await request(app).get(`${base}/tanquetas/mias`)).status).toBe(401);
      expect((await request(app).get(`${base}/tanquetas/${t1.id}/kardex`)).status).toBe(401);
    });
  });

  describe("el ciclo de la tanqueta", () => {
    it("una tanqueta que se vacía sigue en /mias con saldo 0 aunque el formulario ya no la ofrezca", async () => {
      const carlos = await conductorConUnidad("Carlos Vacío");
      const { id } = await tanquetaDe(carlos, 20);
      expect((await cargar(carlos.agente, id, carlos, 20)).status).toBe(201);
      const formulario = await carlos.agente.get(`${base}/tanquetas/formulario`);
      expect(formulario.body).toEqual([]);
      const mias = await carlos.agente.get(`${base}/tanquetas/mias`);
      expect(mias.body).toHaveLength(1);
      expect(mias.body[0]).toMatchObject({ id, saldo: 0, asignada_vigente: false });
      const k = await kardex(carlos.agente, id);
      expect(k.status).toBe(200);
      expect([k.body.saldoFinal, k.body.cuadra]).toEqual([0, true]);
    });

    it("la que lleva saldo va primero y las demás por antigüedad", async () => {
      const dora = await conductorConUnidad("Dora Dos");
      const vacia = await tanquetaDe(dora, 10);
      expect((await cargar(dora.agente, vacia.id, dora, 10)).status).toBe(201);
      const conSaldo = await tanquetaDe(dora, 30);
      const mias = await dora.agente.get(`${base}/tanquetas/mias`);
      expect(mias.body.map((x: { id: number }) => x.id)).toEqual([conSaldo.id, vacia.id]);
    });

    it("una carga en planta con vale propio dice lo mismo en el kardex y en el listado del admin", async () => {
      const hugo = await conductorConUnidad("Hugo Planta");
      const { id, vale } = await tanquetaDe(hugo, 50);
      const carga = await admin.post(`${base}/despachos`).send({
        origen: "tanqueta",
        tanqueta_origen_id: id,
        tanqueta_lugar: "planta",
        serie_talonario: "HMC",
        n_vale: nVale++,
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: hugo.equipo,
        cantidad: 5,
        lectura_horometro: medidor++,
      });
      expect(carga.status, JSON.stringify(carga.body)).toBe(201);
      const fila = (await kardex(hugo.agente, id)).body.filas.find(
        (f: { clave: string }) => f.clave === `carga_planta-${carga.body.id}`
      );
      const delListado = (await admin.get(`${base}/despachos?origen=tanqueta`)).body.data.find(
        (d: { id: number | string }) => String(d.id) === String(carga.body.id)
      );
      expect(fila.vale).toBe(vale);
      expect(delListado.vale_salida).toBe(vale);
    });

    it("mientras otros cargan, el kardex nunca dice que no cuadra", async () => {
      // Antes cada consulta veía su propia foto y una carga confirmada entre el saldo y el
      // historial dejaba la última fila 1 gal desfasada ("no cuadra") sin ningún error real.
      const rita = await conductorConUnidad("Rita Carrera");
      const { id } = await tanquetaDe(rita, 280);
      let corriendo = true;
      const falsos: string[] = [];
      let lecturas = 0;
      const lector = async () => {
        while (corriendo) {
          const r = await kardex(rita.agente, id);
          lecturas++;
          if (r.status !== 200 || r.body.cuadra !== true) {
            falsos.push(`${r.status} ${r.body.saldoFinal} vs ${r.body.tanqueta?.saldo}`);
          }
        }
      };
      const lectores = [lector(), lector(), lector()];
      for (let i = 0; i < 20; i++) {
        expect((await cargar(admin, id, rita, 1)).status).toBe(201);
      }
      corriendo = false;
      await Promise.all(lectores);
      expect(lecturas).toBeGreaterThan(20);
      expect(falsos).toEqual([]);
      expect((await kardex(rita.agente, id)).body.saldoFinal).toBe(260);
    }, 90_000);

    it("al devolverla al grifero sale de /mias pero su historial se queda, como salida cerrada", async () => {
      const eva = await conductorConUnidad("Eva Retorno");
      const { id, vale } = await tanquetaDe(eva, 30);
      const r = await recibirTanqueta(admin, id, { calculado: 30, validado: 28, motivo: "Faltó" });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await eva.agente.get(`${base}/tanquetas/mias`)).body).toEqual([]);
      const k = await kardex(eva.agente, id);
      expect(k.status, JSON.stringify(k.body)).toBe(200);
      expect(k.body.tanqueta.cerrada).toBe(true);
      expect(k.body.salidas).toHaveLength(1);
      expect(k.body.salidas[0]).toMatchObject({
        vale,
        estado: "cerrada",
        salioCon: 30,
        volvio: 28,
        diferencia: -2,
        entroDespues: 0,
      });
      expect(k.body.salidas[0].motivo).toBe("Faltó");
      // La fila suelta del kardex sigue sin motivo; solo el cierre de salida lo lleva.
      expect(JSON.stringify(k.body.filas)).not.toContain("Faltó");
      const cerradas = await eva.agente.get(`${base}/tanquetas/mias/cerradas`);
      expect(cerradas.status).toBe(200);
      expect(cerradas.body).toHaveLength(1);
      expect(cerradas.body[0]).toMatchObject({ id, salidas: [{ vale }] });
    });

    it("quien nunca tuvo la tanqueta no la ve: ni el kardex ni las cerradas", async () => {
      const hugo = await conductorConUnidad("Hugo Ajeno");
      const ivan = await conductorConUnidad("Ivan Dueño");
      const { id } = await tanquetaDe(ivan, 40);
      expect((await kardex(hugo.agente, id)).status).toBe(404);
      expect((await hugo.agente.get(`${base}/tanquetas/mias/cerradas`)).body).toEqual([]);
    });

    it("pasa a otra unidad con un ajuste del grifero: cuadra, la fila sale sin motivo y cada salida lleva su vale", async () => {
      const fer = await conductorConUnidad("Fer Origen");
      const gus = await conductorConUnidad("Gus Destino");
      const { id, vale: valeFer } = await tanquetaDe(fer, 100);
      const cargaFer = await cargar(fer.agente, id, fer, 20);
      expect(cargaFer.status, JSON.stringify(cargaFer.body)).toBe(201);
      const valeGus = nVale++;
      const pasa = await recibirTanqueta(admin, id, {
        destino: "unidad",
        calculado: 80,
        validado: 77,
        motivo: "Faltó llenar la cubeta",
        unidad: { equipo_id: gus.equipo, serie_talonario: "ASG", n_vale: valeGus },
      });
      expect(pasa.status, JSON.stringify(pasa.body)).toBe(201);
      const cargaGus = await cargar(gus.agente, id, gus, 7);
      expect(cargaGus.status, JSON.stringify(cargaGus.body)).toBe(201);

      // Cada uno ve SOLO su salida; el saldo de cada fila es el real de la tanqueta.
      expect(await saldoEnElPanel(id)).toBe(70);
      const deFerK = await kardex(fer.agente, id);
      expect(deFerK.status, JSON.stringify(deFerK.body)).toBe(200);
      expect(deFerK.body.tanqueta.cerrada).toBe(true);
      const ajuste = deFerK.body.filas.find((f: { tipo: string }) => f.tipo === "retorno");
      expect(ajuste).toMatchObject({ sale: 3, entra: 0, unidad: fer.placa });
      expect(JSON.stringify(deFerK.body.filas)).not.toContain("Faltó llenar la cubeta");
      expect(deFerK.body.salidas[0].motivo).toBe("Faltó llenar la cubeta");
      expect(JSON.stringify(deFerK.body)).not.toContain("Gus");
      expect(
        deFerK.body.filas.some(
          (f: { clave: string }) => f.clave === `carga_ruta-${cargaGus.body.id}`
        )
      ).toBe(false);
      expect(
        deFerK.body.filas.find(
          (f: { clave: string }) => f.clave === `carga_ruta-${cargaFer.body.id}`
        ).vale
      ).toBe(valeFer);
      expect(deFerK.body.salidas).toHaveLength(1);
      expect(deFerK.body.salidas[0]).toMatchObject({
        vale: valeFer,
        salioCon: 100,
        cargo: 20,
        volvio: 77,
        diferencia: -3,
        destinoDelRetorno: "reserva",
      });

      const r = await kardex(gus.agente, id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect([r.body.cuadra, r.body.saldoFinal]).toEqual([true, 70]);
      expect(r.body.tanqueta.cerrada).toBe(false);
      // De Fer no ve nada: ni su carga, ni su nombre, ni el ajuste que el grifero le hizo a él.
      expect(
        r.body.filas.some((f: { clave: string }) => f.clave === `carga_ruta-${cargaFer.body.id}`)
      ).toBe(false);
      expect(r.body.filas.some((f: { tipo: string }) => f.tipo === "retorno")).toBe(false);
      expect(JSON.stringify(r.body)).not.toContain("Fer");
      // El motivo del ajuste de Fer es de la salida de Fer: Gus no lo ve.
      expect(JSON.stringify(r.body)).not.toContain("Faltó llenar la cubeta");
      const valeDe = (clave: string) =>
        r.body.filas.find((f: { clave: string }) => f.clave === clave).vale;
      expect(valeDe(`carga_ruta-${cargaGus.body.id}`)).toBe(`ASG-${valeGus}`);
      expect(r.body.salidas).toHaveLength(1);
      expect(r.body.desdeSalidaActual).toBe(
        r.body.filas.find(
          (f: { vale: string; tipo: string }) =>
            f.tipo === "asignacion" && f.vale === `ASG-${valeGus}`
        ).fecha
      );

      // El listado de cada conductor dice lo mismo que el kardex.
      const deFer = await fer.agente.get(`${base}/despachos?origen=tanqueta`);
      const deGus = await gus.agente.get(`${base}/despachos?origen=tanqueta`);
      expect(deFer.body.data[0].vale_salida).toBe(valeFer);
      expect(deGus.body.data[0].vale_salida).toBe(`ASG-${valeGus}`);
    });
  });
});
