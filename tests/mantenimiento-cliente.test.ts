/** tests/mantenimiento-cliente.test.ts
 *
 * La lógica del cliente del ecosistema «Gestión de mantenimiento» (sin React): quién lo ve, sus direcciones y
 * cómo se filtra y se escribe la lista de Equipos.
 */
import { describe, it, expect } from "vitest";

import { cuandoFue, pasoDelTurno } from "../client/src/components/mantenimiento/actividadDelTurno";
import {
  MAXIMO_DE_BARRAS,
  anilloDeOrdenes,
  avisosDelCentro,
  barrasDeArea,
  fechaLarga,
  notaDeEstados,
  porcentaje,
  resumenDeArea,
  saludoSegunHora,
  tonoDeArea,
} from "../client/src/components/mantenimiento/centroDeMantenimiento";
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
import {
  METAS,
  REGLAS,
  avisoDeRegla,
  leerMeta,
} from "../client/src/components/mantenimiento/configMantenimiento";
import { puedeVerMantenimiento } from "../client/src/components/mantenimiento/mantenimientoAcceso";
import {
  esSeccion,
  gruposDelMenu,
  insigniaDe,
  modulosIntegrados,
} from "../client/src/components/mantenimiento/menuMantenimiento";
import {
  etiquetaDelPerfil,
  inicialesDe,
} from "../client/src/components/mantenimiento/perfilMantenimiento";
import type {
  EquipoMantenimiento,
  ResumenMantenimiento,
  UnidadDelCentro,
} from "../client/src/components/mantenimiento/mantenimientoApi";
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
      filtrarEquipos(EQUIPOS, {
        ...FILTROS_VACIOS,
        busqueda: "rex",
        tipo: "Retroexcavadora",
        area: "Cantera",
      })
    ).toHaveLength(1);
    expect(filtrarEquipos(EQUIPOS, { ...FILTROS_VACIOS, tipo: "Horno", area: "Cantera" })).toEqual(
      []
    );
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

const unidad = (extra: Partial<UnidadDelCentro> = {}): UnidadDelCentro => ({
  id: 1,
  placa: "AKM-739",
  estado: "operativa",
  alquilada: false,
  ...extra,
});
const nada = { total: 0, casos: [] };
/** Un resumen sin nada pendiente y sin los módulos vecinos. */
const centro = (
  extra: Partial<ResumenMantenimiento> = {}
): Parameters<typeof avisosDelCentro>[0] => ({
  sin_area: 0,
  por_importar: 0,
  ordenes: null,
  checklists: null,
  ...extra,
});

describe("Centro: cifras y estado por área", () => {
  it("el porcentaje de nada es 0 y las notas dicen cuando no hay nada", () => {
    expect(porcentaje(0, 0)).toBe(0);
    expect(porcentaje(2, 3)).toBe(67);
    expect(notaDeEstados({ operativas: 3, detenidas: 0, en_mantenimiento: 0 })).toBe(
      "Ninguna detenida ni en mantenimiento"
    );
    expect(notaDeEstados({ operativas: 6, detenidas: 1, en_mantenimiento: 2 })).toBe(
      "1 detenida · 2 en mantenimiento"
    );
  });

  it("el color del área sigue la meta de la empresa: cumple, a 15 puntos o menos, o más lejos", () => {
    expect(tonoDeArea(90, 90)).toBe("green");
    expect(tonoDeArea(89, 90)).toBe("amber");
    expect(tonoDeArea(75, 90)).toBe("amber");
    expect(tonoDeArea(74, 90)).toBe("red");
  });

  it("resume un área: disponibilidad, detenidos, en taller y «Sin área» para las que no tienen", () => {
    const area = resumenDeArea(
      {
        area_id: null,
        nombre: null,
        unidades: [
          unidad(),
          unidad({ id: 2, estado: "detenida" }),
          unidad({ id: 3, estado: "en_mantenimiento" }),
          unidad({ id: 4, estado: "en_mantenimiento" }),
        ],
      },
      90
    );
    expect(area).toMatchObject({
      clave: "sin_area",
      nombre: SIN_AREA,
      disponibilidad: 25,
      tono: "red",
      equipos: "4 equipos",
      detenidos: "1 detenido",
      enTaller: "2 en taller",
    });
    expect(resumenDeArea({ area_id: 7, nombre: "Taller", unidades: [unidad()] }, 90)).toMatchObject(
      { nombre: "Taller", disponibilidad: 100, detenidos: null, enTaller: null }
    );
  });

  it("una barra por unidad; la alquilada va en gris aunque esté detenida", () => {
    const barras = barrasDeArea([
      unidad(),
      unidad({ id: 2, placa: "ALQ-1", estado: "detenida", alquilada: true }),
    ]);
    expect(barras).toEqual([
      { color: "operativa", peso: 1, titulo: "AKM-739 · Operativa" },
      { color: "alquilada", peso: 1, titulo: "ALQ-1 · Detenida · Alquilada" },
    ]);
  });

  it("con muchas unidades junta las barras por color, sin perder ninguna", () => {
    const muchas = Array.from({ length: MAXIMO_DE_BARRAS + 10 }, (_, i) =>
      unidad({ id: i + 1, estado: i < 3 ? "detenida" : "operativa" })
    );
    const barras = barrasDeArea(muchas);
    expect(barras.map((b) => [b.color, b.peso])).toEqual([
      ["operativa", MAXIMO_DE_BARRAS + 7],
      ["detenida", 3],
    ]);
    expect(barras[1].titulo).toBe("3 detenidas");
  });

  it("el anillo de órdenes reparte el mes y queda gris sin ninguna", () => {
    expect(anilloDeOrdenes({ correctivo: 0, preventivo: 0 })).toEqual({
      total: 0,
      fondo: "#e2e8f0",
    });
    const anillo = anilloDeOrdenes({ correctivo: 5, preventivo: 2 });
    expect(anillo.total).toBe(7);
    expect(anillo.fondo).toContain("0 71%");
  });
});

