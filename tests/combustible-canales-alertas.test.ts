/** tests/combustible-canales-alertas.test.ts
 *
 * Entrega 2 de la Bandeja: qué alertas interrumpen por correo AL MOMENTO y
 * cuáles esperan al resumen diario (src/modules/combustible/canalesAlertas.ts).
 *
 * Sin base: el catálogo, el filtro único del archivo de correos y el armado
 * del texto del resumen. El resumen con base y alcance está en
 * tests/combustible-resumen-diario-alertas.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

const enviados = vi.hoisted(() => [] as { asunto: string }[]);
vi.mock("../src/server/shared/utils/alertaMailer", () => ({
  enviarCorreoAlerta: vi.fn(async (a: { asunto: string }) => {
    enviados.push({ asunto: a.asunto });
  }),
}));

import { TIPOS_ALERTA } from "../src/modules/combustible/combustible.repository";
import {
  CATALOGO_ALERTAS,
  canalDeFila,
  vaAlMomento,
} from "../src/modules/combustible/canalesAlertas";
import {
  enviarCorreoAlertaHueco,
  enviarCorreoAlertaNivelBajo,
  enviarCorreoDespachoTardio,
  enviarCorreoDiferenciaRecepcion,
  enviarCorreoLecturaAnulada,
  enviarCorreoTanquetaSobregirada,
  enviarCorreoValeFueraDeOrden,
  enviarCorreoVigilanciaReducida,
} from "../src/modules/combustible/combustibleAlertas.mailer";
import {
  armarCorreoDeResumen,
  diaYHoraEnLima,
} from "../src/server/services/combustibleResumenAlertas.worker";

const A = [{ email: "a@real.pe", nombre: "A" }];

describe("catálogo de canales", () => {
  it("todo tipo de alerta tiene canal, y el catálogo no inventa tipos", () => {
    expect(Object.keys(CATALOGO_ALERTAS).sort()).toEqual([...TIPOS_ALERTA].sort());
  });

  it("el reparto decidido con Kenif: 26 al momento, 17 al resumen, 2 solo en el ERP", () => {
    const cuenta = (canal: string) =>
      Object.values(CATALOGO_ALERTAS).filter((c) => c.canal === canal).length;
    // 25: se sumó urea_litros_corregidos (0130); 26: urea_conteo_alterado
    // (0132). Los dos al momento. 17 al resumen: se sumó compra_ruta_descuadre
    // (0136), la boleta de una compra en ruta que no cuadra.
    expect(cuenta("al_momento")).toBe(26);
    expect(cuenta("resumen")).toBe(17);
    expect(cuenta("solo_erp")).toBe(2);
  });

  it("los avisos de configuración salen al momento; un tipo desconocido va al resumen", () => {
    expect(vaAlMomento("aviso_configuracion")).toBe(true);
    expect(canalDeFila("tipo_que_no_existe")).toBe("resumen");
  });
});

describe("el filtro está en UN solo lugar del archivo de correos", () => {
  it("ningún correo de combustible llama a enviarCorreoAlerta saltándose el canal", () => {
    const codigo = readFileSync("src/modules/combustible/combustibleAlertas.mailer.ts", "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l))
      .join("\n");
    // La única llamada es la de `avisar`, que consulta el catálogo.
    expect(codigo.match(/enviarCorreoAlerta\(/g)).toHaveLength(1);
    expect(codigo).toMatch(
      /if \(!vaAlMomento\(tipo\)\) return;\s*await enviarCorreoAlerta\(params\)/
    );
  });
});

describe("qué sale al momento", () => {
  beforeEach(() => {
    enviados.length = 0;
  });

  it("lo grave sale: hueco, nivel bajo, varilla anulada y vigilancia reducida", async () => {
    await enviarCorreoAlertaHueco(A, {
      serieTalonario: "A",
      valesFaltantes: [3],
      nValeQueLoRevelo: 4,
    });
    await enviarCorreoAlertaNivelBajo(A, {
      tanqueNombre: "T1",
      nivel: 10,
      nivelMinimo: 100,
      unidad: "L",
    });
    await enviarCorreoLecturaAnulada(A, {
      tanqueNombre: "T1",
      unidad: "L",
      nivel: 500,
      leidoEn: "2026-10-12T12:00:00Z",
      anuladaPor: "Grifero 1",
      motivo: "mal tipeada",
    });
    await enviarCorreoVigilanciaReducida(A, {
      quien: "Admin",
      objeto: "T1",
      motivo: "prueba",
      cambios: [{ control: "Tope diario", de: "200 L", a: "sin tope" }],
    });
    expect(enviados.map((e) => e.asunto)).toEqual([
      expect.stringContaining("hueco"),
      expect.stringContaining("nivel bajo"),
      expect.stringContaining("anuló una varilla de T1"),
      expect.stringContaining("vigilancia"),
    ]);
  });

  it("lo que espera al resumen NO sale: los cuatro correos del PR 2", async () => {
    await enviarCorreoValeFueraDeOrden(A, { serieTalonario: "A", nVale: 7 } as never);
    await enviarCorreoDespachoTardio(A, { serieTalonario: "A", nVale: 7 } as never);
    await enviarCorreoTanquetaSobregirada(A, { tanqueta: "TQ" } as never);
    await enviarCorreoDiferenciaRecepcion(A, [] as never);
    expect(enviados).toEqual([]);
  });
});

describe("hora de Lima", () => {
  it("las 11:59 UTC son las 6:59 en Lima; las 12:00 UTC, las 7:00", () => {
    expect(diaYHoraEnLima(new Date("2026-10-12T11:59:00Z"))).toEqual({
      fecha: "2026-10-12",
      hora: 6,
    });
    expect(diaYHoraEnLima(new Date("2026-10-12T12:00:00Z"))).toEqual({
      fecha: "2026-10-12",
      hora: 7,
    });
  });

  it("las 3:00 UTC del 13 todavía son el 12 en Lima", () => {
    expect(diaYHoraEnLima(new Date("2026-10-13T03:00:00Z")).fecha).toBe("2026-10-12");
  });
});

describe("el texto del resumen", () => {
  const fila = (tipo: string, nuevas: number, pendientes: number, vencidas = 0) => ({
    tipo,
    nuevas,
    pendientes,
    vencidas,
  });

  it("sin nada nuevo ni pendiente, no hay correo", () => {
    expect(armarCorreoDeResumen([], "2026-10-12", "https://erp")).toBeNull();
  });

  it("las 'solo en el ERP' no cuentan: una persona que solo tiene esas no recibe nada", () => {
    expect(
      armarCorreoDeResumen(
        [fila("equipo_de_otro_grifo", 3, 3, 1), fila("historial_sin_contrastar", 1, 1)],
        "2026-10-12",
        "https://erp"
      )
    ).toBeNull();
  });

  it("separa lo nuevo para revisar, lo grave ya avisado y lo vencido", () => {
    const c = armarCorreoDeResumen(
      [
        fila("despacho_tardio", 2, 2),
        fila("hueco_detectado", 1, 1),
        fila("tanque_sin_medir", 0, 1, 1),
      ],
      "2026-10-12",
      "https://erp.ejemplo"
    )!;
    expect(c.asunto).toContain("12/10/2026");
    expect(c.asunto).toContain("2 nueva(s) para revisar, 4 sin resolver");
    const texto = c.lineas.join("\n");
    expect(texto).toContain("Nuevas para revisar (no se avisaron por correo): 2");
    expect(texto).toContain("• Vale que llegó tarde: 2");
    // El hueco ya salió al momento: se cuenta, pero no se lista como "para revisar".
    expect(texto.slice(0, texto.indexOf("Sin resolver en total"))).not.toContain(
      "• Hueco en talonario"
    );
    // ...pero sí figura entre lo pendiente: hasta que llegue el vale, sigue abierto.
    expect(texto.slice(texto.indexOf("Sin resolver en total"))).toContain(
      "• Hueco en talonario: 1"
    );
    expect(texto).toContain("Además hubo 1 alerta(s) grave(s)");
    expect(texto).not.toContain("ya te llegaron");
    expect(texto).toContain("Sin resolver en total: 4");
    // Lo pendiente se desglosa por tipo, aunque no sea nuevo ni esté vencido.
    expect(texto).toContain("• Vale que llegó tarde: 2");
    expect(texto).toContain("Llevan más de 2 días sin resolver: 1");
    expect(texto).toContain("• Tanque sin medir: 1");
    expect(texto).toContain("https://erp.ejemplo");
  });

  it("lo pendiente se lista por tipo: un control apagado no es solo un número", () => {
    const c = armarCorreoDeResumen(
      [fila("tanque_sin_medir", 0, 2), fila("tanque_sin_vigilancia", 0, 1)],
      "2026-10-12",
      "https://erp"
    )!;
    const texto = c.lineas.join("\n");
    expect(texto).toContain("Sin resolver en total: 3");
    expect(texto).toContain("• Tanque sin medir: 2");
    expect(texto).toContain("• Tanque despachando sin vigilancia: 1");
  });

  it("con más de 10 tipos pendientes, lista 10 y resume el resto", () => {
    const tipos = Object.keys(CATALOGO_ALERTAS)
      .filter((t) => CATALOGO_ALERTAS[t as keyof typeof CATALOGO_ALERTAS].canal !== "solo_erp")
      .slice(0, 13);
    const c = armarCorreoDeResumen(
      tipos.map((t) => fila(t, 0, 1)),
      "2026-10-12",
      "https://erp"
    )!;
    expect(c.lineas.filter((l) => l.startsWith("• ") && !l.includes("tipo(s)"))).toHaveLength(10);
    expect(c.lineas).toContain("• y 3 tipo(s) más, en la Bandeja");
  });

  it("un día sin novedades pero con pendientes igual avisa, y lo dice", () => {
    const c = armarCorreoDeResumen([fila("tanque_sin_medir", 0, 1)], "2026-10-12", "https://erp")!;
    expect(c.lineas[0]).toBe("No hubo alertas nuevas para revisar desde el resumen anterior.");
    expect(c.lineas.join("\n")).toContain("Sin resolver en total: 1");
  });
});
