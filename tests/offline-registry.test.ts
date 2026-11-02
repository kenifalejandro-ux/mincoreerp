/** tests/offline-registry.test.ts
 *
 * Vigila el punto de duplicación deliberado del Contrato de Módulo: qué
 * escrituras participan del offline se declara DOS veces (una en el
 * registry del backend, otra en el del cliente, porque son dos builds
 * separados — ver client/src/modules/registry.tsx).
 *
 * Que diverjan no rompe nada visible: simplemente el cliente encolaría una
 * ruta que el servidor NO atiende con idempotentInsert(), y el reintento
 * crearía un duplicado. Es exactamente la clase de fallo silencioso que el
 * ADR-0002 vino a eliminar cuando "qué módulos existen" eran 5 listas
 * sueltas — así que se prueba igual que aquello (tests/module-registry.test.ts).
 *
 * Vive en tests/ y no en client/ por el mismo motivo que
 * sentry-frontend-filter.test.ts: client/ no tiene runner propio, y esto
 * es lógica pura sin DOM ni import.meta.env.
 */
import { describe, it, expect } from "vitest";

import { MODULOS } from "../src/modules/registry";
import { ESCRITURAS_OFFLINE, RUTA_DE_MODULO } from "../client/src/modules/offlineRegistry";
import { moduloParaEncolar, rutasOfflineDeclaradas } from "../client/src/offline/rutasOffline";

describe("declaración de offline: backend vs cliente", () => {
  it("los dos registries declaran exactamente las mismas escrituras offline", () => {
    const delBackend = MODULOS.flatMap((m) =>
      (m.offline?.escrituras ?? []).map((e) => `${e.metodo} /${m.ruta ?? m.id}${e.ruta}`)
    ).sort();

    const delCliente = Object.entries(ESCRITURAS_OFFLINE)
      .flatMap(([id, escrituras]) =>
        escrituras.map((e) => `${e.metodo} /${RUTA_DE_MODULO[id] ?? id}${e.ruta}`)
      )
      .sort();

    expect(delCliente).toEqual(delBackend);
  });

  it("todo módulo con offline declarado existe en el registry del backend", () => {
    const idsBackend = new Set(MODULOS.map((m) => m.id));
    for (const ruta of rutasOfflineDeclaradas()) {
      expect(idsBackend).toContain(ruta.moduloId);
    }
  });
});

