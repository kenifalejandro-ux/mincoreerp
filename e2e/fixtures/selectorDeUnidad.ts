/** e2e/fixtures/selectorDeUnidad.ts
 *
 * Elegir una unidad en el selector con buscador (Checklists, Órdenes de trabajo, IPERC): es un botón que abre una
 * lista con un campo para escribir. Aquí vive la forma de manejarlo para que ningún spec la repita.
 */
import { expect, type Page } from "@playwright/test";

/** Abre el selector `id`, escribe `texto` y elige la opción que lo contiene. */
export async function elegirUnidad(page: Page, id: string, texto: string): Promise<void> {
  await page.locator(`#${id}`).click();
  await page.locator(`input[aria-controls="${id}-lista"]`).fill(texto);
  const opcion = page.locator(`#${id}-lista [role="option"]`).filter({ hasText: texto });
  // Las unidades llegan del servidor: se espera a que la opción exista antes de elegirla.
  await expect(opcion).toHaveCount(1);
  await opcion.click();
  await expect(page.locator(`#${id}`)).toContainText(texto);
}
