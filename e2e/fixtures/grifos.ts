/** e2e/fixtures/grifos.ts
 *
 * El grifo interno que ya tiene el tenant e2e. Las specs de combustible NO
 * crean grifos: con más de uno activo, crear un equipo sin grifo da 400 y se
 * rompen las specs que no lo mandan (todas corren en paralelo sobre el mismo
 * tenant). Ver CI de feat/combustible-tanquetas, 2026-10-05.
 */
import type { Page } from "@playwright/test";

export async function primerGrifoActivo(page: Page): Promise<number> {
  const res = await page.request.get("/api/erp/sedes");
  const sedes = (await res.json()).sedes as {
    activo: boolean;
    grifos: { id: number; activo: boolean }[];
  }[];
  for (const sede of sedes) {
    if (!sede.activo) continue;
    const grifo = sede.grifos.find((g) => g.activo);
    if (grifo) return grifo.id;
  }
  throw new Error("el tenant e2e no tiene ningún grifo activo");
}
