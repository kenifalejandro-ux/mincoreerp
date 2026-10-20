/** tests/combustible-borrador-compra-ruta.test.ts
 *
 * El borrador de "Compra en ruta": lo que el conductor lleva escrito se guarda en
 * su dispositivo para no perderlo si se le cierra la pantalla o se le va la señal.
 *
 * Lo que se defiende:
 *   1. Va por usuario: dos personas con el mismo celular no se ven el borrador.
 *   2. Vence a las 24 h (el plazo de la foto): un precio de ayer no es de fiar.
 *   3. Un formulario vacío no deja borrador, y uno que se vacía lo borra.
 *   4. Un dato dañado o de otra versión se descarta; nunca rompe la pantalla.
 *   5. Un almacenamiento que falla (modo privado, sin espacio) no lanza.
 *   6. No guarda la foto (no hay campo para ella) y sí el uuid de la compra.
 */
import { describe, it, expect } from "vitest";
import {
  VENCIMIENTO_BORRADOR_MS,
  borradorTieneContenido,
  borrarBorrador,
  guardarBorrador,
  leerBorrador,
  type Almacen,
  type BorradorCompraRuta,
} from "../client/src/components/combustible/borradorCompraRuta";

const vacio = (): BorradorCompraRuta => ({
  clienteUuid: "11111111-1111-4111-8111-111111111111",
  equipoId: "",
  grifoId: "",
  comprobanteTipo: "boleta",
  comprobanteNumero: "",
  fecha: "2026-10-20T08:00",
  fechaEditada: false,
  incluyeCombustible: true,
  incluyeUrea: false,
  tipoCombustible: "diesel_b5",
  galones: "",
  costoUnitario: "",
  costoEditado: false,
  horometro: "",
  odometro: "",
  horas: "",
  horasEditadas: false,
  renglones: [{ clave: "r1", presentacion: "caja", cantidad: "", precio: "", precioAuto: true }],
  totalBoleta: "",
  observaciones: "",
});

const conAlgo = (): BorradorCompraRuta => ({
  ...vacio(),
  equipoId: "7",
  comprobanteNumero: "B001-123",
  galones: "40",
  incluyeUrea: true,
  renglones: [
    { clave: "r1", presentacion: "caja", cantidad: "2", precio: "50", precioAuto: false },
  ],
  totalBoleta: "800",
});

function almacenFalso(): Almacen & { datos: Map<string, string> } {
  const datos = new Map<string, string>();
  return {
    datos,
    getItem: (k) => datos.get(k) ?? null,
    setItem: (k, v) => void datos.set(k, v),
    removeItem: (k) => void datos.delete(k),
  };
}

const T0 = 1_800_000_000_000;

describe("borrador de compra en ruta", () => {
  it("lo que se guarda se recupera idéntico, con el uuid de la compra", () => {
    const a = almacenFalso();
    guardarBorrador("u1", conAlgo(), a, T0);
    const r = leerBorrador("u1", a, T0 + 5_000);
    expect(r?.datos).toEqual(conAlgo());
    expect(r?.datos.clienteUuid).toBe("11111111-1111-4111-8111-111111111111");
    expect(r?.guardadoEn).toBe(T0);
  });

  it("va por usuario: otra persona no ve el borrador", () => {
    const a = almacenFalso();
    guardarBorrador("u1", conAlgo(), a, T0);
    expect(leerBorrador("u2", a, T0)).toBeNull();
    expect(leerBorrador("u1", a, T0)).not.toBeNull();
  });

  it("vence a las 24 h, y al vencer se borra", () => {
    const a = almacenFalso();
    guardarBorrador("u1", conAlgo(), a, T0);
    expect(leerBorrador("u1", a, T0 + VENCIMIENTO_BORRADOR_MS - 1)).not.toBeNull();
    expect(leerBorrador("u1", a, T0 + VENCIMIENTO_BORRADOR_MS + 1)).toBeNull();
    expect(a.datos.size).toBe(0);
  });

  it("un reloj corrido hacia atrás (borrador del futuro) se descarta", () => {
    const a = almacenFalso();
    guardarBorrador("u1", conAlgo(), a, T0 + 3 * 60 * 60 * 1000);
    expect(leerBorrador("u1", a, T0)).toBeNull();
  });

  it("un formulario vacío no deja borrador, y vaciarlo borra el que había", () => {
    const a = almacenFalso();
    guardarBorrador("u1", vacio(), a, T0);
    expect(a.datos.size).toBe(0);
    guardarBorrador("u1", conAlgo(), a, T0);
    expect(a.datos.size).toBe(1);
    guardarBorrador("u1", vacio(), a, T0 + 1000);
    expect(a.datos.size).toBe(0);
  });

  it("solo la hora o el tipo de combustible por defecto no cuentan como contenido", () => {
    expect(borradorTieneContenido(vacio())).toBe(false);
    expect(borradorTieneContenido({ ...vacio(), fecha: "2026-10-20T09:00" })).toBe(false);
    expect(borradorTieneContenido({ ...vacio(), comprobanteNumero: "  " })).toBe(false);
    expect(borradorTieneContenido({ ...vacio(), comprobanteNumero: "B001" })).toBe(true);
    expect(
      borradorTieneContenido({
        ...vacio(),
        renglones: [
          { clave: "r", presentacion: "caja", cantidad: "1", precio: "", precioAuto: true },
        ],
      })
    ).toBe(true);
  });

  it("borrarBorrador lo quita (al registrar la compra o al pulsar Limpiar)", () => {
    const a = almacenFalso();
    guardarBorrador("u1", conAlgo(), a, T0);
    borrarBorrador("u1", a);
    expect(leerBorrador("u1", a, T0)).toBeNull();
  });

  it("un JSON roto, de otra versión o con forma ajena se descarta y se limpia", () => {
    const a = almacenFalso();
    const k = "mincore:compra-ruta-borrador:u1";
    for (const malo of [
      "{no es json",
      "null",
      "42",
      JSON.stringify({ version: 2, guardadoEn: T0, datos: conAlgo() }),
      JSON.stringify({ version: 1, guardadoEn: "ayer", datos: conAlgo() }),
      JSON.stringify({ version: 1, guardadoEn: T0, datos: { renglones: "no" } }),
      JSON.stringify({ version: 1, guardadoEn: T0 }),
    ]) {
      a.datos.set(k, malo);
      expect(leerBorrador("u1", a, T0)).toBeNull();
      expect(a.datos.has(k)).toBe(false);
    }
  });

  it("un almacenamiento que lanza (modo privado, sin espacio) no rompe nada", () => {
    const roto: Almacen = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => guardarBorrador("u1", conAlgo(), roto, T0)).not.toThrow();
    expect(() => borrarBorrador("u1", roto)).not.toThrow();
    expect(leerBorrador("u1", roto, T0)).toBeNull();
  });

  it("sin almacenamiento (null) todo es un no-op", () => {
    expect(() => guardarBorrador("u1", conAlgo(), null, T0)).not.toThrow();
    expect(() => borrarBorrador("u1", null)).not.toThrow();
    expect(leerBorrador("u1", null, T0)).toBeNull();
  });

  it("la foto no es parte del borrador: ni un campo para ella", () => {
    const campos = Object.keys(conAlgo());
    expect(campos.some((c) => /foto|archivo|file/i.test(c))).toBe(false);
  });
});