describe("Centro: lo que requiere atención", () => {
  const ordenes = {
    abiertas: 8,
    urgentes: 1,
    del_mes: { correctivo: 0, preventivo: 0 },
    sin_mecanico: {
      total: 3,
      urgentes: 1,
      casos: [
        { id: 12, unidad: "TFS-883", titulo: "Frenos", urgente: true },
        { id: 9, unidad: null, titulo: "Faja", urgente: false },
      ],
    },
  };
  const checklists = {
    hechos_hoy: 4,
    sin_checklist_hoy: { total: 2, casos: ["AKM-739", "REX-003"] },
    no_aptos_hoy: { total: 1, casos: [{ id: 1, unidad: "TFS-883", fallas: "Frenos" }] },
    por_autorizar: { total: 1, casos: [{ id: 2, unidad: "REX-002", fallas: null }] },
  };

  it("sin los módulos vecinos solo avisa lo propio", () => {
    expect(avisosDelCentro(centro())).toEqual([]);
    const avisos = avisosDelCentro(centro({ sin_area: 1, por_importar: 2 }));
    expect(avisos.map((a) => a.id)).toEqual(["por-importar", "sin-area"]);
    expect(avisos[0].titulo).toBe("2 unidades de Operaciones por completar");
    expect(avisos[1].titulo).toBe("1 equipo sin área");
  });

  it("ordena de lo urgente a lo administrativo y manda cada aviso a su módulo", () => {
    const avisos = avisosDelCentro(centro({ ordenes, checklists, sin_area: 1 }), true);
    expect(avisos.map((a) => [a.id, a.tono, a.accion])).toEqual([
      ["sin-mecanico", "red", "Asignar"],
      ["no-aptos", "red", "Ver checklists"],
      ["por-autorizar", "amber", "Ver checklists"],
      ["sin-checklist", "amber", "Ver unidades"],
      ["sin-area", "amber", "Ver equipos"],
    ]);
    expect(avisos.map((a) => a.destino)).toEqual([
      { modulo: "ordenes_trabajo" },
      { modulo: "checklists" },
      { modulo: "checklists" },
      { seccion: "equipos" },
      { seccion: "equipos" },
    ]);
    expect(avisos[0].titulo).toBe("3 órdenes sin mecánico asignado (1 urgente)");
    expect(avisos[0].detalle).toBe("OT #12 · TFS-883 · Frenos · urgente; OT #9 · Faja y 1 más");
    expect(avisos[1].titulo).toBe("1 checklist «No apta» hoy");
    expect(avisos[2].detalle).toBe("REX-002");
    expect(avisos[3].titulo).toBe("2 unidades sin checklist hoy");
    expect(avisos[3].detalle).toBe("AKM-739, REX-003");
  });

  it("quien solo mira no recibe «Asignar», y sin urgentes el aviso es ámbar", () => {
    const [aviso] = avisosDelCentro(
      centro({
        ordenes: { ...ordenes, sin_mecanico: { ...ordenes.sin_mecanico, urgentes: 0 } },
      })
    );
    expect(aviso).toMatchObject({ accion: "Ver órdenes", tono: "amber" });
    expect(aviso.titulo).toBe("3 órdenes sin mecánico asignado");
  });

  it("un bloque sin casos no genera aviso", () => {
    expect(
      avisosDelCentro(
        centro({
          ordenes: { ...ordenes, sin_mecanico: { ...nada, urgentes: 0 } },
          checklists: {
            hechos_hoy: 0,
            sin_checklist_hoy: nada,
            no_aptos_hoy: nada,
            por_autorizar: nada,
          },
        })
      )
    ).toEqual([]);
  });
});

