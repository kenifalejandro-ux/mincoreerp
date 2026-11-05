/** e2e/combustible-cisterna-historial.spec.ts
 *
 * El Historial de la pestaña "Cisternas": las cisternas vaciadas y las de una recepción anulada,
 * cada una con su proveedor, y los filtros por proveedor y por estado.
 *
 * Por qué en un navegador real: la API ya la cubren los tests de servidor y la lógica de filtrado
 * los tests de unidad. Lo que solo se ve acá es que el selector de vista cambie de lista, que las
 * tarjetas digan lo que pasó con cada cisterna (vaciada, anulada con su motivo), que los filtros
 * escondan y muestren las tarjetas correctas y que la tarjeta quepa en un celular.
 *
 * El tenant e2e sobrevive entre corridas y otras specs dejan cisternas vaciadas: por eso todo se
 * busca por la recepción y el proveedor de ESTA corrida, nunca por conteos.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

interface Cisterna {
  id: string;
  recepcion_id: string;
}

const tarjetaDe = (page: Page, recepcionId: string) =>
  page.locator("article").filter({ hasText: `Recepción #${recepcionId} ` });

test("Historial: la vaciada y la anulada salen con su proveedor, y los filtros las separan", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoInternoId = await primerGrifoActivo(page);

  const crear = async (ruta: string, data: object) => {
    const r = await page.request.post(ruta, { data });
    expect(r.status(), `${ruta}: ${await r.text()}`).toBe(201);
    return (await r.json()) as Record<string, unknown>;
  };

  // Un tanque lleno: todo lo que se recibe es excedente y se queda en la cisterna.
  const tanque = await crear("/api/erp/combustible", {
    codigo: `CH-${marca}`,
    tanque_nombre: `Tanque historial ${marca}`,
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_punto: "fijo",
    capacidad_total: 2000,
    nivel_actual: 2000,
    requiere_documento: false,
    modo_excedente_recepcion: "flexible",
    grifo_interno_id: grifoInternoId,
  });
  const equipo = await crear("/api/erp/equipos", {
    placa_codigo: `CH-${marca}`,
    tipo: "VOLQUETE",
    tipo_medidor: "horometro",
    grifo_interno_id: grifoInternoId,
  });
  const nombreA = `HISTA ${marca}`;
  const nombreB = `HISTB ${marca}`;
  const provA = await crear("/api/erp/combustible/grifos", { nombre: nombreA });
  const provB = await crear("/api/erp/combustible/grifos", { nombre: nombreB });
  const serie = `H${marca}`;

  const recibir = async (proveedorId: unknown, cantidad: number) => {
    const rec = await crear("/api/erp/combustible/recepciones", {
      combustible_id: tanque.id,
      grifo_id: proveedorId,
      cantidad,
      costo_unitario: 17.5,
      recibido_en: new Date().toISOString(),
      reparto_excedente: [{ destino: "cisterna", cantidad }],
    });
    const lista = (await (
      await page.request.get("/api/erp/combustible/despachos/cisternas?estado=saldo")
    ).json()) as Cisterna[];
    const linea = lista.find((c) => Number(c.recepcion_id) === Number(rec.id));
    expect(linea, "la cisterna no quedó con saldo").toBeDefined();
    return { recepcionId: String(rec.id), lineaId: Number(linea!.id) };
  };
  const repartir = async (lineaId: number, cantidad: number, vale: number) => {
    await crear("/api/erp/combustible/despachos", {
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipo.id,
      serie_talonario: serie,
      n_vale: vale,
      cantidad,
      lectura_horometro: 100 + vale,
      costo_unitario: 1,
    });
  };

  // A: de HISTA, repartida entera (vaciada). B: de HISTB, anulada. C: de HISTA, con saldo.
  const a = await recibir(provA.id, 300);
  await repartir(a.lineaId, 300, 1);
  const b = await recibir(provB.id, 200);
  const anulada = await page.request.patch(
    `/api/erp/combustible/recepciones/${b.recepcionId}/anular`,
    {
      data: { motivo: `recepción duplicada ${marca}` },
    }
  );
  expect(anulada.status(), await anulada.text()).toBe(200);
  const c = await recibir(provA.id, 100);

  try {
    await page.reload();
    await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await page.getByRole("button", { name: "Cisternas", exact: true }).click();
    const vista = page.getByRole("group", { name: "Vista de cisternas" });

    // ── Con saldo: solo la C ───────────────────────────────────────────────
    await expect(tarjetaDe(page, c.recepcionId)).toContainText(/100\s*\/\s*100 gal/);
    await expect(tarjetaDe(page, a.recepcionId)).toHaveCount(0);
    await expect(tarjetaDe(page, b.recepcionId)).toHaveCount(0);

    // ── Historial: la vaciada y la anulada, no la que tiene saldo ──────────
    await vista.getByRole("button", { name: /^Historial/ }).click();
    await expect(vista.getByRole("button", { name: /^Historial/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    const vaciada = tarjetaDe(page, a.recepcionId);
    const anuladaTarjeta = tarjetaDe(page, b.recepcionId);
    await expect(vaciada).toContainText(nombreA);
    await expect(vaciada).toContainText("Vaciada");
    await expect(vaciada).toContainText(/Se repartieron 300 gal/);
    await expect(anuladaTarjeta).toContainText(nombreB);
    await expect(anuladaTarjeta).toContainText("Anulada");
    await expect(anuladaTarjeta).toContainText(`recepción duplicada ${marca}`);
    await expect(tarjetaDe(page, c.recepcionId)).toHaveCount(0);

    // Las salidas de la vaciada se despliegan y nombran la unidad.
    await vaciada.getByText(/^Salidas \(1\)/).click();
    await expect(vaciada).toContainText(`CH-${marca}`);

    // ── Filtros ────────────────────────────────────────────────────────────
    const proveedor = page.locator("#cisternas-filtro-proveedor");
    const estado = page.locator("#cisternas-filtro-estado");
    await proveedor.selectOption({ label: nombreA });
    await expect(vaciada).toBeVisible();
    await expect(anuladaTarjeta).toHaveCount(0);

    // Proveedor A + solo anuladas: no hay ninguna, y lo dice.
    await estado.selectOption("anulada");
    await expect(page.getByText("Ninguna cisterna coincide con el filtro.")).toBeVisible();
    await expect(vaciada).toHaveCount(0);

    // Todos los proveedores + solo anuladas: queda la B.
    await proveedor.selectOption("");
    await expect(anuladaTarjeta).toBeVisible();
    await expect(vaciada).toHaveCount(0);

    // Solo vaciadas: queda la A.
    await estado.selectOption("vaciada");
    await expect(vaciada).toBeVisible();
    await expect(anuladaTarjeta).toHaveCount(0);

    // ── En un celular la tarjeta cabe y no hay scroll horizontal ───────────
    await estado.selectOption("todas");
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(vaciada).toBeVisible();
    const caja = await vaciada.boundingBox();
    expect(caja, "la tarjeta no tiene caja").not.toBeNull();
    expect(caja!.x + caja!.width).toBeLessThanOrEqual(390 + 1);
    const desborde = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(desborde, "la página se desborda a lo ancho").toBeLessThanOrEqual(1);

    // En un celular el menú lateral se abre como cajón y tapa los botones: se vuelve a escritorio.
    await page.setViewportSize({ width: 1280, height: 800 });
    // ── De vuelta en "Cisternas" sigue estando la C ────────────────────────
    await vista.getByRole("button", { name: /^Cisternas/ }).click();
    await expect(tarjetaDe(page, c.recepcionId)).toBeVisible();
  } finally {
    // La C se deja vacía para no ensuciar el aviso de las demás specs.
    await repartir(c.lineaId, 100, 2).catch(() => undefined);
  }
});
