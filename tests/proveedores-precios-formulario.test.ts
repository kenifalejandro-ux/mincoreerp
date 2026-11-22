/** tests/proveedores-precios-formulario.test.ts
 *
 * «Nuevo precio» (PR4b), lógica del formulario sin React: valores iniciales, variación contra el vigente,
 * confirmación del cambio grande, validaciones y el cuerpo que se envía.
 */
import { describe, it, expect } from "vitest";

import {
  cuerpoDelPrecio,
  formularioInicialDePrecio,
  necesitaConfirmacion,
  problemasDelPrecio,
  variacionesContraVigente,
  vigenteDesdeIso,
  UMBRAL_CONFIRMACION_PCT,
  type FormularioDePrecio,
} from "../client/src/components/proveedores/preciosFormulario";
import type {
  DatosFormularioPrecio,
  FilaPrecio,
} from "../client/src/components/proveedores/proveedoresApi";

const datos = (extra: Partial<DatosFormularioPrecio> = {}): DatosFormularioPrecio => ({
  combustible: true,
  urea: true,
  proveedoresCombustible: [
    { id: 5, nombre: "GRIFO A" },
    { id: 6, nombre: "GRIFO B" },
  ],
  proveedoresUrea: [{ id: 7, nombre: "ALMACEN U" }],
  presentaciones: [{ codigo: "caja_20l", nombre: "Caja (20 L)", litros: "20" }],
  ...extra,
});

const fila = (
  proveedorId: number,
  producto: "combustible" | "urea",
  codigo: string,
  precio: number | null
): FilaPrecio => ({
  clave: `${proveedorId}-${producto}-${codigo}`,
  proveedorId,
  proveedorCodigo: `P${proveedorId}`,
  proveedorNombre: `Proveedor ${proveedorId}`,
  proveedorActivo: true,
  producto,
  codigo,
  detalle: codigo,
  unidad: producto === "urea" ? "envase" : "galón",
  uso: "externo",
  condicionDePago: null,
  vigente:
    precio === null
      ? null
      : {
          id: 1,
          precio,
          desde: "2026-11-01T00:00:00.000Z",
          hasta: null,
          por: null,
          marca: null,
          anulado: false,
          motivo: null,
        },
  anterior: null,
  programado: null,
  historial: [],
});

const base = (extra: Partial<FormularioDePrecio> = {}): FormularioDePrecio => ({
  ...formularioInicialDePrecio(datos()),
  ...extra,
});

describe("formularioInicialDePrecio", () => {
  it("empieza en combustible, sin proveedor, con la primera presentación", () => {
    const f = formularioInicialDePrecio(datos());
    expect(f.producto).toBe("combustible");
    expect(f.grifo_ids).toEqual([]);
    expect(f.grifo_id).toBe("");
    expect(f.presentacion).toBe("caja_20l");
    expect(f.confirmado).toBe(false);
  });

  it("sin permiso de combustible arranca en urea", () => {
    expect(formularioInicialDePrecio(datos({ combustible: false })).producto).toBe("urea");
  });

  it("desde la ficha de un proveedor de ruta lo deja marcado", () => {
    expect(formularioInicialDePrecio(datos(), 6).grifo_ids).toEqual([6]);
  });

  it("desde la ficha de un proveedor de urea abre en urea con él elegido", () => {
    const f = formularioInicialDePrecio(datos(), 7);
    expect(f.producto).toBe("urea");
    expect(f.grifo_id).toBe("7");
  });
});

