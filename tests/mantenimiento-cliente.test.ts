/** tests/mantenimiento-cliente.test.ts
 *
 * La lógica del cliente del ecosistema «Gestión de mantenimiento» (sin React): quién lo ve, sus direcciones y
 * cómo se filtra y se escribe la lista de Equipos.
 */
import { describe, it, expect } from "vitest";

import { repartoPorArea } from "../client/src/components/mantenimiento/centroDeMantenimiento";
import {
  FILTROS_VACIOS,
  SIN_AREA,
  TODAS_LAS_AREAS,
  areasDeLosEquipos,
  filtrarEquipos,
  lecturaConUnidad,
} from "../client/src/components/mantenimiento/equiposMantenimiento";
import {
  leerFilasDeLaPlanilla,
  mensajeDeImportacion,
} from "../client/src/components/mantenimiento/importarEquipos";
import {
  cuerpoDelEquipo,
  formularioInicial,
  leerLectura,
  problemaDelMotivo,
  problemasDelEquipo,
} from "../client/src/components/mantenimiento/formularioEquipo";
import { puedeVerMantenimiento } from "../client/src/components/mantenimiento/mantenimientoAcceso";
import type { EquipoMantenimiento } from "../client/src/components/mantenimiento/mantenimientoApi";
import {
  esRutaDeMantenimiento,
  leerRuta,
  rutaDe,
  tituloDeRuta,
} from "../client/src/components/mantenimiento/rutaMantenimiento";

const equipo = (extra: Partial<EquipoMantenimiento>): EquipoMantenimiento => ({
  id: 1,
  placa_codigo: "AKM-739",
  tipo: "Volquete",
  marca: "VOLVO",
  modelo: null,
  medidor: "horometro",
  lectura: 4890,
  propiedad: "propia",
  area_id: 1,
  area: "Cantera",
  por_completar: false,
  ...extra,
});
const EQUIPOS = [
  equipo({}),
  equipo({ id: 2, placa_codigo: "REX-002", tipo: "Retroexcavadora", marca: "SANY" }),
  equipo({
    id: 3,
    placa_codigo: "CEB-860",
    tipo: "Camioneta",
    marca: "TOYOTA",
    medidor: "odometro",
    lectura: 48300,
    area_id: null,
    area: null,
  }),
  equipo({ id: 4, placa_codigo: "HRN-001", tipo: "Horno", area_id: 2, area: "Planta de hornos" }),
];

describe("puedeVerMantenimiento", () => {
  it("lo ve quien tiene el módulo propio, y nadie más", () => {
    expect(puedeVerMantenimiento({ modulosPermitidos: ["mantenimiento"] })).toBe(true);
    expect(puedeVerMantenimiento({ modulosPermitidos: ["combustible"] })).toBe(false);
    // Autonomía: Checklists y Órdenes de trabajo son módulos aparte y no abren el ecosistema.
    expect(puedeVerMantenimiento({ modulosPermitidos: ["checklists", "ordenes_trabajo"] })).toBe(
      false
    );
    expect(puedeVerMantenimiento(null)).toBe(false);
    expect(puedeVerMantenimiento(undefined)).toBe(false);
  });
});

describe("direcciones del ecosistema", () => {
  it("reconoce /mantenimiento y lo que cuelga de él, no /mantenimientoX", () => {
    expect(esRutaDeMantenimiento("/mantenimiento")).toBe(true);
    expect(esRutaDeMantenimiento("/mantenimiento/equipos")).toBe(true);
    expect(esRutaDeMantenimiento("/mantenimientoX")).toBe(false);
    expect(esRutaDeMantenimiento("/proveedores")).toBe(false);
  });

  it("lee la sección; lo que no se entiende cae en el Centro, nunca rompe", () => {
    expect(leerRuta("/mantenimiento")).toEqual({ seccion: "centro" });
    expect(leerRuta("/mantenimiento/equipos")).toEqual({ seccion: "equipos" });
    expect(leerRuta("/mantenimiento/EQUIPOS/")).toEqual({ seccion: "equipos" });
    expect(leerRuta("/mantenimiento/xyz")).toEqual({ seccion: "centro" });
    expect(leerRuta("/otra")).toBeNull();
  });

  it("rutaDe es la inversa de leerRuta y el título nombra la sección", () => {
    for (const seccion of ["centro", "equipos"] as const) {
      expect(leerRuta(rutaDe({ seccion }))).toEqual({ seccion });
    }
    expect(rutaDe({ seccion: "centro" })).toBe("/mantenimiento");
    expect(rutaDe({ seccion: "equipos" })).toBe("/mantenimiento/equipos");
    expect(tituloDeRuta({ seccion: "equipos" })).toBe("Equipos · Gestión de mantenimiento");
  });
});