describe("menú del ecosistema (como la maqueta)", () => {
  const entradas = (modulos: string[]) =>
    gruposDelMenu({ modulosPermitidos: modulos }).flatMap((g) => g.entradas.map((e) => e.id));

  it("con solo Mantenimiento: Centro y Equipos abren; el resto sale como «Pronto», sin módulos ajenos", () => {
    const grupos = gruposDelMenu({ modulosPermitidos: ["mantenimiento"] });
    expect(grupos.map((g) => g.etiqueta)).toEqual(["Operación", "Seguimiento"]);
    const todas = grupos.flatMap((g) => g.entradas);
    expect(todas.filter((e) => !e.pronto).map((e) => e.id)).toEqual(["centro", "equipos"]);
    expect(entradas(["mantenimiento"])).toEqual(
      expect.arrayContaining(["preventivo", "indicadores", "historial"])
    );
    expect(entradas(["mantenimiento"])).not.toContain("checklists");
    expect(entradas(["mantenimiento"])).not.toContain("almacen");
  });

  it("las entradas de módulos vecinos solo salen si la persona los tiene", () => {
    const todo = entradas(["mantenimiento", "checklists", "ordenes_trabajo", "repuestos", "iperc"]);
    expect(todo).toEqual(expect.arrayContaining(["checklists", "ordenes", "almacen", "iperc"]));
    expect(
      gruposDelMenu({ modulosPermitidos: ["mantenimiento", "iperc"] }).map((g) => g.etiqueta)
    ).toContain("Recursos conectados");
  });

  it("solo Centro y Equipos son secciones; la insignia de Equipos cuenta las unidades por completar", () => {
    expect(esSeccion("centro")).toBe(true);
    expect(esSeccion("equipos")).toBe(true);
    expect(esSeccion("configuracion")).toBe(true);
    expect(esSeccion("checklists")).toBe(false);
    expect(insigniaDe("equipos", 3)).toBe(3);
    expect(insigniaDe("equipos", 0)).toBeNull();
    expect(insigniaDe("centro", 3)).toBeNull();
  });

  it("la integración solo cuenta lo que de verdad se comparte hoy: Flota", () => {
    expect(modulosIntegrados({ modulosPermitidos: ["mantenimiento"] })).toBe(0);
    expect(modulosIntegrados({ modulosPermitidos: ["mantenimiento", "flota"] })).toBe(1);
  });
});

describe("barra superior y Centro", () => {
  it("nombra el perfil y saca dos iniciales", () => {
    expect(etiquetaDelPerfil("admin")).toBe("Administrador");
    expect(etiquetaDelPerfil("mecanico")).toBe("Mecánico");
    expect(etiquetaDelPerfil(undefined)).toBe("");
    expect(inicialesDe("Jefe de mantenimiento")).toBe("JD");
    expect(inicialesDe("Admin")).toBe("AD");
    expect(inicialesDe("")).toBe("?");
  });

  it("el saludo sigue la hora y la fecha se escribe larga", () => {
    expect(saludoSegunHora(6)).toBe("Buenos días");
    expect(saludoSegunHora(12)).toBe("Buenas tardes");
    expect(saludoSegunHora(21)).toBe("Buenas noches");
    expect(fechaLarga(new Date(2026, 10, 24))).toContain("24");
    expect(fechaLarga(new Date(2026, 10, 24))).toContain("2026");
  });
});

