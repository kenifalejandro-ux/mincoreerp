/** tests/proveedores-precios.test.ts
 *
 * Gestión comercial (PR4): las reglas con las que se arma cada fila «proveedor × producto», sin base de
 * datos. Son las de Combustible (0063/0121): el precio vigente es el más reciente NO anulado cuya fecha ya
 * llegó; uno con fecha futura es «programado»; un precio anulado queda en la historia pero no rige.
 */
import { describe, it, expect } from "vitest";

import {
  armarFilasDePrecios,
  type FilaPrecioCombustibleDb,
  type FilaPrecioUreaDb,
  type FuentesPrecios,
} from "../src/modules/proveedores/proveedores.precios";
import type { ProveedorDto } from "../src/modules/proveedores/proveedores.service";

const AHORA = new Date("2026-11-20T12:00:00Z");
const dias = (n: number) => new Date(AHORA.getTime() + n * 86_400_000).toISOString();

const proveedor = (
  id: number,
  extra: Partial<Pick<ProveedorDto, "nombre" | "activo">> & {
    ruta?: boolean;
    planta?: boolean;
    conUrea?: boolean;
  } = {}
): ProveedorDto => ({
  id,
  codigo: `PRV-${String(id).padStart(3, "0")}`,
  nombre: extra.nombre ?? `PROVEEDOR ${id}`,
  ruc: null,
  activo: extra.activo ?? true,
  tipos: [],
  combustible: { interno: extra.planta ?? false, externo: extra.ruta ?? false },
  urea: { interno: false, externo: extra.conUrea ?? false },
});

const comb = (
  id: number,
  grifo: number,
  precio: number,
  desde: string,
  extra: Partial<FilaPrecioCombustibleDb> = {}
): FilaPrecioCombustibleDb => ({
  id,
  tipo_combustible: "diesel_b5",
  grifo_id: grifo,
  precio_unitario: String(precio),
  vigente_desde: desde,
  registrado_por: "Ana",
  anulada_en: null,
  motivo_anulacion: null,
  ...extra,
});

const fuentes = (extra: Partial<FuentesPrecios> = {}): FuentesPrecios => ({
  proveedores: [proveedor(1, { ruta: true })],
  preciosCombustible: [],
  preciosUrea: [],
  tiposEnTanques: ["diesel_b5"],
  presentaciones: [],
  ...extra,
});

const VER = { combustible: true, urea: true };

