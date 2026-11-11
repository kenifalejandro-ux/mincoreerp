/** tests/control-tv-gravedad.test.ts
 *
 * La gravedad de una alerta en la vista de una unidad (Crítica, Media, Info) sale de las mismas reglas
 * que la campanita: crítica si va por correo al momento o es urgente; media si va en el resumen del
 * día; info si es solo un aviso en el ERP.
 */
import { describe, it, expect } from "vitest";
import { CATALOGO_ALERTAS, TIPOS_CRITICOS } from "../src/modules/combustible/canalesAlertas";
import { gravedadDeAlerta } from "../src/modules/combustible/controlTvUnidad.service";

describe("gravedadDeAlerta", () => {
  it("lo que la campanita pinta como crítico es crítico: unidad detenida y viaje demorado", () => {
    expect(gravedadDeAlerta("viaje_detenido")).toBe("critica");
    expect(gravedadDeAlerta("viaje_demorado")).toBe("critica");
    expect(gravedadDeAlerta("sobredespacho")).toBe("critica");
  });

  it("todo tipo crítico del catálogo sale crítico, y solo esos", () => {
    for (const t of Object.keys(CATALOGO_ALERTAS)) {
      const esperado = (TIPOS_CRITICOS as readonly string[]).includes(t) ? "critica" : null;
      if (esperado) expect(gravedadDeAlerta(t), t).toBe("critica");
      else expect(gravedadDeAlerta(t), t).not.toBe("critica");
    }
  });

  it("las del resumen del día son media y las que solo avisan en el ERP son info", () => {
    expect(gravedadDeAlerta("comprobante_sin_foto")).toBe("media");
    expect(gravedadDeAlerta("recepcion_sin_validar")).toBe("media");
    expect(gravedadDeAlerta("equipo_de_otro_grifo")).toBe("info");
    expect(gravedadDeAlerta("viaje_creado_por_conductor")).toBe("info");
  });

  it("un tipo que el catálogo no conoce no se pierde: va como media, nunca crítico", () => {
    expect(gravedadDeAlerta("tipo_retirado_o_nuevo")).toBe("media");
  });

  it("siempre devuelve una de las tres gravedades", () => {
    for (const t of Object.keys(CATALOGO_ALERTAS)) {
      expect(["critica", "media", "info"]).toContain(gravedadDeAlerta(t));
    }
  });
});
