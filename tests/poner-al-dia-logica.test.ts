/** tests/poner-al-dia-logica.test.ts
 *
 * La lógica pura de «Poner al día»: qué marcas le faltan a un viaje, qué hora ponen los atajos, qué
 * se avisa antes de guardar y el cuerpo que se manda al servidor. Con datos sueltos, sin pantalla.
 */
import { describe, it, expect } from "vitest";
import {
  aValorLocal,
  armarAcciones,
  deValorLocal,
  evaluar,
  horaDeAtajo,
  marcasQueFaltan,
  textoDeGuardar,
  ultimaMarcaHecha,
  type DescansoPorPoner,
  type EntradaDeEvaluar,
  type MarcaPorPoner,
} from "../client/src/components/combustible/ponerAlDiaLogica";
import type { ParadaMia } from "../client/src/components/combustible/paradasViaje";

const H = 3_600_000;
const AHORA = new Date(2026, 10, 5, 22, 43).getTime();
const hace = (horas: number) => AHORA - horas * H;
const valor = (horas: number) => aValorLocal(hace(horas));

/** A → B → A que salió de A hace 30 h; lo demás sin marcar. */
const paradasSinMarcar = (): ParadaMia[] => [
  {
    orden: 0,
    lugar_id: 1,
    lugar: "A",
    llegada_en: null,
    llegada_medidor: null,
    salida_en: new Date(hace(30)).toISOString(),
    salida_medidor: null,
  },
  {
    orden: 1,
    lugar_id: 2,
    lugar: "B",
    llegada_en: null,
    llegada_medidor: null,
    salida_en: null,
    salida_medidor: null,
  },
  {
    orden: 2,
    lugar_id: 1,
    lugar: "A",
    llegada_en: null,
    llegada_medidor: null,
    salida_en: null,
    salida_medidor: null,
  },
];

const entrada = (
  marcas: MarcaPorPoner[],
  extra: Partial<EntradaDeEvaluar> = {}
): EntradaDeEvaluar => ({
  marcas,
  descansos: [],
  ultimaHecha: hace(30),
  inicioViaje: hace(30),
  exigeMedidorFinal: false,
  ahora: AHORA,
  motivo: "no se marcó a tiempo",
  ...extra,
});

const conHoras = (...horas: (number | null)[]): MarcaPorPoner[] =>
  marcasQueFaltan(paradasSinMarcar()).map((m, i) => ({
    ...m,
    en: horas[i] === null || horas[i] === undefined ? "" : valor(horas[i] as number),
  }));

describe("poner al día: qué marcas faltan", () => {
  it("un viaje que solo salió debe la llegada y la salida de cada parada, y la llegada final", () => {
    const m = marcasQueFaltan(paradasSinMarcar());
    expect(m.map((x) => x.clave)).toEqual(["llegada-1", "salida-1", "llegada-2"]);
    expect(m.map((x) => x.texto)).toEqual([
      "Llegada a B",
      "Salida de B hacia A",
      "Llegada a A (termina el viaje)",
    ]);
    expect(m.map((x) => x.cierra)).toEqual([false, false, true]);
    expect(m.map((x) => x.orden)).toEqual([1, 1, 2]);
  });

  it("lo que ya está marcado no se pide otra vez", () => {
    const p = paradasSinMarcar();
    p[1].llegada_en = new Date(hace(20)).toISOString();
    expect(marcasQueFaltan(p).map((x) => x.clave)).toEqual(["salida-1", "llegada-2"]);
    expect(ultimaMarcaHecha(p)).toBe(hace(20));
  });

  it("sin paradas no falta nada", () => {
    expect(marcasQueFaltan(null)).toEqual([]);
    expect(ultimaMarcaHecha(undefined)).toBeNull();
  });
});

describe("poner al día: atajos de hora", () => {
  it("«Ahora» y «Hace N h» parten de la hora de ahora, al minuto", () => {
    const aMinuto = (ms: number) => Math.floor(ms / 60_000) * 60_000;
    expect(deValorLocal(horaDeAtajo("ahora", AHORA, null) as string)).toBe(aMinuto(AHORA));
    expect(deValorLocal(horaDeAtajo("hace1h", AHORA, null) as string)).toBe(aMinuto(hace(1)));
    expect(deValorLocal(horaDeAtajo("hace6h", AHORA, null) as string)).toBe(aMinuto(hace(6)));
  });

  it("«+8 h» cuenta desde la marca anterior y no pasa de ahora; sin anterior no hay de dónde", () => {
    expect(deValorLocal(horaDeAtajo("mas8h", AHORA, hace(30)) as string)).toBe(hace(22));
    const casi = deValorLocal(horaDeAtajo("mas8h", AHORA, hace(2)) as string) as number;
    expect(casi).toBeLessThanOrEqual(AHORA);
    expect(horaDeAtajo("mas8h", AHORA, null)).toBeNull();
  });
});

