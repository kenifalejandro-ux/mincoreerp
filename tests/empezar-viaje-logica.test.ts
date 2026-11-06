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
  conRutaDeUnidad,
  cuerpoCrearMiViaje,
  errorDelPaso,
  errorOdometro,
  errorRuta,
  errorUnidad,
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
      por_completar: false,
      asignada_a_mi: true,
      ruta: { origen_id: 1, destino_id: 2, origen: "Trujillo", destino: "Picota" },
    },
    {
      id: 11,
      placa: "REX-001",
      tipo: "Camión",
      por_completar: false,
      asignada_a_mi: false,
      ruta: null,
    },
  ],
  relevos: [{ id: "u-1", nombre: "Luis Ramos" }],
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

  it("el odómetro de salida es obligatorio y acepta coma decimal", () => {
    expect(errorOdometro(nuevo({ odometro: "" }))).toMatch(/odómetro/);
    expect(errorOdometro(nuevo({ odometro: "abc" }))).toMatch(/odómetro/);
    expect(errorOdometro(nuevo({ odometro: "148 230,5" }))).toBe("");
    expect(errorDelPaso("confirmar", nuevo({ odometro: "" }), catalogo)).toMatch(/odómetro/);
    expect(errorDelPaso("tipo", nuevo(), catalogo)).toBe("");
  });

  it("el cuerpo de crear-mio: unidad registrada o nueva, relevo por id y el mismo id_cliente", () => {
    const reg = cuerpoCrearMiViaje(nuevo({ odometro: "1000", relevoId: "u-1" }), "uuid-1");
    expect(reg).toEqual({
      id_cliente: "uuid-1",
      equipo_id: 10,
      paradas: [1, 2],
      relevo_usuario_id: "u-1",
      medidor_inicio: 1000,
    });
    const nva = cuerpoCrearMiViaje(
      nuevo({ unidad: "nueva", placa: " abc-123 ", odometro: "5", tipo: "ida_vuelta" }),
      "uuid-2"
    );
    expect(nva).toEqual({
      id_cliente: "uuid-2",
      unidad_nueva: { placa: "ABC-123", nombre: "Juan Constante" },
      paradas: [1, 2, 1],
      medidor_inicio: 5,
    });
    expect("equipo_id" in nva).toBe(false);
    expect("relevo_usuario_id" in nva).toBe(false);
  });
});
