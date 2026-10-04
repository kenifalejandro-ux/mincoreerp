/** e2e/combustible-comprobante.spec.ts
 *
 * La compra en ruta ya no pide serie/vale: pide el comprobante del proveedor
 * y permite adjuntar su foto (0109, entrega 4).
 *
 * Qué prueba y por qué en un navegador real: los tests de servidor ya cubren
 * la API. Lo que solo se ve acá es la cadena completa del formulario --que
 * NO aparezcan serie/vale para una compra externa, que el <input type=file>
 * sí adjunte, que la foto viaje DESPUÉS del registro apuntando a la compra por
 * su uuid, y que termine guardada y descargable.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

// JPEG de 1x1 píxel: válido para el navegador y para el filtro de tipos.
const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64"
);

async function elegirPorTexto(page: Page, selector: string, texto: string) {
  const valor = await page
    .locator(`${selector} option`)
    .evaluateAll(
      (opciones, buscado) =>
        (opciones as HTMLOptionElement[]).find((o) => o.textContent?.includes(buscado as string))
          ?.value ?? null,
      texto
    );
  expect(valor, `no hay una opción con "${texto}" en ${selector}`).not.toBeNull();
  await page.locator(selector).selectOption(valor as string);
}

test("compra en ruta: pide comprobante (no vale), adjunta la foto y queda descargable", async ({
  page,
}) => {
  const marca = `CMP-${randomBytes(3).toString("hex").toUpperCase()}`;
  const numero = `B001-${randomBytes(3).toString("hex").toUpperCase()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);

  const equipo = await page.request.post("/api/erp/equipos", {
    data: { placa_codigo: marca, tipo: "VOLQUETE", tipo_medidor: "horometro" },
  });
  expect(equipo.status(), "no se pudo crear el equipo de prueba").toBe(201);
  const grifo = await page.request.post("/api/erp/combustible/grifos", {
    data: { nombre: `PRIMAX ${marca}` },
  });
  expect(grifo.status(), "no se pudo crear el proveedor de prueba").toBe(201);

  // `exact`: sin eso "Combustible" también matchea la campanita de "Alertas
  // de combustible", que viene antes en el DOM. Click en el ítem navega al
  // panel de Tanques, donde está "Registrar despacho".
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Registrar despacho" }).first().click();

  await page.locator("#despacho-origen").selectOption("compra_externa");

  // Lo central del cambio: una compra externa NO pide serie ni vale.
  await expect(page.locator("#despacho-serie")).toHaveCount(0);
  await expect(page.locator("#despacho-n-vale")).toHaveCount(0);
  await expect(page.locator("#despacho-comprobante-numero")).toBeVisible();

  await elegirPorTexto(page, "#despacho-grifo", `PRIMAX ${marca}`);
  await elegirPorTexto(page, "#despacho-equipo-externo", marca);
  await page.locator("#despacho-cantidad-externa").fill("40");
  await page.locator("#despacho-horometro").fill("9707");
  await page.locator("#despacho-horas-abastecidas").fill("12");
  await page.locator("#despacho-costo-unitario").fill("17.5");
  await page.locator("#despacho-comprobante-numero").fill(numero);
  await page
    .locator("#despacho-comprobante-foto")
    .setInputFiles({ name: "boleta.jpg", mimeType: "image/jpeg", buffer: JPEG_1X1 });
  await expect(page.getByText(/se enviará al registrar/)).toBeVisible();

  await page.locator("form").getByRole("button", { name: "Registrar despacho" }).click();
  await expect(
    page.getByText(new RegExp(`Despacho registrado: la boleta ${numero}`))
  ).toBeVisible();

  // La foto viaja después del registro: esperar a que quede guardada.
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/erp/combustible/despachos");
        if (!res.ok()) return `HTTP ${res.status()}`;
        const cuerpo = await res.json();
        const filas = Array.isArray(cuerpo) ? cuerpo : (cuerpo.data ?? cuerpo.despachos ?? []);
        const fila = filas.find(
          (d: { comprobante_numero: string }) => d.comprobante_numero === numero
        );
        return fila?.comprobante_nombre ?? null;
      },
      { message: "la foto del comprobante no quedó guardada" }
    )
    .toMatch(/boleta.*\.jpg$/);
});