describe("variaciones y confirmación", () => {
  const filas = [
    fila(5, "combustible", "diesel_b5", 10),
    fila(6, "combustible", "diesel_b5", null),
  ];

  it("calcula el % solo para quien ya tiene precio vigente de ese producto", () => {
    const v = variacionesContraVigente(base({ grifo_ids: [5, 6], precio: "12" }), filas);
    expect(v).toHaveLength(1);
    expect(v[0].proveedorId).toBe(5);
    expect(v[0].pct).toBeCloseTo(20);
  });

  it("acepta la coma decimal y no calcula sin precio válido", () => {
    expect(
      variacionesContraVigente(base({ grifo_ids: [5], precio: "12,5" }), filas)[0].pct
    ).toBeCloseTo(25);
    expect(variacionesContraVigente(base({ grifo_ids: [5], precio: "" }), filas)).toEqual([]);
    expect(variacionesContraVigente(base({ grifo_ids: [5], precio: "-3" }), filas)).toEqual([]);
  });

  it("no mezcla otro tipo de combustible ni otro producto", () => {
    const f = base({ grifo_ids: [5], precio: "12", tipo_combustible: "gasolina_90" });
    expect(variacionesContraVigente(f, filas)).toEqual([]);
  });

  it("urea compara por proveedor y presentación", () => {
    const f = base({ producto: "urea", grifo_id: "7", presentacion: "caja_20l", precio: "150" });
    const v = variacionesContraVigente(f, [fila(7, "urea", "caja_20l", 100)]);
    expect(v[0].pct).toBeCloseTo(50);
  });

  it("pide confirmación solo por encima del umbral, hacia arriba o abajo", () => {
    expect(UMBRAL_CONFIRMACION_PCT).toBe(50);
    expect(necesitaConfirmacion([{ pct: 50 }])).toBe(false);
    expect(necesitaConfirmacion([{ pct: 50.1 }])).toBe(true);
    expect(necesitaConfirmacion([{ pct: -60 }])).toBe(true);
    expect(necesitaConfirmacion([])).toBe(false);
  });
});

describe("problemasDelPrecio", () => {
  const filas = [fila(5, "combustible", "diesel_b5", 10)];

  it("pide proveedor y precio en combustible", () => {
    expect(problemasDelPrecio(base(), filas)).toEqual([
      "Elige al menos un proveedor.",
      "Escribe el precio.",
    ]);
  });

  it("en urea pide proveedor y presentación", () => {
    const p = problemasDelPrecio(base({ producto: "urea", presentacion: "", precio: "9" }), filas);
    expect(p).toEqual(["Elige el proveedor.", "Elige la presentación."]);
  });

  it("rechaza precios de más de S/ 100,000 y fechas inválidas o a más de un año", () => {
    const ahora = Date.parse("2026-11-21T12:00:00Z");
    expect(problemasDelPrecio(base({ grifo_ids: [5], precio: "100001" }), filas, ahora)).toContain(
      "El precio no puede pasar de S/ 100,000."
    );
    expect(
      problemasDelPrecio(
        base({ grifo_ids: [5], precio: "11", vigente_desde: "basura" }),
        filas,
        ahora
      )
    ).toContain("La fecha de vigencia no es válida.");
    expect(
      problemasDelPrecio(
        base({ grifo_ids: [5], precio: "11", vigente_desde: "2028-01-01T00:00" }),
        filas,
        ahora
      )
    ).toContain("La vigencia no puede estar a más de un año.");
  });

  it("un salto grande exige la confirmación y con ella se puede enviar", () => {
    const f = base({ grifo_ids: [5], precio: "30" });
    expect(problemasDelPrecio(f, filas)).toEqual([
      "El cambio es de más de 50 %: marca la confirmación.",
    ]);
    expect(problemasDelPrecio({ ...f, confirmado: true }, filas)).toEqual([]);
  });

  it("un precio normal no tiene problemas", () => {
    expect(problemasDelPrecio(base({ grifo_ids: [5], precio: "10.5" }), filas)).toEqual([]);
  });
});

