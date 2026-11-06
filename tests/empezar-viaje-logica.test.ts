/** tests/empezar-viaje-logica.test.ts
 *
 * La lógica pura de «Empezar un viaje» (0179), la que usa el celular del conductor: la unidad
 * asignada viene marcada con su ruta, la unidad nueva no tiene ruta, las validaciones de cada
 * paso y el cuerpo que se manda a crear-mio. Es lógica del cliente (empezarViaje.ts) y se prueba
 * acá, igual que alertas-viaje-texto.
 */
import { describe, it, expect } from "vitest";

import {
  borradorInicial,
  buscarRelevos,
  buscarUnidades,
  conRutaDeUnidad,
  cuerpoCrearMiViaje,
  errorDelPaso,
  errorOdometro,
  errorRuta,
  errorUnidad,
  nombreDeLugar,
  nombreDeRelevoNuevo,
  paradasFinales,
  type BorradorViaje,
  type CatalogoViaje,
} from "../client/src/components/combustible/empezarViaje";

const catalogo: CatalogoViaje = {
  puede_crear_viaje: true,
  lugares: [
    { id: 1, nombre: "Trujillo" },
    { id: 2, nombre: "Picota" },
    { id: 3, nombre: "Arequipa" },
  ],
  unidades: [
    {
      id: 10,
      placa: "TAF-822",
      tipo: "Tráiler",
      tipo_medidor: null,
      por_completar: false,
      asignada_a_mi: true,
      ruta: { origen_id: 1, destino_id: 2, origen: "Trujillo", destino: "Picota" },
    },
    {
      id: 11,
      placa: "REX-001",
      tipo: "Camión",
      tipo_medidor: null,
      por_completar: false,
      asignada_a_mi: false,
      ruta: null,
    },
  ],
  relevos: [{ id: "u-1", nombre: "Luis Ramos", con_cuenta: true }],
};
const nuevo = (extra: Partial<BorradorViaje> = {}) => ({
  ...borradorInicial(catalogo, "Juan Constante"),
  ...extra,
});