describe("Configuración: reglas y metas", () => {
  it("la dirección de Configuración va y vuelve", () => {
    expect(rutaDe({ seccion: "configuracion" })).toBe("/mantenimiento/configuracion");
    expect(leerRuta("/mantenimiento/configuracion")).toEqual({ seccion: "configuracion" });
  });

  it("una meta es un entero entre 1 y su máximo; lo demás dice por qué no sirve", () => {
    const disponibilidad = METAS[0];
    expect(leerMeta(" 85 ", disponibilidad)).toEqual({ valor: 85 });
    expect(leerMeta("100", disponibilidad)).toEqual({ valor: 100 });
    for (const malo of ["", "0", "101", "-5", "92.5", "1e2", "abc"]) {
      expect(leerMeta(malo, disponibilidad), malo).toHaveProperty("error");
    }
  });

  it("cada regla pendiente avisa que aún no actúa; la que ya actúa solo nombra lo que falta", () => {
    const hallazgo = REGLAS.find((r) => r.clave === "ot_de_hallazgo")!;
    expect(avisoDeRegla(hallazgo, { modulosPermitidos: ["mantenimiento"] })).toBe(
      "Necesita los módulos Checklists y Órdenes de Trabajo."
    );
    expect(avisoDeRegla(hallazgo, { modulosPermitidos: ["checklists", "ordenes_trabajo"] })).toBe(
      ""
    );
    expect(avisoDeRegla(hallazgo, { modulosPermitidos: ["checklists"] })).toBe(
      "Necesita el módulo Órdenes de Trabajo."
    );
    for (const regla of REGLAS.filter((r) => r !== hallazgo)) {
      expect(avisoDeRegla(regla, { modulosPermitidos: [] }), regla.clave).toMatch(
        /^Aún no actúa: llega con .+\. Necesita /
      );
    }
    expect(REGLAS).toHaveLength(4);
    expect(METAS).toHaveLength(4);
  });
});

describe("Centro: actividad del turno", () => {
  const orden = {
    en: "2026-11-25T15:00:00Z",
    unidad: "TFS-883",
    tipo: "orden_creada",
    orden_id: 7,
    titulo: "Frenos",
    estado: "abierta",
    detiene: true,
    sin_mecanico: true,
    desde_checklist: true,
    unidad_hoy: "detenida",
  } as const;
  const checklist = {
    en: "2026-11-25T15:00:00Z",
    unidad: "TFS-883",
    tipo: "checklist",
    checklist_id: 3,
    resultado: "no_apta",
    fallas: "Frenos",
    por_autorizar: false,
    orden: { id: 7, nueva: true },
  } as const;

  it("dice la hora de Perú: hoy, ayer o la fecha", () => {
    const ahora = new Date("2026-11-25T17:00:00Z");
    expect(cuandoFue("2026-11-25T10:40:00Z", ahora)).toBe("Hoy 05:40");
    // 20:00 de ayer en Perú, aunque en UTC ya sea hoy.
    expect(cuandoFue("2026-11-25T01:00:00Z", ahora)).toBe("Ayer 20:00");
    expect(cuandoFue("2026-11-22T16:20:00Z", ahora)).toBe("22/11 11:20");
  });

  it("el checklist cuenta qué pasó con su falla", () => {
    expect(pasoDelTurno(checklist)).toMatchObject({
      tono: "red",
      detalle: "TFS-883 · Frenos",
      efecto: "Generó la OT #7",
    });
    expect(pasoDelTurno({ ...checklist, orden: { id: 7, nueva: false } }).efecto).toContain(
      "ya existía"
    );
    expect(pasoDelTurno({ ...checklist, orden: null }).efecto).toBe("La unidad no puede salir");
    expect(
      pasoDelTurno({ ...checklist, resultado: "observado", orden: null, por_autorizar: true })
        .efecto
    ).toBe("Espera autorización para salir");
  });

  it("la orden cuenta cómo está hoy", () => {
    expect(pasoDelTurno(orden)).toMatchObject({
      titulo: "OT #7 creada",
      efecto: "Falta asignar mecánico: la unidad sigue detenida",
    });
    expect(pasoDelTurno({ ...orden, estado: "cancelada" }).efecto).toBe("Después se canceló");
    const cerrada = { ...orden, tipo: "orden_cerrada", estado: "completada" } as const;
    expect(pasoDelTurno({ ...cerrada, unidad_hoy: "operativa" })).toMatchObject({
      titulo: "OT #7 completada",
      tono: "green",
      efecto: "La unidad está operativa",
    });
    expect(pasoDelTurno({ ...cerrada, unidad_hoy: null }).efecto).toBe("La orden quedó cerrada");
  });
});
