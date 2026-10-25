/** e2e/fixtures/conductorConViaje.ts
 *
 * Un conductor con su unidad y un viaje de ida y vuelta (A → B → A) ya programado, y el camino
 * hasta "Mi viaje". Todo por API salvo el login del admin y el cambio de clave del conductor.
 *
 * La cuenta del conductor se da de baja al final (`darDeBajaAlConductor`): la cuota de usuarios
 * del tenant cuenta los activos, y sin la baja cada corrida se comería un cupo.
 */
import { randomBytes } from "node:crypto";
import { type Page, expect } from "@playwright/test";
import { loginPorUI } from "./auth";
import { adminA } from "./entorno";
import { primerGrifoActivo } from "./grifos";

export interface ViajeDeConductor {
  a: string;
  b: string;
  dni: string;
  password: string;
  marca: string;
  viajeId: string;
  /** Con relevo (0152): sus credenciales; el titular sale manejando. */
  relevo?: { dni: string; password: string; nombre: string };
}

/** Entra como admin y deja programado un viaje A → B → A para un conductor nuevo. */
export async function prepararViajeDeConductor(
  page: Page,
  opciones: { conRelevo?: boolean } = {}
): Promise<ViajeDeConductor> {
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoId = await primerGrifoActivo(page);

  const lugar = async (nombre: string) => {
    const r = await page.request.post("/api/erp/combustible/lugares", { data: { nombre } });
    expect(r.status()).toBe(201);
    return Number((await r.json()).id);
  };
  const a = `Huamachuco ${marca}`;
  const b = `Bambamarca ${marca}`;
  const idA = await lugar(a);
  const idB = await lugar(b);

  const dni = `98${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;
  const password = `Clave-${marca}-9x`;
  const nombre = `Conductor ${marca}`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre, dni, password, rol: "conductor_ruta" },
  });
  expect(alta.status()).toBe(201);

  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: `VQ-${marca}`,
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: nombre,
      conductor_dni: dni,
      grifo_interno_id: grifoId,
    },
  });
  expect(equipo.status()).toBe(201);
  let relevo: ViajeDeConductor["relevo"];
  if (opciones.conRelevo) {
    relevo = {
      dni: `97${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`,
      password: `Relevo-${marca}-9x`,
      nombre: `Relevo ${marca}`,
    };
    const altaRelevo = await page.request.post("/api/erp/usuarios", {
      data: {
        nombre: relevo.nombre,
        dni: relevo.dni,
        password: relevo.password,
        rol: "conductor_ruta",
      },
    });
    expect(altaRelevo.status()).toBe(201);
  }
  const programado = await page.request.post("/api/erp/combustible/viajes", {
    data: {
      equipo_id: (await equipo.json()).id,
      paradas: [idA, idB, idA],
      ...(relevo ? { relevo_dni: relevo.dni, sale: "titular" } : {}),
    },
  });
  expect(programado.status()).toBe(201);
  return { a, b, dni, password, marca, viajeId: (await programado.json()).id as string, relevo };
}

/** Entra el conductor (poniendo su propia clave, que la temporal obliga) y abre Mi viaje. */
export async function entrarAMiViaje(
  page: Page,
  v: ViajeDeConductor,
  como: { dni: string; password: string } = v
): Promise<void> {
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: como.dni, password: como.password },
  });
  expect(login.status()).toBe(200);
  await page.goto("/");
  const nueva = `Nueva-${v.marca}-7y`;
  await page.getByLabel("Contraseña temporal").fill(como.password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(nueva);
  await page.getByLabel("Confirmar nueva contraseña").fill(nueva);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();
  // El conductor no tiene Dashboard: espera su menú de Combustible.
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Mi viaje" }).click();
}

/** Revisa y confirma el viaje programado y lo inicia con el odómetro dado. */
export async function iniciarMiViaje(page: Page, odometro: string): Promise<void> {
  await page.getByRole("button", { name: "Revisar mi viaje" }).click();
  await page.getByRole("button", { name: "Confirmo los datos" }).click();
  await page.getByLabel(/que marca el tablero/).fill(odometro);
  await page.getByRole("button", { name: "Iniciar viaje" }).click();
}

/** El conductor se da de baja para no consumir cupo de usuarios. */
export async function darDeBajaAlConductor(page: Page, v: ViajeDeConductor): Promise<void> {
  const admin = adminA();
  await page.request.post("/api/auth/logout");
  await loginPorUI(page, admin.email, admin.password);
  const lista = await page.request.get("/api/erp/usuarios");
  const usuarios = (await lista.json()).data as { id: string; dni: string }[];
  for (const dni of [v.dni, v.relevo?.dni]) {
    if (!dni) continue;
    const usuario = usuarios.find((u) => u.dni === dni);
    expect(usuario).toBeTruthy();
    const baja = await page.request.patch(`/api/erp/usuarios/${usuario!.id}/estado`, {
      data: { estado: "inactivo", motivo: "Usuario de prueba automatizada" },
    });
    expect(baja.ok()).toBeTruthy();
  }
}