describe("vigenteDesdeIso y cuerpoDelPrecio", () => {
  it("vacío = desde ahora, inválido = null, válido = ISO", () => {
    expect(vigenteDesdeIso("  ")).toBeUndefined();
    expect(vigenteDesdeIso("no es fecha")).toBeNull();
    expect(vigenteDesdeIso("2026-12-01T08:00")).toMatch(/^2026-12-01T\d\d:00:00\.000Z$/);
  });

  it("combustible: un solo cuerpo con todos los proveedores", () => {
    const r = cuerpoDelPrecio(base({ grifo_ids: [5, 6], precio: "15,8" }));
    expect(r).toEqual({
      producto: "combustible",
      cuerpo: {
        tipo_combustible: "diesel_b5",
        grifo_ids: [5, 6],
        precio_unitario: 15.8,
        vigente_desde: undefined,
      },
    });
  });

  it("urea: proveedor, presentación y marca recortada (vacía = sin marca)", () => {
    const f = base({
      producto: "urea",
      grifo_id: "7",
      presentacion: "caja_20l",
      precio: "120",
      marca: "  Bluetec ",
    });
    expect(cuerpoDelPrecio(f)).toEqual({
      producto: "urea",
      cuerpo: {
        grifo_id: 7,
        presentacion: "caja_20l",
        marca: "Bluetec",
        precio_por_bulto: 120,
        vigente_desde: undefined,
      },
    });
    const sinMarca = cuerpoDelPrecio({ ...f, marca: "   " });
    expect(sinMarca.producto === "urea" && sinMarca.cuerpo.marca).toBeUndefined();
  });
});

describe("vigencia hasta del precio", () => {
  const filas = [fila(5, "combustible", "diesel_b5", 10)];

  it("es opcional: vacía no se manda y no estorba", () => {
    const f = base({ grifo_ids: [5], precio: "10.5" });
    expect(f.vigente_hasta).toBe("");
    expect(problemasDelPrecio(f, filas)).toEqual([]);
    const r = cuerpoDelPrecio(f);
    expect(r.cuerpo.vigente_hasta).toBeUndefined();
  });

  it("se manda como AAAA-MM-DD, en combustible y en urea", () => {
    const comb = cuerpoDelPrecio(
      base({ grifo_ids: [5], precio: "10.5", vigente_hasta: "2026-12-31" })
    );
    expect(comb.cuerpo.vigente_hasta).toBe("2026-12-31");
    const urea = cuerpoDelPrecio(
      base({
        producto: "urea",
        grifo_id: "7",
        presentacion: "caja_20l",
        precio: "9",
        vigente_hasta: "2027-01-15",
      })
    );
    expect(urea.cuerpo.vigente_hasta).toBe("2027-01-15");
  });

  it("no puede ser anterior al día en que el precio empieza a regir", () => {
    const ahora = Date.parse("2026-11-20T17:00:00Z");
    const mensaje = "La vigencia hasta no puede ser anterior a la fecha desde la que rige.";
    // Sin «rige desde»: rige desde hoy (20/11 en Lima).
    expect(
      problemasDelPrecio(
        base({ grifo_ids: [5], precio: "10.5", vigente_hasta: "2026-11-19" }),
        filas,
        ahora
      )
    ).toEqual([mensaje]);
    expect(
      problemasDelPrecio(
        base({ grifo_ids: [5], precio: "10.5", vigente_hasta: "2026-11-20" }),
        filas,
        ahora
      )
    ).toEqual([]);
    // Con «rige desde» elegido, se compara con ese día.
    expect(
      problemasDelPrecio(
        base({
          grifo_ids: [5],
          precio: "10.5",
          vigente_desde: "2026-12-01T08:00",
          vigente_hasta: "2026-11-30",
        }),
        filas,
        ahora
      )
    ).toEqual([mensaje]);
  });

  it("una fecha mal escrita avisa", () => {
    expect(
      problemasDelPrecio(
        base({ grifo_ids: [5], precio: "10.5", vigente_hasta: "31/12/2026" }),
        filas
      )
    ).toEqual(["La vigencia hasta no es una fecha válida."]);
  });
});