describe("lista de equipos", () => {
  it("sin filtros trae todo", () => {
    expect(filtrarEquipos(EQUIPOS, FILTROS_VACIOS)).toHaveLength(4);
  });

  it("busca sin mirar mayúsculas ni tildes, en placa, tipo, marca y área", () => {
    const f = (busqueda: string) => filtrarEquipos(EQUIPOS, { ...FILTROS_VACIOS, busqueda });
    expect(f("sany").map((e) => e.id)).toEqual([2]);
    expect(f("  akm ").map((e) => e.id)).toEqual([1]);
    expect(f("PLANTA").map((e) => e.id)).toEqual([4]);
    expect(f("camioneta").map((e) => e.id)).toEqual([3]);
    expect(f("no existe")).toEqual([]);
  });

  it("el tipo no distingue mayúsculas: «VOLQUETE» de Flota y «Volquete» son el mismo", () => {
    const mezcla = [equipo({ id: 10, tipo: "VOLQUETE" }), equipo({ id: 11, tipo: "Volquete" })];
    expect(filtrarEquipos(mezcla, { ...FILTROS_VACIOS, tipo: "volquete" })).toHaveLength(2);
    expect(filtrarEquipos(mezcla, { ...FILTROS_VACIOS, tipo: "Camioneta" })).toHaveLength(0);
  });

  it("filtra por tipo y por área; «Sin área» trae los que no tienen", () => {
    expect(filtrarEquipos(EQUIPOS, { ...FILTROS_VACIOS, tipo: "Volquete" })).toHaveLength(1);
    expect(filtrarEquipos(EQUIPOS, { ...FILTROS_VACIOS, area: "Cantera" })).toHaveLength(2);
    expect(filtrarEquipos(EQUIPOS, { ...FILTROS_VACIOS, area: SIN_AREA }).map((e) => e.id)).toEqual(
      [3]
    );
    // Los filtros se combinan.
    expect(
      filtrarEquipos(EQUIPOS, { busqueda: "rex", tipo: "Retroexcavadora", area: "Cantera" })
    ).toHaveLength(1);
    expect(filtrarEquipos(EQUIPOS, { busqueda: "", tipo: "Horno", area: "Cantera" })).toEqual([]);
  });

  it("las áreas ofrecidas son las que tienen equipos, ordenadas, y «Sin área» al final si hace falta", () => {
    expect(areasDeLosEquipos(EQUIPOS)).toEqual(["Cantera", "Planta de hornos", SIN_AREA]);
    expect(areasDeLosEquipos([EQUIPOS[0]])).toEqual(["Cantera"]);
    expect(areasDeLosEquipos([])).toEqual([]);
    expect(TODAS_LAS_AREAS).toBe("Todas las áreas");
  });

  it("escribe la lectura con su unidad", () => {
    expect(lecturaConUnidad(EQUIPOS[0])).toBe("4,890 h");
    expect(lecturaConUnidad(EQUIPOS[2])).toBe("48,300 km");
    expect(lecturaConUnidad(equipo({ lectura: 12.5 }))).toBe("12.5 h");
  });
});

