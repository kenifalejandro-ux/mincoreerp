/** tests/proveedores-centro-de-gestion.test.ts
 *
 * El Centro de gestión como la maqueta (lógica del cliente, sin React): las cifras de las tarjetas, qué requiere
 * atención, la distribución por tipo y cómo se dice «hace 18 min». Todo sale de datos reales: sin permiso de
 * precios no se inventa nada.
 */
import { describe, it, expect } from "vitest";

import {
  atencionDelCentro,
  cifrasDelCentro,
  degradadoDeDona,
  enMinuscula,
  fechaLarga,
  inicialesDe,
  tiempoRelativo,
  trozosPorTipo,
} from "../client/src/components/proveedores/centroDeGestion";
import type {
  FilaPrecio,
  ProveedorEnDirectorio,
} from "../client/src/components/proveedores/proveedoresApi";

const prov = (id: number, extra: Partial<ProveedorEnDirectorio> = {}): ProveedorEnDirectorio => ({
  id,
  codigo: `PRV-00${id}`,
  nombre: `PROVEEDOR ${id}`,
  ruc: null,
  activo: true,
  tipos: ["Combustible"],
  combustible: { interno: true, externo: false },
  urea: { interno: false, externo: false },
  ciudad: null,
  fichaCompleta: { porcentaje: 100, faltan: [] },
  precioVigente: { producto: "Diésel B5", precio: 15, unidad: "galón" },
  ...extra,
});

describe("cifrasDelCentro", () => {
  const lista = [
    prov(1),
    prov(2, { precioVigente: null, fichaCompleta: { porcentaje: 40, faltan: ["RUC"] } }),
    prov(3, { activo: false, precioVigente: null, tipos: ["Urea"] }),
    prov(4, { tipos: ["Combustible", "Urea"], fichaCompleta: { porcentaje: 60, faltan: [] } }),
  ];

  it("cuenta total, activos, tipos, activos sin precio y fichas incompletas", () => {
    expect(cifrasDelCentro(lista)).toEqual({
      total: 4,
      activos: 3,
      pctActivos: 75,
      combustible: 3,
      urea: 2,
      // Activos sin precio: el 2 (el 3 está desactivado, no cuenta).
      activosSinPrecio: 1,
      pctConPrecio: 67,
      fichasIncompletas: 2,
      promedioDeFichas: 75,
    });
  });

  it("sin permiso de precios no se puede saber quién no tiene precio: null, no 0", () => {
    const sinVer = lista.map((p) => {
      const { precioVigente, ...resto } = p;
      void precioVigente;
      return resto as ProveedorEnDirectorio;
    });
    const c = cifrasDelCentro(sinVer);
    expect(c.activosSinPrecio).toBeNull();
    expect(c.pctConPrecio).toBeNull();
    expect(c.total).toBe(4);
  });

  it("sin proveedores todo es cero (sin dividir por cero)", () => {
    expect(cifrasDelCentro([])).toMatchObject({
      total: 0,
      activos: 0,
      pctActivos: 0,
      activosSinPrecio: 0,
      pctConPrecio: 0,
      fichasIncompletas: 0,
      promedioDeFichas: 0,
    });
  });
});

