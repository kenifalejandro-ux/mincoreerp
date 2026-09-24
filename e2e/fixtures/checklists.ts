/** e2e/fixtures/checklists.ts
 *
 * Todo lo que los specs de Checklists necesitan para LLEGAR a lo que cada
 * uno prueba: crear los prerrequisitos, abrir el modal, llenar el
 * formulario, y los selectores del botón de guardar.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────
 *
 * Tres specs (`offline-checklists`, `doble-clic-duplicados` y
 * `capa-b-cliente-uuid`) repetían las mismas seis líneas de navegación y
 * los mismos cuatro selectores. Renombrar el botón "Registrar Checklist"
 * en la UI rompía los tres y había que editar los tres.
 *
 * Eso no es fragilidad inherente al e2e —un rename debe romper el test, es
 * la señal correcta— sino duplicación nuestra: la parte frágil ahora vive
 * en un solo lugar y cada spec queda con lo que de verdad prueba (uuids,
 * filas, estado de la cola). Mismo criterio que `fixtures/auth.ts`, que se
 * extrajo por el mismo motivo con el login.
 *
 * ── Lo que NO se hizo, a propósito ──────────────────────────────────────
 *
 * No se cambiaron los selectores por `data-testid`. Desacoplarían del
 * texto, pero a costa de dejar de probar lo que el usuario ve — y acá eso
 * sería un retroceso concreto: fue `getByLabel` el que descubrió que los
 * `<select>` del modal no tenían label asociado (un bug de accesibilidad
 * real, ver ADR-0002 §9). Un `testid` habría pasado en verde tapándolo.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** Nombre de la plantilla que crea `sembrarEquipoYPlantilla`, derivado de
 *  la marca del spec para que dos specs en paralelo no se pisen. */
export function nombrePlantilla(marca: string): string {
  return `Pre-uso ${marca}`;
}

/** Crea por API el equipo y la plantilla que el formulario necesita.
 *
 *  Por API y no por UI porque ningún spec de este grupo está probando esos
 *  formularios — son andamiaje. `page.request` comparte el jar de cookies
 *  del navegador, así que va autenticado con la MISMA sesión que acaba de
 *  entrar por la UI. */
export async function sembrarEquipoYPlantilla(page: Page, marca: string): Promise<void> {
  const equipo = await page.request.post("/api/erp/equipos", {
    data: { placa_codigo: marca, tipo: "Camioneta" },
  });
  expect(equipo.status(), "no se pudo crear el equipo de prueba").toBe(201);

  const plantilla = await page.request.post("/api/erp/checklists/plantillas", {
    data: {
      nombre: nombrePlantilla(marca),
      items: [{ descripcion: "Frenos" }, { descripcion: "Luces" }],
    },
  });
  expect(plantilla.status(), "no se pudo crear la plantilla de prueba").toBe(201);
}

/** Navega a Checklists y abre el modal de creación.
 *
 *  `.first()` en la pestaña porque "Checklists" también es el nombre de la
 *  sub-pestaña dentro de la vista; la del sidebar viene antes en el DOM. */
export async function abrirModalNuevoChecklist(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Checklists" }).first().click();
  await page.getByRole("button", { name: "Nuevo Checklist" }).click();
}

/** Elige equipo y plantilla, y espera a que los ítems estén en pantalla —
 *  el submit está deshabilitado hasta que la plantilla cargó los suyos, así
 *  que sin esta espera el click posterior no hace nada.
 *
 *  `reabriendo: true` es para el caso de volver a abrir el modal después de
 *  cerrarlo: el botón × pone `plantillaSeleccionada` en null pero NO limpia
 *  el `<select>`, así que volver a elegir la misma opción no dispara
 *  `onChange` (el value no cambia) y el formulario quedaría inhabilitado
 *  para siempre. Pasar por la opción vacía fuerza los dos cambios. */
export async function elegirEquipoYPlantilla(
  page: Page,
  marca: string,
  opciones: { reabriendo?: boolean } = {}
): Promise<void> {
  if (opciones.reabriendo) {
    await page.getByLabel("Plantilla").selectOption({ value: "" });
  } else {
    await page.getByLabel("Equipo").selectOption({ label: marca });
  }
  await page.getByLabel("Plantilla").selectOption({ label: nombrePlantilla(marca) });
  await expect(page.getByText("Frenos")).toBeVisible();
}

/** El botón de submit del modal. La regex cubre los dos textos que puede
 *  tener: "Registrar Checklist" en reposo y "Registrando..." mientras la
 *  request vuela (ver la capa A en ADR-0002 §9). Un locator con el texto
 *  fijo dejaría de encontrarlo justo mientras está guardando. */
export function botonRegistrar(page: Page): Locator {
  return page.getByRole("button", { name: /Registrar Checklist|Registrando/ });
}

/** El botón que cierra el modal (ícono, sin texto -- ver su aria-label). */
export function botonCerrarModal(page: Page): Locator {
  return page.getByRole("button", { name: "Cerrar" });
}

/** Los checklists ya guardados en el servidor para ese equipo. Es la
 *  verificación que de verdad importa en estos specs: cuántas filas existen
 *  del lado del servidor, no qué se ve en pantalla. */
export async function checklistsDelEquipo(page: Page, marca: string): Promise<unknown[]> {
  const listado = await page.request.get("/api/erp/checklists?pageSize=100");
  const cuerpo = (await listado.json()) as { data: { placa_codigo: string }[] };
  return cuerpo.data.filter((c) => c.placa_codigo === marca);
}