describe("formulario de equipos", () => {
  it("lee la lectura con coma decimal, coma de miles o punto; lo demás no es un número", () => {
    expect(leerLectura("3250.5")).toBe(3250.5);
    expect(leerLectura("12,5")).toBe(12.5);
    expect(leerLectura("1,234.5")).toBe(1234.5);
    expect(leerLectura("48,300")).toBe(48300);
    expect(leerLectura("  ")).toBe(0);
    expect(leerLectura("0")).toBe(0);
    expect(Number.isNaN(leerLectura("abc"))).toBe(true);
    expect(Number.isNaN(leerLectura("-5"))).toBe(true);
    expect(Number.isNaN(leerLectura("1.2.3"))).toBe(true);
  });

  it("al registrar parte vacío: horómetro, propia y sin área; al editar, con lo que ya tiene", () => {
    expect(formularioInicial()).toEqual({
      placa: "",
      tipo: "",
      marca: "",
      modelo: "",
      medidor: "horometro",
      lectura: "0",
      propiedad: "propia",
      area: "",
    });
    const f = formularioInicial(EQUIPOS[2]);
    expect(f).toMatchObject({ placa: "CEB-860", medidor: "odometro", lectura: "48300", area: "" });
    expect(formularioInicial(EQUIPOS[0]).area).toBe("1");
  });

  it("no deja guardar sin placa ni tipo, ni con una lectura que no es número", () => {
    const base = { ...formularioInicial(), placa: "AKM-739", tipo: "Volquete" };
    expect(problemasDelEquipo(base)).toEqual([]);
    expect(problemasDelEquipo({ ...base, placa: "  " })[0]).toMatch(/placa o el código/);
    expect(problemasDelEquipo({ ...base, tipo: "" })[0]).toMatch(/tipo de equipo/);
    expect(problemasDelEquipo({ ...base, lectura: "abc" })[0]).toMatch(
      /lectura debe ser un número/
    );
    expect(problemasDelEquipo({ ...base, lectura: "99999999" })[0]).toMatch(/demasiado grande/);
    expect(problemasDelEquipo(formularioInicial())).toHaveLength(2);
  });

  it("el cuerpo recorta espacios, convierte la lectura y manda el área como número o null", () => {
    expect(
      cuerpoDelEquipo({
        placa: " AKM-739 ",
        tipo: " Volquete ",
        marca: " VOLVO ",
        modelo: "",
        medidor: "odometro",
        lectura: "1,234.5",
        propiedad: "alquilada",
        area: "7",
      })
    ).toEqual({
      placa_codigo: "AKM-739",
      tipo: "Volquete",
      marca: "VOLVO",
      modelo: "",
      medidor: "odometro",
      lectura: 1234.5,
      propiedad: "alquilada",
      area_id: 7,
    });
    expect(cuerpoDelEquipo({ ...formularioInicial(), area: "" }).area_id).toBeNull();
  });

  it("quitar un equipo pide un motivo de al menos 3 letras y con tope", () => {
    expect(problemaDelMotivo("")).toMatch(/al menos 3 letras/);
    expect(problemaDelMotivo(" ab ")).toMatch(/al menos 3 letras/);
    expect(problemaDelMotivo("Se vendió")).toBeNull();
    expect(problemaDelMotivo("x".repeat(301))).toMatch(/no puede pasar de 300/);
  });
});

