/** tests/cisternas-pantalla-logica.test.ts
 *
 * La lógica pura de la pestaña "Cisternas": quién la ve, cuánto se llena el dibujo y de qué color
 * según el plazo. Aparte de la pantalla para probarla con números sueltos, igual que el nivel de
 * la tanqueta.
 */
import { describe, it, expect } from "vitest";
import { puedeVerCisternas } from "../client/src/components/combustible/cisternasAcceso";
import {
  coloresDeLaCisterna,
  diasConSaldo,
  estadoDelPlazo,
  porcentajeDelNivel,
} from "../client/src/components/combustible/nivelCisterna";

describe("quién ve la pestaña Cisternas", () => {
  it("admin, operador, grifero y Lectura la ven; el conductor y el encargado de urea no", () => {
    for (const rol of ["admin", "operador", "grifero", "lectura"]) {
      expect(puedeVerCisternas({ rol }), rol).toBe(true);
    }
    for (const rol of ["conductor_ruta", "encargado_urea"]) {
      expect(puedeVerCisternas({ rol }), rol).toBe(false);
    }
    expect(puedeVerCisternas(null)).toBe(false);
    expect(puedeVerCisternas(undefined)).toBe(false);
  });

  it("un permiso guardado por el admin manda sobre el rol, en los dos sentidos", () => {
    expect(
      puedeVerCisternas({ rol: "lectura", permisosPestanas: { "combustible:cisternas": false } })
    ).toBe(false);
    expect(
      puedeVerCisternas({
        rol: "conductor_ruta",
        permisosPestanas: { "combustible:cisternas": true },
      })
    ).toBe(true);
    // Otro permiso guardado no la toca.
    expect(
      puedeVerCisternas({ rol: "grifero", permisosPestanas: { "combustible:urea": false } })
    ).toBe(true);
  });
});

describe("cuánto se llena la cisterna", () => {
  it("el 100% es lo que quedó al recibir, y nunca se sale del vidrio", () => {
    expect(porcentajeDelNivel(500, 500)).toBe(100);
    expect(porcentajeDelNivel(250, 500)).toBe(50);
    expect(porcentajeDelNivel(0, 500)).toBe(0);
    expect(porcentajeDelNivel(600, 500)).toBe(100);
    expect(porcentajeDelNivel(-5, 500)).toBe(0);
    // Sin lo que quedó al recibir no hay con qué comparar: vacío, no NaN.
    expect(porcentajeDelNivel(100, 0)).toBe(0);
    expect(porcentajeDelNivel(Number.NaN, 500)).toBe(0);
  });
});

describe("el plazo de la cisterna", () => {
  const ahora = new Date("2026-11-10T12:00:00Z").getTime();

  it("cuenta días enteros desde que llegó, y una fecha ilegible o futura da 0", () => {
    expect(diasConSaldo("2026-11-10T00:00:00Z", ahora)).toBe(0);
    expect(diasConSaldo("2026-11-07T11:00:00Z", ahora)).toBe(3);
    expect(diasConSaldo("2026-11-07T13:00:00Z", ahora)).toBe(2);
    expect(diasConSaldo("no es una fecha", ahora)).toBe(0);
    expect(diasConSaldo("2026-12-01T00:00:00Z", ahora)).toBe(0);
  });

  it("en plazo, por vencer desde el 80% y vencido pasado el plazo", () => {
    expect(estadoDelPlazo(3, 10)).toBe("en_plazo");
    expect(estadoDelPlazo(7, 10)).toBe("en_plazo");
    expect(estadoDelPlazo(8, 10)).toBe("por_vencer");
    expect(estadoDelPlazo(10, 10)).toBe("por_vencer");
    expect(estadoDelPlazo(11, 10)).toBe("vencido");
  });

  it("sin plazo (el servidor no lo mandó o es inválido) no se pinta alerta", () => {
    for (const plazo of [undefined, null, 0, -3, Number.NaN]) {
      expect(estadoDelPlazo(99, plazo), String(plazo)).toBe("sin_plazo");
    }
  });

  it("el color de alerta le gana al cian; en plazo y sin plazo es cian", () => {
    const cian = coloresDeLaCisterna("en_plazo")[0];
    expect(coloresDeLaCisterna("sin_plazo")[0]).toBe(cian);
    expect(coloresDeLaCisterna("por_vencer")[0]).not.toBe(cian);
    expect(coloresDeLaCisterna("vencido")[0]).not.toBe(cian);
    expect(coloresDeLaCisterna("vencido")[0]).not.toBe(coloresDeLaCisterna("por_vencer")[0]);
  });
});
