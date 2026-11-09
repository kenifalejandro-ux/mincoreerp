/** tests/ubicaciones-logica.test.ts
 *
 * La lógica pura de «Registrar ubicación» (0182): qué se rechaza antes de mandar, el cuerpo que se
 * manda (lugar del catálogo por id, lo escrito como texto libre) y el «hace 2 h». Sin pantalla.
 */
import { describe, it, expect } from "vitest";
import { aValorLocal } from "../client/src/components/combustible/ponerAlDiaLogica";
import {
  cuerpoDeUbicacion,
  errorDeUbicacion,
  haceCuanto,
  lugaresDelCatalogo,
} from "../client/src/components/combustible/ubicacionesLogica";

const H = 3_600_000;
const AHORA = Date.parse("2026-11-09T15:00:00-05:00");
const SALIDA = new Date(AHORA - 10 * H).toISOString();
const base = { inicioViaje: SALIDA, ahora: AHORA };

describe("errorDeUbicacion", () => {
  it("pide un lugar o un texto", () => {
    const horaLocal = aValorLocal(AHORA);
    expect(errorDeUbicacion({ ...base, lugar: null, horaLocal })).toMatch(/Elige un lugar/);
    expect(errorDeUbicacion({ ...base, lugar: "   ", horaLocal })).toMatch(/Elige un lugar/);
    expect(errorDeUbicacion({ ...base, lugar: 7, horaLocal })).toBeNull();
    expect(errorDeUbicacion({ ...base, lugar: "Km 85", horaLocal })).toBeNull();
  });

  it("rechaza más de 160 letras", () => {
    const e = errorDeUbicacion({ ...base, lugar: "x".repeat(161), horaLocal: aValorLocal(AHORA) });
    expect(e).toMatch(/160/);
  });

  it("rechaza una hora vacía, futura o anterior a la salida", () => {
    expect(errorDeUbicacion({ ...base, lugar: 7, horaLocal: "" })).toMatch(/fecha y la hora/);
    expect(errorDeUbicacion({ ...base, lugar: 7, horaLocal: aValorLocal(AHORA + 2 * H) })).toMatch(
      /futura/
    );
    expect(errorDeUbicacion({ ...base, lugar: 7, horaLocal: aValorLocal(AHORA - 11 * H) })).toMatch(
      /posterior a la salida/
    );
  });

  it("acepta una hora pasada dentro del viaje y ahora mismo", () => {
    expect(
      errorDeUbicacion({ ...base, lugar: 7, horaLocal: aValorLocal(AHORA - 3 * H) })
    ).toBeNull();
    expect(errorDeUbicacion({ ...base, lugar: 7, horaLocal: aValorLocal(AHORA) })).toBeNull();
  });
});

describe("el primer minuto del viaje", () => {
  // Salida a las 10:00:40; «Ahora» a las 10:00:55 se escribe como 10:00 (el campo corta al minuto).
  const salida = new Date(2026, 10, 9, 10, 0, 40).toISOString();
  const ahora = new Date(2026, 10, 9, 10, 0, 55).getTime();
  const horaLocal = aValorLocal(ahora);

  it("no avisa «posterior a la salida» por esos segundos", () => {
    expect(errorDeUbicacion({ lugar: 7, horaLocal, inicioViaje: salida, ahora })).toBeNull();
  });

  it("manda la hora de la salida, que el servidor acepta", () => {
    const c = cuerpoDeUbicacion({
      lugar: 7,
      horaLocal,
      nota: "",
      clienteUuid: "u-4",
      inicioViaje: salida,
    });
    expect(c.registrado_en).toBe(salida);
  });

  it("un minuto antes de la salida sigue siendo un error y no se toca la hora", () => {
    const antes = aValorLocal(new Date(2026, 10, 9, 9, 59, 30).getTime());
    expect(errorDeUbicacion({ lugar: 7, horaLocal: antes, inicioViaje: salida, ahora })).toMatch(
      /posterior a la salida/
    );
    const c = cuerpoDeUbicacion({
      lugar: 7,
      horaLocal: antes,
      nota: "",
      clienteUuid: "u-5",
      inicioViaje: salida,
    });
    expect(Date.parse(c.registrado_en)).toBe(new Date(2026, 10, 9, 9, 59).getTime());
  });

  it("una hora posterior a la salida no se modifica", () => {
    const despues = aValorLocal(new Date(2026, 10, 9, 10, 5).getTime());
    const c = cuerpoDeUbicacion({
      lugar: 7,
      horaLocal: despues,
      nota: "",
      clienteUuid: "u-6",
      inicioViaje: salida,
    });
    expect(Date.parse(c.registrado_en)).toBe(new Date(2026, 10, 9, 10, 5).getTime());
  });
});

describe("cuerpoDeUbicacion", () => {
  it("un lugar del catálogo va por su id, sin texto", () => {
    const c = cuerpoDeUbicacion({
      lugar: 7,
      horaLocal: aValorLocal(AHORA),
      nota: "",
      clienteUuid: "u-1",
    });
    expect(c).toMatchObject({ lugar_id: 7, cliente_uuid: "u-1" });
    expect(c).not.toHaveProperty("texto");
    expect(c).not.toHaveProperty("nota");
  });

  it("lo escrito va como texto libre, recortado, con su nota", () => {
    const c = cuerpoDeUbicacion({
      lugar: "  Km 85 de la carretera ",
      horaLocal: aValorLocal(AHORA),
      nota: " según el GPS ",
      clienteUuid: "u-2",
    });
    expect(c).toMatchObject({ texto: "Km 85 de la carretera", nota: "según el GPS" });
    expect(c).not.toHaveProperty("lugar_id");
    expect(Date.parse(c.registrado_en)).toBe(Math.floor(AHORA / 60_000) * 60_000);
  });
});

describe("haceCuanto", () => {
  it("dice «ahora» por debajo del minuto y «hace …» después", () => {
    expect(haceCuanto(new Date(AHORA - 20_000).toISOString(), AHORA)).toBe("ahora");
    expect(haceCuanto(new Date(AHORA - 2 * H).toISOString(), AHORA)).toMatch(/^hace /);
  });
});

describe("lugaresDelCatalogo", () => {
  it("pasa el id de texto de la API a número, y así el lugar se manda por su id", () => {
    // Como lo manda el servidor: el id de un BIGINT llega como texto.
    const lugares = lugaresDelCatalogo([{ id: "3782", nombre: "Huamachuco", activo: true }]);
    expect(lugares).toEqual([{ id: 3782, nombre: "Huamachuco" }]);
    const c = cuerpoDeUbicacion({
      lugar: lugares[0].id,
      horaLocal: aValorLocal(AHORA),
      nota: "",
      clienteUuid: "u-3",
    });
    expect(c).toMatchObject({ lugar_id: 3782 });
    expect(c).not.toHaveProperty("texto");
  });

  it("deja fuera los lugares inactivos y tolera una respuesta rara", () => {
    expect(
      lugaresDelCatalogo([
        { id: "1", nombre: "A", activo: false },
        { id: "2", nombre: "B" },
      ])
    ).toEqual([{ id: 2, nombre: "B" }]);
    expect(lugaresDelCatalogo(null)).toEqual([]);
    expect(lugaresDelCatalogo({ data: [] })).toEqual([]);
  });
});
