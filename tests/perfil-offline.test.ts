/** tests/perfil-offline.test.ts
 *
 * El perfil guardado para reabrir la app sin señal (client/src/offline/
 * perfilOffline.ts). Lógica pura más un localStorage de mentira: client/ no
 * tiene runner propio (mismo criterio que offline-registry.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  VIGENCIA_PERFIL_OFFLINE_MS,
  accesoSinConexion,
  actualizarPerfilDeAcceso,
  borrarPerfil,
  guardarAcceso,
  guardarPerfil,
  leerPerfil,
  perfilVigente,
} from "../client/src/offline/perfilOffline";
import type { UsuarioPayload } from "../client/src/services/authApi";

const usuario = (extra: Partial<UsuarioPayload> = {}): UsuarioPayload => ({
  id: "u1",
  tenantId: "t1",
  nombre: "Conductor Uno",
  email: null,
  rol: "conductor_ruta",
  modulosPermitidos: ["combustible"],
  debeCambiarPassword: false,
  ...extra,
});

const crudo = (u: UsuarioPayload, guardadoEn: number) => JSON.stringify({ usuario: u, guardadoEn });

describe("perfilVigente", () => {
  const ahora = 1_000_000_000_000;

  it("devuelve el usuario si está dentro de la vigencia", () => {
    expect(perfilVigente(crudo(usuario(), ahora - 1000), ahora)?.id).toBe("u1");
  });

  it("vence pasada la vigencia (7 días)", () => {
    const viejo = ahora - VIGENCIA_PERFIL_OFFLINE_MS - 1;
    expect(perfilVigente(crudo(usuario(), viejo), ahora)).toBeNull();
  });

  it("no restaura con la clave temporal sin cambiar", () => {
    expect(perfilVigente(crudo(usuario({ debeCambiarPassword: true }), ahora), ahora)).toBeNull();
  });

  it("rechaza fechas del futuro, basura y vacío", () => {
    expect(perfilVigente(crudo(usuario(), ahora + 5000), ahora)).toBeNull();
    expect(perfilVigente("no-es-json", ahora)).toBeNull();
    expect(perfilVigente(JSON.stringify({ usuario: usuario() }), ahora)).toBeNull();
    expect(perfilVigente(null, ahora)).toBeNull();
  });

  it("sirve para cualquier rol", () => {
    for (const rol of ["admin", "operador", "grifero", "lectura"] as const) {
      expect(perfilVigente(crudo(usuario({ rol }), ahora), ahora)?.rol).toBe(rol);
    }
  });
});

describe("guardar / leer / borrar", () => {
  const original = (globalThis as { localStorage?: Storage }).localStorage;

  beforeEach(() => {
    const datos = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => datos.get(k) ?? null,
      setItem: (k: string, v: string) => void datos.set(k, v),
      removeItem: (k: string) => void datos.delete(k),
    };
  });
  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = original;
  });

  it("guarda, lee y borra", () => {
    guardarPerfil(usuario());
    expect(leerPerfil()?.id).toBe("u1");
    borrarPerfil();
    expect(leerPerfil()).toBeNull();
  });

  it("un solo hueco: el siguiente usuario reemplaza al anterior", () => {
    guardarPerfil(usuario({ id: "u1" }));
    guardarPerfil(usuario({ id: "u2", tenantId: "t2" }));
    expect(leerPerfil()?.id).toBe("u2");
  });

  it("guardar a alguien con clave temporal borra lo que hubiera", () => {
    guardarPerfil(usuario());
    guardarPerfil(usuario({ id: "u3", debeCambiarPassword: true }));
    expect(leerPerfil()).toBeNull();
  });

  it("sin localStorage no revienta", () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(() => guardarPerfil(usuario())).not.toThrow();
    expect(leerPerfil()).toBeNull();
    expect(() => borrarPerfil()).not.toThrow();
  });
});

describe("acceso por clave sin conexión", () => {
  const original = (globalThis as { localStorage?: Storage }).localStorage;
  let datos: Map<string, string>;

  beforeEach(() => {
    datos = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => datos.get(k) ?? null,
      setItem: (k: string, v: string) => void datos.set(k, v),
      removeItem: (k: string) => void datos.delete(k),
    };
  });
  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = original;
  });

  it("con la clave correcta entra, con otra no, sin tope de intentos", async () => {
    await guardarAcceso("45259374", "Clave-Buena-1", usuario());
    for (let i = 0; i < 12; i++) {
      expect((await accesoSinConexion("45259374", "mala")).estado).toBe("clave");
    }
    const r = await accesoSinConexion("45259374", "Clave-Buena-1");
    expect(r.estado).toBe("ok");
    if (r.estado === "ok") expect(r.usuario.id).toBe("u1");
  });

  it("no guarda la clave en claro", async () => {
    await guardarAcceso("45259374", "Clave-Buena-1", usuario());
    const guardado = [...datos.values()].join("");
    expect(guardado).not.toContain("Clave-Buena-1");
  });

  it("el identificador no distingue mayúsculas ni espacios", async () => {
    await guardarAcceso("  Conductor@X.com ", "abc12345", usuario());
    expect((await accesoSinConexion("conductor@x.com", "abc12345")).estado).toBe("ok");
  });

  it("sin acceso guardado avisa, y vencido pide entrar con señal", async () => {
    expect((await accesoSinConexion("999", "x")).estado).toBe("sin_acceso");
    await guardarAcceso("45259374", "abc12345", usuario());
    const lejos = Date.now() + VIGENCIA_PERFIL_OFFLINE_MS + 1000;
    expect((await accesoSinConexion("45259374", "abc12345", lejos)).estado).toBe("vencido");
  });

  it("la vigencia solo la renueva un login con clave, no una confirmación por /me", async () => {
    await guardarAcceso("45259374", "abc12345", usuario());
    const clave = "erp-accesos-offline";
    const viejo = JSON.parse(datos.get(clave) as string);
    const hace6dias = Date.now() - 6 * 24 * 60 * 60 * 1000;
    viejo["45259374"][0].guardadoEn = hace6dias;
    datos.set(clave, JSON.stringify(viejo));

    guardarPerfil(usuario(), hace6dias); // restaurar sin señal
    actualizarPerfilDeAcceso(usuario()); // /me confirmó
    expect(JSON.parse(datos.get(clave) as string)["45259374"][0].guardadoEn).toBe(hace6dias);

    await guardarAcceso("45259374", "abc12345", usuario()); // login real con clave
    expect(JSON.parse(datos.get(clave) as string)["45259374"][0].guardadoEn).toBeGreaterThan(
      hace6dias
    );
  });

  it("la misma cuenta en dos empresas: abre la última confirmada; huellas distintas, ambiguo", async () => {
    await guardarAcceso(
      "ana@x.com",
      "clave-ana-1",
      usuario({ id: "p1", tenantId: "t1", email: "ana@x.com" })
    );
    actualizarPerfilDeAcceso(usuario({ id: "p2", tenantId: "t2", email: "ana@x.com" }));
    const r = await accesoSinConexion("ana@x.com", "clave-ana-1");
    expect(r.estado === "ok" && r.usuario.tenantId).toBe("t2");

    await guardarAcceso("111", "misma-clave-1", usuario({ id: "x1", tenantId: "tA" }));
    await guardarAcceso("111", "misma-clave-1", usuario({ id: "x2", tenantId: "tB" }));
    expect((await accesoSinConexion("111", "misma-clave-1")).estado).toBe("ambiguo");
  });

  it("una clave temporal borra la huella vieja de esa persona", async () => {
    await guardarAcceso("45259374", "clave-vieja-1", usuario());
    await guardarAcceso("45259374", "temporal-9", usuario({ debeCambiarPassword: true }));
    expect((await accesoSinConexion("45259374", "clave-vieja-1")).estado).toBe("sin_acceso");
  });

  it("un valor guardado con forma o iteraciones inválidas no abre nada", async () => {
    await guardarAcceso("45259374", "abc12345", usuario());
    const clave = "erp-accesos-offline";
    const m = JSON.parse(datos.get(clave) as string);
    m["45259374"][0].huella.iteraciones = 1;
    datos.set(clave, JSON.stringify(m));
    expect((await accesoSinConexion("45259374", "abc12345")).estado).toBe("sin_acceso");
    datos.set(clave, "null");
    expect((await accesoSinConexion("45259374", "abc12345")).estado).toBe("sin_acceso");
  });

  it("quien tiene la clave temporal pendiente no queda con acceso sin señal", async () => {
    await guardarAcceso("45259374", "abc12345", usuario({ debeCambiarPassword: true }));
    expect((await accesoSinConexion("45259374", "abc12345")).estado).toBe("sin_acceso");
  });
});
