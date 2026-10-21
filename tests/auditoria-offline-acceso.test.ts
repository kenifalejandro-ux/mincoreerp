/** tests/auditoria-offline-acceso.test.ts
 *
 * Auditoría adversaria del acceso sin conexión (perfilOffline / claveOffline /
 * sesionOffline). CADA test de este archivo describe el comportamiento que
 * debería tener el sistema y FALLA hoy: demuestra un hallazgo del informe.
 * No modifica código de producción.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { crearHuella } from "../client/src/offline/claveOffline";
import {
  accesoSinConexion,
  guardarAcceso,
  guardarPerfil,
} from "../client/src/offline/perfilOffline";
import { alinearCacheConTenant } from "../client/src/offline/sesionOffline";
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
  vi.useRealTimers();
});

const ACCESOS = "erp-accesos-offline";

describe("H1 — la huella no se reconcilia con lo que el servidor decidió", () => {
  it("tras una clave temporal (reset de admin) la clave VIEJA ya no abre el acceso sin conexión", async () => {
    // Día 0: la persona entra con red con su clave de siempre.
    await guardarAcceso("45259374", "clave-vieja-1", usuario());
    // Un admin le resetea la clave (puede ser porque se filtró). La persona entra
    // con red con la clave temporal: LoginPage llama guardarAcceso(...) con
    // debeCambiarPassword = true.
    await guardarAcceso("45259374", "temporal-9", usuario({ debeCambiarPassword: true }));
    // Pone su clave nueva: App.tsx hace login({...usuario, debeCambiarPassword:false})
    // -> guardarPerfil, que RENUEVA el acceso (renovarAcceso) sin tocar la huella.
    guardarPerfil(usuario({ debeCambiarPassword: false }));

    const r = await accesoSinConexion("45259374", "clave-vieja-1");
    expect(r.estado).not.toBe("ok");
  });

  it("la huella vieja tampoco debe sobrevivir 6 días renovándose con cada confirmación del servidor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    await guardarAcceso("45259374", "clave-vieja-1", usuario());
    // El servidor cambió la clave desde otro equipo; acá solo se ve un /me OK
    // (cookie aún válida) cada 6 días -> el plazo de 7 días nunca vence.
    for (let d = 6; d <= 30; d += 6) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 1 + d, 10)));
      guardarPerfil(usuario());
    }
    const r = await accesoSinConexion("45259374", "clave-vieja-1", Date.now());
    // 30 días después de la última vez que ESA clave pasó por el servidor.
    expect(r.estado).not.toBe("ok");
  });
});

describe("H2 — la llave del mapa es solo el identificador", () => {
  it("el mismo DNI con dos claves en dos empresas (portal único): ambas deben seguir entrando", async () => {
    // El servidor lo permite: loginConDni elige el perfil por la clave que sirva.
    await guardarAcceso("45259374", "clave-empresa-A", usuario({ id: "uA", tenantId: "tA" }));
    await guardarAcceso("45259374", "clave-empresa-B", usuario({ id: "uB", tenantId: "tB" }));

    const a = await accesoSinConexion("45259374", "clave-empresa-A");
    expect(a.estado).toBe("ok");
    if (a.estado === "ok") expect(a.usuario.tenantId).toBe("tA");
  });

  it("tras cambiar de empresa en sesión, el acceso sin conexión debe abrir la ÚLTIMA empresa confirmada", async () => {
    await guardarAcceso(
      "ana@x.com",
      "clave-ana-1",
      usuario({ id: "perfil-t1", tenantId: "t1", email: "ana@x.com" })
    );
    // SelectorEmpresa -> cambiarEmpresaApi -> reload -> /me devuelve el perfil de t2
    // (id de perfil distinto): guardarPerfil -> renovarAcceso busca por id y no
    // encuentra ninguna entrada de t2.
    guardarPerfil(usuario({ id: "perfil-t2", tenantId: "t2", email: "ana@x.com" }));

    const r = await accesoSinConexion("ana@x.com", "clave-ana-1");
    expect(r.estado).toBe("ok");
    if (r.estado === "ok") expect(r.usuario.tenantId).toBe("t2");
  });
});

describe("H3 — localStorage corrupto rompe el acceso sin conexión", () => {
  it("un mapa 'null' no debe hacer reventar accesoSinConexion", async () => {
    datos.set(ACCESOS, "null");
    await expect(accesoSinConexion("45259374", "x")).resolves.toMatchObject({
      estado: "sin_acceso",
    });
  });

  it("y guardarAcceso debe poder repararlo en el siguiente login con red", async () => {
    datos.set(ACCESOS, "null");
    await guardarAcceso("45259374", "clave-buena-1", usuario());
    const r = await accesoSinConexion("45259374", "clave-buena-1");
    expect(r.estado).toBe("ok");
  });
});

describe("H4 — la entrada guardada se confía entera (sin integridad)", () => {
  // NOTA (hallazgo 7, aceptado): editar el rol guardado solo cambia lo que ESTE
  // navegador muestra. El servidor valida cada escritura con la sesión real, así
  // que no cruza ninguna frontera de permisos; no se puede probar integridad
  // local sin un secreto que el atacante, dueño del equipo, no pueda recalcular.

  it("iteraciones=1 en el JSON guardado: una huella forjada sin conocer la clave real NO debe entrar", async () => {
    await guardarAcceso("45259374", "clave-real-9", usuario());
    const mapa = JSON.parse(datos.get(ACCESOS)!);
    // El atacante calcula SU hash con 1 iteración y lo escribe: no necesita la clave real.
    const sal = Uint8Array.from(atob(mapa["45259374"][0].huella.sal), (c) => c.charCodeAt(0));
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("la-que-yo-quiera"),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: 1 },
        material,
        256
      )
    );
    mapa["45259374"][0].huella.hash = btoa(String.fromCharCode(...bits));
    mapa["45259374"][0].huella.iteraciones = 1;
    datos.set(ACCESOS, JSON.stringify(mapa));

    const r = await accesoSinConexion("45259374", "la-que-yo-quiera");
    expect(r.estado).not.toBe("ok");
  });

  it("iteraciones enormes en el JSON no deben colgar el login (DoS local)", async () => {
    await guardarAcceso("45259374", "clave-real-9", usuario());
    const mapa = JSON.parse(datos.get(ACCESOS)!);
    mapa["45259374"][0].huella.iteraciones = 4_000_000; // ~5 s de CPU; con 2^31 son horas
    datos.set(ACCESOS, JSON.stringify(mapa));

    const t0 = Date.now();
    const r = await Promise.race([
      accesoSinConexion("45259374", "x"),
      new Promise<"colgado">((res) => setTimeout(() => res("colgado"), 1500)),
    ]);
    expect(r).not.toBe("colgado");
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 20000);
});

describe("H5 — costo por intento de la huella", () => {
  it("PBKDF2-SHA256 debe usar al menos 600.000 iteraciones (OWASP 2023); con claves de 8 caracteres sin complejidad y sin tope de intentos, 310.000 es poco", async () => {
    const h = await crearHuella("cualquiera");
    expect(h.iteraciones).toBeGreaterThanOrEqual(600_000);
  });
});

describe("H6 — la marca de tenant se escribe aunque la limpieza no haya terminado", () => {
  function instalarCaches(entradas: Map<string, string[]>, colgarKeys: boolean) {
    (globalThis as { caches?: unknown }).caches = {
      keys: () =>
        colgarKeys ? new Promise<string[]>(() => {}) : Promise.resolve([...entradas.keys()]),
      delete: async (n: string) => entradas.delete(n),
    };
  }

  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });

  it("si CacheStorage no responde dentro del plazo, NO se debe dar el caché por alineado con el tenant nuevo", async () => {
    vi.useFakeTimers();
    const cache = new Map([["erp-catalogos-v1", ["equipos de la empresa A"]]]);
    instalarCaches(cache, true);
    datos.set("erp-cache-tenant", "tenant-A");

    const p = alinearCacheConTenant("tenant-B");
    await vi.advanceTimersByTimeAsync(11_000);
    await p;

    // Hoy: marca = tenant-B, y el caché de A sigue ahí sirviéndose a B.
    const marcaB = datos.get("erp-cache-tenant") === "tenant-B";
    const sigueElCacheDeA = cache.has("erp-catalogos-v1");
    expect(marcaB && sigueElCacheDeA).toBe(false);
  });

  it("lo cacheado POR PERSONA (/viajes/mios) no está en la config del service worker", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = readFileSync("client/vite.config.js", "utf8");
    // El comentario puede nombrarlo; la lista de rutas cacheadas, no.
    expect(cfg).not.toContain('"/api/erp/combustible/viajes/mios"');
    const precarga = readFileSync("client/src/offline/precargaCatalogos.ts", "utf8");
    expect(precarga).not.toContain("viajes/mios");
  });
});