describe("empezar un viaje: lógica del celular", () => {
  it("con unidad asignada, viene marcada y con su ruta de Equipos", () => {
    const b = nuevo();
    expect(b.unidad).toBe(10);
    expect([b.sale, b.llega]).toEqual([1, 2]);
    expect(errorUnidad(b, catalogo)).toBe("");
  });

  it("sin unidad asignada hay que elegir una, y cambiarla trae la ruta de la nueva", () => {
    const sin: CatalogoViaje = {
      ...catalogo,
      unidades: catalogo.unidades.map((u) => ({ ...u, asignada_a_mi: false })),
    };
    const b = borradorInicial(sin, "Juan");
    expect(b.unidad).toBeNull();
    expect(errorUnidad(b, sin)).toBe("Elige tu unidad.");
    // Una unidad sin ruta deja los lugares vacíos: hay que elegirlos.
    const conOtra = conRutaDeUnidad({ ...b, unidad: 11 }, sin.unidades[1]);
    expect([conOtra.sale, conOtra.llega]).toEqual([null, null]);
    expect(errorRuta(conOtra)).toBe("Falta elegir algún lugar.");
  });

  it("unidad nueva: placa válida, que no exista (aunque cambie guion) y nombre completo", () => {
    const base = nuevo({ unidad: "nueva", placa: "", nombre: "Juan Constante" });
    expect(errorUnidad(base, catalogo)).toMatch(/placa/);
    expect(errorUnidad({ ...base, placa: "ab" }, catalogo)).toMatch(/placa/);
    expect(errorUnidad({ ...base, placa: "taf 822" }, catalogo)).toMatch(/ya está registrada/);
    expect(errorUnidad({ ...base, placa: "ABC-123", nombre: "Ju" }, catalogo)).toMatch(/nombre/);
    expect(errorUnidad({ ...base, placa: "ABC-123" }, catalogo)).toBe("");
  });

  it("el recorrido según el tipo: ida, ida y vuelta (vuelve al punto de salida) y varias paradas", () => {
    expect(paradasFinales(nuevo({ tipo: "ida" }))).toEqual([1, 2]);
    expect(paradasFinales(nuevo({ tipo: "ida_vuelta" }))).toEqual([1, 2, 1]);
    expect(paradasFinales(nuevo({ tipo: "varias", paradas: [1, 2, 3, 1] }))).toEqual([1, 2, 3, 1]);
  });

  it("la ruta rechaza lugares faltantes y dos lugares seguidos iguales", () => {
    expect(errorRuta(nuevo({ sale: null }))).toBe("Falta elegir algún lugar.");
    expect(errorRuta(nuevo({ sale: 2, llega: 2 }))).toMatch(/distintos/);
    expect(errorRuta(nuevo({ tipo: "varias", paradas: [1, 2, 2] }))).toMatch(/distintos/);
    expect(errorRuta(nuevo({ tipo: "varias", paradas: [1, 2, null] }))).toBe(
      "Falta elegir algún lugar."
    );
    expect(errorRuta(nuevo({ tipo: "varias", paradas: [1, 2, 1] }))).toBe("");
  });

  it("un lugar escrito a mano vale como lugar: se compara por nombre y viaja como { nombre }", () => {
    expect(nombreDeLugar(1, catalogo)).toBe("Trujillo");
    expect(nombreDeLugar(" Chepén ", catalogo)).toBe("Chepén");
    expect(nombreDeLugar(null, catalogo)).toBe("");
    // Escrito a mano, sin importar mayúsculas, es el mismo lugar que uno del catálogo.
    expect(errorRuta(nuevo({ sale: 1, llega: "trujillo" }), catalogo)).toMatch(/distintos/);
    expect(errorRuta(nuevo({ sale: 1, llega: "Chepén" }), catalogo)).toBe("");
    expect(errorRuta(nuevo({ sale: 1, llega: "  " }), catalogo)).toBe("Falta elegir algún lugar.");
    const cuerpo = cuerpoCrearMiViaje(
      nuevo({ odometro: "1", tipo: "ida", sale: 1, llega: " Chepén " }),
      "u",
      "t"
    );
    expect(cuerpo.paradas).toEqual([1, { nombre: "Chepén" }]);
  });

  it("el odómetro de salida es obligatorio y acepta coma decimal", () => {
    expect(errorOdometro(nuevo({ odometro: "" }))).toMatch(/odómetro/);
    expect(errorOdometro(nuevo({ odometro: "abc" }))).toMatch(/odómetro/);
    expect(errorOdometro(nuevo({ odometro: "148 230,5" }))).toBe("");
    expect(errorDelPaso("confirmar", nuevo({ odometro: "" }), catalogo)).toMatch(/odómetro/);
    expect(errorDelPaso("tipo", nuevo(), catalogo)).toBe("");
  });

  it("el buscador no muestra la flota entera: pide 2 letras, tope de 6 y no repite la asignada", () => {
    const muchas: CatalogoViaje = {
      ...catalogo,
      unidades: [
        ...catalogo.unidades,
        ...Array.from({ length: 20 }, (_, n) => ({
          id: 100 + n,
          placa: `ABC-${100 + n}`,
          tipo: "Volquete",
          tipo_medidor: null,
          por_completar: false,
          asignada_a_mi: false,
          ruta: null,
        })),
      ],
    };
    expect(buscarUnidades(muchas, "")).toEqual([]);
    expect(buscarUnidades(muchas, "a")).toEqual([]);
    expect(buscarUnidades(muchas, "abc")).toHaveLength(6);
    expect(buscarUnidades(muchas, "abc", 3)).toHaveLength(3);
    // Sin guion ni mayúsculas, y la asignada (TAF-822) no aparece entre los resultados.
    expect(buscarUnidades(muchas, "rex 00").map((u) => u.placa)).toEqual(["REX-001"]);
    expect(buscarUnidades(muchas, "taf")).toEqual([]);
  });

  it("el relevo se busca por nombre (sin tildes), con tope, y un nombre nuevo se puede anotar", () => {
    const c: CatalogoViaje = {
      ...catalogo,
      relevos: [
        { id: "u-1", nombre: "Luis Ramos Vega", con_cuenta: true },
        { id: "u-2", nombre: "Carmen Quispe Flores", con_cuenta: true },
        { id: "u-3", nombre: "Luisa Pérez", con_cuenta: true },
        // Solo figura en Equipos: también se encuentra, aunque no tenga cuenta.
        { id: "eq:9", nombre: "Jhuver Nicolas Julca Reyes", con_cuenta: false },
      ],
    };
    expect(buscarRelevos(c, "l")).toEqual([]);
    expect(buscarRelevos(c, "luis").map((r) => r.id)).toEqual(["u-1", "u-3"]);
    expect(buscarRelevos(c, "perez").map((r) => r.id)).toEqual(["u-3"]);
    expect(buscarRelevos(c, "luis", 1)).toHaveLength(1);
    // Sin importar mayúsculas ni tildes, y también a un conductor que solo está en Equipos.
    expect(buscarRelevos(c, "NICOLAS").map((r) => r.id)).toEqual(["eq:9"]);
    expect(buscarRelevos(c, "nicolás").map((r) => r.id)).toEqual(["eq:9"]);
    // Un nombre que no es de ningún registrado se puede anotar; uno que ya existe, no.
    expect(nombreDeRelevoNuevo(c, "Pedro Soto")).toBe(true);
    expect(nombreDeRelevoNuevo(c, "pe")).toBe(false);
    expect(nombreDeRelevoNuevo(c, "carmen quispe flores")).toBe(false);
  });

  it("el cuerpo lleva al relevo registrado por su id, o solo el nombre si no tiene cuenta", () => {
    const base = { odometro: "1" };
    expect(cuerpoCrearMiViaje(nuevo({ ...base, relevoId: "u-1" }), "u", "t")).toMatchObject({
      relevo_usuario_id: "u-1",
    });
    const sin = cuerpoCrearMiViaje(nuevo({ ...base, relevoNombre: " Pedro Soto " }), "u", "t");
    expect(sin).toMatchObject({ relevo_nombre: "Pedro Soto" });
    expect("relevo_usuario_id" in sin).toBe(false);
    // Con uno registrado, el nombre suelto no viaja.
    const ambos = cuerpoCrearMiViaje(
      nuevo({ ...base, relevoId: "u-1", relevoNombre: "X" }),
      "u",
      "t"
    );
    expect("relevo_nombre" in ambos).toBe(false);
  });

  it("el motivo solo viaja si eligió una unidad registrada distinta a la asignada", () => {
    const cuerpo = (extra: Partial<BorradorViaje>) =>
      cuerpoCrearMiViaje(
        nuevo({ odometro: "1", motivoUnidad: " en taller ", ...extra }),
        "u",
        "t",
        10
      );
    expect(cuerpo({ unidad: 11 })).toMatchObject({ motivo_unidad: "en taller" });
    expect("motivo_unidad" in cuerpo({ unidad: 10 })).toBe(false);
    expect("motivo_unidad" in cuerpo({ unidad: 11, motivoUnidad: "  " })).toBe(false);
    expect("motivo_unidad" in cuerpo({ unidad: "nueva", placa: "ABC-123" })).toBe(false);
  });

  it("el cuerpo de crear-mio: unidad registrada o nueva, relevo por id y el mismo id_cliente", () => {
    const reg = cuerpoCrearMiViaje(
      nuevo({ odometro: "1000", relevoId: "u-1" }),
      "uuid-1",
      "2026-11-06T10:00:00.000Z"
    );
    expect(reg).toEqual({
      id_cliente: "uuid-1",
      // La cola sin señal lee `cliente_uuid`: es el mismo identificador.
      cliente_uuid: "uuid-1",
      marcado_en: "2026-11-06T10:00:00.000Z",
      equipo_id: 10,
      paradas: [1, 2],
      relevo_usuario_id: "u-1",
      medidor_inicio: 1000,
    });
    const nva = cuerpoCrearMiViaje(
      nuevo({ unidad: "nueva", placa: " abc-123 ", odometro: "5", tipo: "ida_vuelta" }),
      "uuid-2",
      "2026-11-06T10:00:00.000Z"
    );
    expect(nva).toEqual({
      id_cliente: "uuid-2",
      cliente_uuid: "uuid-2",
      marcado_en: "2026-11-06T10:00:00.000Z",
      unidad_nueva: { placa: "ABC-123", nombre: "Juan Constante" },
      paradas: [1, 2, 1],
      medidor_inicio: 5,
    });
    expect("equipo_id" in nva).toBe(false);
    expect("relevo_usuario_id" in nva).toBe(false);
  });
});