describe("poner al día: qué se avisa antes de guardar", () => {
  it("todo en orden: se puede guardar y la llegada final cierra el viaje", () => {
    const ev = evaluar(entrada(conHoras(20, 18, 4)));
    expect(ev.pie).toBeNull();
    expect(ev.marcasListas).toBe(3);
    expect(ev.cierraElViaje).toBe(true);
    expect(textoDeGuardar(ev)).toBe("Guardar 3 marcas y cerrar el viaje");
  });

  it("se puede guardar solo las primeras: lo vacío no es un error", () => {
    const ev = evaluar(entrada(conHoras(20, null, null)));
    expect(ev.pie).toBeNull();
    expect(ev.marcasListas).toBe(1);
    expect(ev.cierraElViaje).toBe(false);
    expect(textoDeGuardar(ev)).toBe("Guardar 1 marca");
  });

  it("no deja llenar una marca sin la de antes", () => {
    const ev = evaluar(entrada(conHoras(null, 18, null)));
    expect(ev.errorMarca[1]).toMatch(/Llena primero/);
    expect(ev.pie).toBe("Corrige lo marcado en rojo.");
  });

  it("cada hora es posterior a la anterior y no es futura", () => {
    // La llegada a B antes de la salida del viaje (hace 30 h).
    expect(evaluar(entrada(conHoras(40))).errorMarca[0]).toMatch(/Tiene que ser después de/);
    // La salida de B antes de la llegada a B.
    expect(evaluar(entrada(conHoras(20, 25))).errorMarca[1]).toMatch(/Tiene que ser después de/);
    // En el futuro.
    expect(evaluar(entrada(conHoras(-2))).errorMarca[0]).toBe("No puede ser en el futuro.");
  });

  it("pide el motivo, y al menos una cosa que guardar", () => {
    expect(evaluar(entrada(conHoras(20), { motivo: "ab" })).pie).toMatch(/motivo/);
    expect(evaluar(entrada(conHoras(null, null, null))).pie).toMatch(/al menos una/);
  });

  it("la llegada final pide el medidor si el viaje salió con uno; las demás no", () => {
    const sin = evaluar(entrada(conHoras(20, 18, 4), { exigeMedidorFinal: true }));
    expect(sin.errorMarca[2]).toMatch(/medidor/);
    expect(sin.errorMarca[0]).toBeNull();
    const marcas = conHoras(20, 18, 4);
    marcas[2].medidor = "160";
    expect(evaluar(entrada(marcas, { exigeMedidorFinal: true })).pie).toBeNull();
  });

  it("un medidor que no es número se avisa", () => {
    const marcas = conHoras(20);
    marcas[0].medidor = "abc";
    expect(evaluar(entrada(marcas)).errorMarca[0]).toMatch(/número/);
  });
});

describe("poner al día: descansos", () => {
  const descanso = (extra: Partial<DescansoPorPoner> = {}): DescansoPorPoner => ({
    clave: 1,
    motivo: "Dormir",
    otro: "",
    desde: valor(15),
    hasta: valor(10),
    ...extra,
  });

  it("un descanso completo cuenta y entra en el texto del botón", () => {
    const ev = evaluar(entrada(conHoras(20, null, null), { descansos: [descanso()] }));
    expect(ev.pie).toBeNull();
    expect(ev.descansosListos).toBe(1);
    expect(textoDeGuardar(ev)).toBe("Guardar 1 marca y 1 descanso");
  });

  it("avisa lo que falta o está mal", () => {
    const dd = (d: Partial<DescansoPorPoner>) =>
      evaluar(entrada(conHoras(null, null, null), { descansos: [descanso(d)] })).errorDescanso[0];
    expect(dd({ desde: "" })).toBe("Falta desde cuándo.");
    expect(dd({ motivo: "Otro", otro: "" })).toBe("Escribe el motivo.");
    expect(dd({ desde: valor(40), hasta: valor(35) })).toMatch(/después de la salida del viaje/);
    expect(dd({ desde: valor(-1) })).toMatch(/futuro/);
    expect(dd({ desde: valor(10), hasta: valor(12) })).toMatch(/después del inicio/);
  });

  it("un descanso sin fin no puede tener marcas después", () => {
    const ev = evaluar(
      entrada(conHoras(5), { descansos: [descanso({ desde: valor(15), hasta: "" })] })
    );
    expect(ev.errorDescanso[0]).toMatch(/sigue abierto/);
    const despues = evaluar(
      entrada(conHoras(20), { descansos: [descanso({ desde: valor(15), hasta: "" })] })
    );
    expect(despues.errorDescanso[0]).toBeNull();
  });
});

describe("poner al día: lo que se manda", () => {
  it("las marcas listas y los descansos listos, con la hora en ISO y el medidor solo si se escribió", () => {
    const marcas = conHoras(20, 18, null);
    marcas[0].medidor = "150,5";
    const descansos: DescansoPorPoner[] = [
      { clave: 7, motivo: "Tráfico", otro: "obras", desde: valor(15), hasta: valor(14) },
    ];
    const ev = evaluar(entrada(marcas, { descansos }));
    const { acciones, origenes } = armarAcciones(marcas, descansos, ev);
    expect(acciones).toEqual([
      {
        tipo: "llegada",
        en: new Date(deValorLocal(valor(20)) as number).toISOString(),
        orden: 1,
        medidor: 150.5,
      },
      { tipo: "salida", en: new Date(deValorLocal(valor(18)) as number).toISOString(), orden: 1 },
      {
        tipo: "descanso",
        motivo: "Tráfico · obras",
        desde: new Date(deValorLocal(valor(15)) as number).toISOString(),
        hasta: new Date(deValorLocal(valor(14)) as number).toISOString(),
      },
    ]);
    expect(origenes).toEqual([
      { tipo: "marca", clave: "llegada-1" },
      { tipo: "marca", clave: "salida-1" },
      { tipo: "descanso", clave: 7 },
    ]);
  });

  it("lo vacío o con error no se manda", () => {
    const marcas = conHoras(20, null, null);
    const ev = evaluar(entrada(marcas));
    expect(armarAcciones(marcas, [], ev).acciones).toHaveLength(1);
  });
});