describe("Gestión comercial: precio vigente, anterior y programado", () => {
  it("el vigente es el más reciente que ya rige; el anulado y el futuro no cuentan como vigente", () => {
    const [fila] = armarFilasDePrecios(
      fuentes({
        preciosCombustible: [
          comb(4, 1, 14, dias(3)), // programado
          comb(3, 1, 99, dias(-5), { anulada_en: dias(-4), motivo_anulacion: "mal tipeado" }),
          comb(2, 1, 12, dias(-10)),
          comb(1, 1, 10, dias(-30)),
        ],
      }),
      VER,
      AHORA
    );
    expect(fila.vigente?.precio).toBe(12);
    expect(fila.anterior?.precio).toBe(10);
    expect(fila.programado?.precio).toBe(14);
    expect(fila.historial.map((e) => e.precio)).toEqual([14, 99, 12, 10]);
    expect(fila.historial.find((e) => e.precio === 99)).toMatchObject({
      anulado: true,
      motivo: "mal tipeado",
    });
    expect(fila).toMatchObject({ detalle: "Diésel B5", unidad: "galón", producto: "combustible" });
  });

  it("al anular el vigente, rige el anterior válido y ya no hay variación", () => {
    const [fila] = armarFilasDePrecios(
      fuentes({
        preciosCombustible: [
          comb(2, 1, 12, dias(-10), { anulada_en: dias(-1), motivo_anulacion: "error" }),
          comb(1, 1, 10, dias(-30)),
        ],
      }),
      VER,
      AHORA
    );
    expect(fila.vigente?.precio).toBe(10);
    expect(fila.anterior).toBeNull();
  });

  it("con el mismo instante, gana el último cargado; y con varios futuros, el programado es el más cercano", () => {
    const [fila] = armarFilasDePrecios(
      fuentes({
        preciosCombustible: [
          comb(1, 1, 10, dias(-2)),
          comb(2, 1, 11, dias(-2)),
          comb(3, 1, 20, dias(30)),
          comb(4, 1, 15, dias(5)),
        ],
      }),
      VER,
      AHORA
    );
    expect(fila.vigente?.precio).toBe(11);
    expect(fila.programado?.precio).toBe(15);
  });

  it("un proveedor de ruta sin precio sale «sin precio» (vigente nulo) por cada tipo de los tanques", () => {
    const filas = armarFilasDePrecios(
      fuentes({ tiposEnTanques: ["diesel_b5", "gasolina_90"] }),
      VER,
      AHORA
    );
    expect(filas.map((f) => [f.detalle, f.vigente])).toEqual([
      ["Diésel B5", null],
      ["Gasolina 90", null],
    ]);
  });

  it("el proveedor solo de planta no «debe» precio de combustible; el inactivo tampoco, salvo que tenga historia", () => {
    const filas = armarFilasDePrecios(
      fuentes({
        proveedores: [
          proveedor(1, { planta: true }),
          proveedor(2, { ruta: true, activo: false }),
          proveedor(3, { ruta: true, activo: false, nombre: "CON HISTORIA" }),
        ],
        preciosCombustible: [comb(1, 3, 15.5, dias(-3))],
      }),
      VER,
      AHORA
    );
    expect(filas.map((f) => f.proveedorId)).toEqual([3]);
    expect(filas[0]).toMatchObject({ proveedorActivo: false, vigente: { precio: 15.5 } });
  });

  it("ignora los precios de un proveedor que no está en el directorio (el comodín «Otros»)", () => {
    const filas = armarFilasDePrecios(
      fuentes({ preciosCombustible: [comb(1, 999, 20, dias(-1))] }),
      VER,
      AHORA
    );
    expect(filas.every((f) => f.proveedorId === 1)).toBe(true);
    expect(filas.every((f) => f.vigente === null)).toBe(true);
  });

  it("solo arma el producto que el perfil puede ver", () => {
    const urea: FilaPrecioUreaDb = {
      id: 1,
      grifo_id: 2,
      presentacion: "caja",
      marca: "Green 32",
      precio_por_bulto: "78",
      vigente_desde: dias(-1),
      registrado_por: null,
      anulada_en: null,
      motivo_anulacion: null,
    };
    const base = fuentes({
      proveedores: [proveedor(1, { ruta: true }), proveedor(2, { conUrea: true })],
      preciosCombustible: [comb(1, 1, 15, dias(-1))],
      preciosUrea: [urea],
      presentaciones: [
        { codigo: "caja", nombre: "Caja", litros: "20.00" },
        { codigo: "balde", nombre: "Balde", litros: "5.00" },
      ],
    });
    const soloUrea = armarFilasDePrecios(base, { combustible: false, urea: true }, AHORA);
    expect(soloUrea.map((f) => f.producto)).toEqual(["urea", "urea"]);
    expect(soloUrea.map((f) => [f.detalle, f.vigente?.precio ?? null, f.unidad])).toEqual([
      ["Balde (5 L)", null, "envase"],
      ["Caja (20 L)", 78, "envase"],
    ]);
    expect(soloUrea.find((f) => f.codigo === "caja")?.vigente?.marca).toBe("Green 32");
    const soloCombustible = armarFilasDePrecios(base, { combustible: true, urea: false }, AHORA);
    expect(soloCombustible.map((f) => f.producto)).toEqual(["combustible"]);
    expect(armarFilasDePrecios(base, { combustible: false, urea: false }, AHORA)).toEqual([]);
  });
});
