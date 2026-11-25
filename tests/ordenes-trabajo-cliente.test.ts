/** tests/ordenes-trabajo-cliente.test.ts
 *
 * E5-5 en pantalla: duración, horas escritas a mano y qué se manda al guardar.
 */
import { describe, it, expect } from "vitest";

import {
  conPendiente,
  horaParaInput,
  horasCambiadas,
  problemaDeHoras,
  textoDeDuracion,
} from "../client/src/components/ordenes_trabajo/horasYTareas";

describe("Órdenes de trabajo: horas y tareas en pantalla", () => {
  it("escribe la duración en horas y minutos", () => {
    expect(textoDeDuracion(null)).toBeNull();
    expect(textoDeDuracion(0)).toBe("0 min");
    expect(textoDeDuracion(45)).toBe("45 min");
    expect(textoDeDuracion(180)).toBe("3 h");
    expect(textoDeDuracion(210)).toBe("3 h 30 min");
  });

  it("rechaza horas futuras o cruzadas", () => {
    const ahora = new Date("2026-11-25T12:00").getTime();
    expect(problemaDeHoras("", "", ahora)).toBeNull();
    expect(problemaDeHoras("2026-11-25T08:00", "2026-11-25T11:30", ahora)).toBeNull();
    expect(problemaDeHoras("2026-11-25T13:00", "", ahora)).toContain("futura");
    expect(problemaDeHoras("0202-11-25T08:00", "", ahora)).toContain("año");
    expect(problemaDeHoras("2026-11-25T11:00", "2026-11-25T08:00", ahora)).toContain("posterior");
  });

  it("solo manda las horas que se cambiaron; el inicio se puede quitar y el cierre no", () => {
    const guardadas = { inicio_en: "2026-11-25T13:00:42.000Z", fecha_cierre: null };
    const inicio = horaParaInput(guardadas.inicio_en);
    expect(horasCambiadas(guardadas, inicio, "")).toEqual({});
    expect(horasCambiadas(guardadas, "", "")).toEqual({ inicio_en: null });
    const nuevo = horasCambiadas(guardadas, "2026-11-24T08:00", "2026-11-24T09:00");
    expect(nuevo.inicio_en).toBe(new Date("2026-11-24T08:00").toISOString());
    expect(nuevo.fecha_cierre).toBe(new Date("2026-11-24T09:00").toISOString());
  });

  it("lo escrito sin agregar también es una tarea", () => {
    expect(conPendiente(["Uno"], "  ")).toEqual(["Uno"]);
    expect(conPendiente(["Uno"], " Dos ")).toEqual(["Uno", "Dos"]);
    const llenas = Array.from({ length: 50 }, (_, i) => `T${i}`);
    expect(conPendiente(llenas, "Una más")).toHaveLength(50);
  });
});