describe("atencionDelCentro", () => {
  const ahora = Date.parse("2026-11-22T12:00:00-05:00");
  const fila = ({
    hasta = null,
    anterior,
  }: {
    hasta?: string | null;
    anterior?: number;
  }): FilaPrecio =>
    ({
      clave: String(Math.random()),
      proveedorId: 1,
      proveedorActivo: true,
      producto: "combustible",
      codigo: "diesel_b5",
      vigente: {
        id: 1,
        precio: 10.8,
        desde: "2026-11-01T00:00:00.000Z",
        hasta,
        por: null,
        marca: null,
        anulado: false,
        motivo: null,
      },
      anterior: anterior ? { id: 0, precio: anterior } : null,
      programado: null,
      historial: [],
    }) as unknown as FilaPrecio;

  const cifras = (fichasIncompletas = 0) =>
    ({ ...cifrasDelCentro([]), fichasIncompletas }) as ReturnType<typeof cifrasDelCentro>;

  it("sin nada pendiente no hay items (la pantalla dice «Todo al día»)", () => {
    expect(atencionDelCentro(cifras(), [fila({})], ahora)).toEqual([]);
    expect(atencionDelCentro(cifras(), null, ahora)).toEqual([]);
  });

  it("precios por vencer en 30 días y alzas de 5 % o más, hacia Gestión comercial", () => {
    const items = atencionDelCentro(
      cifras(),
      [fila({ hasta: "2026-12-10" }), fila({ hasta: "2026-12-20" }), fila({ anterior: 10 })],
      ahora
    );
    expect(items.map((i) => i.id)).toEqual(["precios-por-vencer", "precios-con-alza"]);
    expect(items[0]).toMatchObject({
      titulo: "2 precios vencen en los próximos 30 días",
      accion: "Ver precios",
      destino: "comercial",
    });
    expect(items[1]).toMatchObject({
      titulo: "1 precio subió 5 % o más",
      destino: "comercial",
    });
  });

  it("los precios vencidos y los que vencen después de 30 días no cuentan como «por vencer»", () => {
    expect(
      atencionDelCentro(
        cifras(),
        [fila({ hasta: "2026-11-01" }), fila({ hasta: "2027-03-01" })],
        ahora
      )
    ).toEqual([]);
  });

  it("las fichas incompletas llevan al Directorio, con o sin permiso de precios", () => {
    const items = atencionDelCentro(cifras(3), null, ahora);
    expect(items).toEqual([
      expect.objectContaining({
        id: "fichas-incompletas",
        titulo: "3 fichas incompletas (menos del 80 %)",
        destino: "directorio",
      }),
    ]);
    expect(atencionDelCentro(cifras(1), null, ahora)[0].titulo).toBe(
      "1 ficha incompleta (menos del 80 %)"
    );
  });
});

describe("la dona de proveedores por tipo", () => {
  it("un proveedor de los dos tipos cuenta en cada uno", () => {
    const t = trozosPorTipo([prov(1), prov(2, { tipos: ["Combustible", "Urea"] })]);
    expect(t.map((x) => [x.etiqueta, x.cantidad])).toEqual([
      ["Combustible", 2],
      ["Urea", 1],
    ]);
  });

  it("el degradado reparte el círculo por porcentaje y cierra en 100 %", () => {
    expect(
      degradadoDeDona([
        { etiqueta: "A", cantidad: 3, color: "#111" },
        { etiqueta: "B", cantidad: 1, color: "#222" },
      ])
    ).toBe("conic-gradient(#111 0% 75%, #222 75% 100%)");
    expect(
      degradadoDeDona([
        { etiqueta: "A", cantidad: 1, color: "#111" },
        { etiqueta: "B", cantidad: 2, color: "#222" },
      ])
    ).toBe("conic-gradient(#111 0% 33%, #222 33% 100%)");
  });

  it("sin datos, un solo color gris", () => {
    expect(degradadoDeDona([{ etiqueta: "A", cantidad: 0, color: "#111" }])).toBe(
      "conic-gradient(#e2e8f0 0% 100%)"
    );
  });
});

describe("tiempoRelativo", () => {
  const ahora = Date.parse("2026-11-22T20:00:00Z"); // 15:00 en Lima
  it("minutos, horas, ayer y fecha", () => {
    expect(tiempoRelativo("2026-11-22T19:59:40Z", ahora)).toBe("Ahora");
    expect(tiempoRelativo("2026-11-22T19:42:00Z", ahora)).toBe("Hace 18 min");
    expect(tiempoRelativo("2026-11-22T18:00:00Z", ahora)).toBe("Hace 2 h");
    expect(tiempoRelativo("2026-11-21T14:42:00Z", ahora)).toBe("Ayer, 09:42");
    expect(tiempoRelativo("2026-11-10T14:30:00Z", ahora)).toBe("10/11/2026, 09:30");
  });
  it("una fecha inválida no se inventa", () => {
    expect(tiempoRelativo("no es fecha", ahora)).toBe("");
  });
});

describe("textos", () => {
  it("enMinuscula, inicialesDe y fechaLarga", () => {
    expect(enMinuscula("Cargó un precio")).toBe("cargó un precio");
    expect(enMinuscula("")).toBe("");
    expect(inicialesDe("E2E Admin")).toBe("EA");
    expect(inicialesDe("Rosa")).toBe("R");
    expect(inicialesDe(null)).toBe("—");
    expect(fechaLarga(Date.parse("2026-11-22T20:00:00Z"))).toBe("22 de noviembre de 2026");
  });
});