describe("importar equipos desde Excel", () => {
  const ENCABEZADO = [
    "Placa",
    "Tipo",
    "Marca",
    "Modelo",
    "Medidor",
    "Lectura",
    "Propiedad",
    "Área",
  ];

  it("lee las filas con sus columnas y deja las celdas vacías en sus valores por defecto", () => {
    const filas = leerFilasDeLaPlanilla([
      ENCABEZADO,
      [" AKM-739 ", "Volquete", "VOLVO", "FH", "Horómetro", 4890.5, "Propia", "Cantera"],
      ["CEB-860", "Camioneta", "", "", "km", "48,300", "alquilada", ""],
      ["REX-002", "Retroexcavadora"],
    ]);
    expect(filas).toEqual([
      {
        placa_codigo: "AKM-739",
        tipo: "Volquete",
        marca: "VOLVO",
        modelo: "FH",
        medidor: "horometro",
        lectura: 4890.5,
        propiedad: "propia",
        area: "Cantera",
      },
      {
        placa_codigo: "CEB-860",
        tipo: "Camioneta",
        marca: "",
        modelo: "",
        medidor: "odometro",
        lectura: 48300,
        propiedad: "alquilada",
        area: "",
      },
      {
        placa_codigo: "REX-002",
        tipo: "Retroexcavadora",
        marca: "",
        modelo: "",
        medidor: "horometro",
        lectura: 0,
        propiedad: "propia",
        area: "",
      },
    ]);
  });

  it("entiende los encabezados con o sin tildes, mayúsculas o nombres parecidos", () => {
    const filas = leerFilasDeLaPlanilla([
      ["CÓDIGO", "TIPO DE EQUIPO", "area", "Lectura actual"],
      ["T-1", "Volquete", "Taller", 10],
    ]);
    expect(filas[0]).toMatchObject({
      placa_codigo: "T-1",
      tipo: "Volquete",
      area: "Taller",
      lectura: 10,
    });
  });

  it("ignora las filas vacías y cuenta las filas como el Excel (el encabezado es la 1)", () => {
    const filas = leerFilasDeLaPlanilla([ENCABEZADO, [], ["", "", ""], ["A-1", "Volquete"]]);
    expect(filas).toHaveLength(1);
    expect(() =>
      leerFilasDeLaPlanilla([
        ENCABEZADO,
        ["A-1", "Volquete"],
        ["", "", ""],
        ["A-2", "Volquete", "", "", "", "abc"],
      ])
    ).toThrow("Fila 4: la lectura «abc» no es un número.");
  });

  it("dice qué falta si no hay encabezados con Placa y Tipo", () => {
    expect(() =>
      leerFilasDeLaPlanilla([
        ["Nombre", "Edad"],
        ["x", 1],
      ])
    ).toThrow(/Placa y Tipo son obligatorias/);
    expect(leerFilasDeLaPlanilla([])).toEqual([]);
  });

  it("rechaza con su fila un medidor o una propiedad que no entiende", () => {
    expect(() => leerFilasDeLaPlanilla([ENCABEZADO, ["A", "T", "", "", "pies"]])).toThrow(
      "Fila 2: el medidor «pies» no se entiende. Escribe Horómetro u Odómetro."
    );
    expect(() =>
      leerFilasDeLaPlanilla([ENCABEZADO, ["A", "T", "", "", "", 1, "prestada"]])
    ).toThrow("Fila 2: la propiedad «prestada» no se entiende. Escribe Propia o Alquilada.");
    expect(() => leerFilasDeLaPlanilla([ENCABEZADO, ["A", "T", "", "", "", -4]])).toThrow(
      /lectura «-4» no es un número/
    );
  });

  it("el mensaje de éxito dice cuántos entraron y qué áreas se crearon", () => {
    expect(mensajeDeImportacion({ importados: 1, areasCreadas: [] })).toBe(
      "Se importó 1 equipo correctamente."
    );
    expect(mensajeDeImportacion({ importados: 3, areasCreadas: [] })).toBe(
      "Se importaron 3 equipos correctamente."
    );
    expect(mensajeDeImportacion({ importados: 3, areasCreadas: ["Cantra"] })).toContain(
      "Se crearon el área Cantra"
    );
    expect(mensajeDeImportacion({ importados: 3, areasCreadas: ["A", "B"] })).toContain(
      "las áreas A, B"
    );
  });
});

describe("Centro: reparto de equipos por área", () => {
  it("ordena de más a menos, omite las áreas vacías y suma «Sin área»", () => {
    const reparto = repartoPorArea({
      areas: [
        { id: 1, nombre: "Taller", equipos: 1 },
        { id: 2, nombre: "Cantera", equipos: 4 },
        { id: 3, nombre: "Vacía", equipos: 0 },
      ],
      sin_area: 2,
    });
    expect(reparto).toEqual([
      { nombre: "Cantera", equipos: 4, porcentaje: 100 },
      { nombre: "Sin área", equipos: 2, porcentaje: 50 },
      { nombre: "Taller", equipos: 1, porcentaje: 25 },
    ]);
  });

  it("sin equipos no reparte nada, y sin «sin área» no la dibuja", () => {
    expect(repartoPorArea({ areas: [], sin_area: 0 })).toEqual([]);
    expect(
      repartoPorArea({ areas: [{ id: 1, nombre: "Taller", equipos: 2 }], sin_area: 0 })
    ).toEqual([{ nombre: "Taller", equipos: 2, porcentaje: 100 }]);
  });
});