describe("qué se encola y qué no", () => {
  it("encola el POST de crear checklist", () => {
    expect(moduloParaEncolar("/api/erp/checklists", "POST")).toBe("checklists");
  });

  it("encola el POST de crear IPERC", () => {
    expect(moduloParaEncolar("/api/erp/iperc", "POST")).toBe("iperc");
  });

  it("ignora el query string y la barra final", () => {
    expect(moduloParaEncolar("/api/erp/checklists/", "POST")).toBe("checklists");
    expect(moduloParaEncolar("/api/erp/checklists?pageSize=50", "POST")).toBe("checklists");
  });

  it("NO encola lecturas: un GET sin red debe fallar, no quedar pendiente", () => {
    expect(moduloParaEncolar("/api/erp/checklists", "GET")).toBeNull();
  });

  it("NO encola el DELETE de un checklist ni el de una plantilla", () => {
    // Reintentar un borrado a ciegas puede eliminar algo que se recreó
    // entre medio; y las plantillas son configuración de oficina, no
    // trabajo de campo.
    expect(moduloParaEncolar("/api/erp/checklists/12", "DELETE")).toBeNull();
    expect(moduloParaEncolar("/api/erp/checklists/plantillas/3", "DELETE")).toBeNull();
    expect(moduloParaEncolar("/api/erp/checklists/plantillas", "POST")).toBeNull();
  });

  it("encola el POST de registrar una lectura de combustible", () => {
    expect(moduloParaEncolar("/api/erp/combustible/lecturas", "POST")).toBe("combustible");
  });

  it("NO encola el PUT /:id/nivel legacy: rutasOffline.ts no matchea parámetros de URL", () => {
    // combustible_id viaja en el body del endpoint nuevo justo para evitar
    // esto -- el motor offline solo compara rutas literales.
    expect(moduloParaEncolar("/api/erp/combustible/7/nivel", "PUT")).toBeNull();
  });

  it("NO encola módulos que todavía no declararon offline", () => {
    // dashboard no tiene tablas propias ni escrituras -- no va a declarar
    // offline nunca, buen caso estable para esta aserción.
    expect(moduloParaEncolar("/api/erp/dashboard", "POST")).toBeNull();
  });

  it("encola el POST de dar de alta un equipo", () => {
    expect(moduloParaEncolar("/api/erp/equipos", "POST")).toBe("flota");
  });

  it("NO encola editar ni eliminar un equipo", () => {
    // Editar sobreescribe campos existentes y eliminar no debe reintentarse
    // a ciegas -- mismo criterio que el resto de los módulos.
    expect(moduloParaEncolar("/api/erp/equipos/12", "PUT")).toBeNull();
    expect(moduloParaEncolar("/api/erp/equipos/12", "DELETE")).toBeNull();
  });

  it("NO encola aprobar/rechazar un IPERC ni crear una línea base", () => {
    // Las transiciones de estado no califican: el 409 anti-carrera del
    // backend (ver fix_race_condition_iperc_estado) haría que un reintento
    // tardío se descarte igual, y aprobar con datos de hace horas no es lo
    // mismo que crear un registro. Las líneas base son catálogo de
    // oficina, mismo criterio que las plantillas de checklists.
    expect(moduloParaEncolar("/api/erp/iperc/5/estado", "PATCH")).toBeNull();
    expect(moduloParaEncolar("/api/erp/iperc/lineas-base/5/estado", "PATCH")).toBeNull();
    expect(moduloParaEncolar("/api/erp/iperc/lineas-base", "POST")).toBeNull();
  });

  it("NO encola nada de autenticación", () => {
    // Un login o un refresh reintentado horas después no tiene sentido, y
    // el refresh además revoca la sesión si se reusa (auth.service.ts).
    expect(moduloParaEncolar("/api/auth/login", "POST")).toBeNull();
    expect(moduloParaEncolar("/api/auth/refresh", "POST")).toBeNull();
  });

  it("una URL absoluta del mismo endpoint matchea igual que la relativa", () => {
    expect(moduloParaEncolar("https://erp.example.com/api/erp/checklists", "POST")).toBe(
      "checklists"
    );
  });

  it("encola el POST de crear un documento", () => {
    expect(moduloParaEncolar("/api/erp/documentos", "POST")).toBe("documentos");
  });

  it("encola subir el archivo adjunto de un documento, con id real en la URL", () => {
    // /:id/versiones usa el comodín de segmentosCoinciden -- distintos ids
    // concretos deben matchear igual, ver rutasOffline.ts.
    expect(moduloParaEncolar("/api/erp/documentos/307/versiones", "POST")).toBe("documentos");
    expect(moduloParaEncolar("/api/erp/documentos/1/versiones", "POST")).toBe("documentos");
  });

  it("NO encola editar un documento, la carga masiva, ni listar/descargar versiones", () => {
    // Editar sobreescribe campos existentes, el bulk es un array grande de
    // oficina, y listar/descargar son lecturas -- ver ADR-0002 §8.
    expect(moduloParaEncolar("/api/erp/documentos/307", "PUT")).toBeNull();
    expect(moduloParaEncolar("/api/erp/documentos/bulk", "POST")).toBeNull();
    expect(moduloParaEncolar("/api/erp/documentos/307/versiones", "GET")).toBeNull();
    expect(moduloParaEncolar("/api/erp/documentos/307/versiones/5/descarga", "GET")).toBeNull();
  });
});
