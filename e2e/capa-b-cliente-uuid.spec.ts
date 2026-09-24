/** e2e/capa-b-cliente-uuid.spec.ts
 *
 * Prueba la "capa B" de la protección contra doble submit: que el
 * `cliente_uuid` esté atado al FORMULARIO ABIERTO y no al clic.
 *
 * ── Por qué hace falta este spec, si ya hay otros dos ───────────────────
 *
 * Ni `tests/idempotencia-offline.test.ts` ni
 * `e2e/doble-clic-duplicados.spec.ts` cubren esta propiedad:
 *
 *  - Los tests de servidor prueban "el MISMO cliente_uuid dos veces ⇒ una
 *    sola fila". Eso ya pasaba **con el bug puesto**: lo que estaba roto
 *    era que el cliente mandaba uuid DISTINTOS en cada clic, y el servidor
 *    no puede distinguir eso de dos inspecciones legítimas del mismo
 *    equipo (ni debe: es lo mismo que permite que dos operarios llenen un
 *    checklist del mismo camión en el mismo turno).
 *  - El `dblclick()` del otro spec prueba la experiencia real, pero si el
 *    navegador entrega el segundo clic contra el botón ya deshabilitado
 *    (capa A), pasa en verde sin haber ejercitado la capa B nunca. Verde
 *    ahí no es prueba de B.
 *
 * ── Cómo se prueba sin depender del timing de los clics ─────────────────
 *
 * Se intercepta el POST de creación y se responde **500**. Eso da tres
 * cosas de una: el modal queda abierto (ChecklistsView solo lo cierra si
 * `res.ok`), se puede submitear otra vez sobre la MISMA instancia del
 * formulario, y no se crean registros de prueba en la base. Cero
 * dependencia de que dos clics ganen una carrera contra un re-render.
 *
 * Se prueban las DOS mitades de la garantía, porque una sin la otra es
 * peligrosa:
 *   1. Dos submits del mismo modal ⇒ el MISMO uuid (si no, duplica).
 *   2. Cerrar y reabrir ⇒ uuid DISTINTO (si no, el segundo checklist
 *      legítimo del turno devolvería el primero en silencio — se perdería
 *      un registro, que es peor que el duplicado que se está evitando).
 *
 * Se hace sobre Checklists como representante: los 4 módulos usan el
 * mismo patrón. Extenderlo a IPERC/Combustible/Documentos es agregar la
 * parte de "llenar el formulario", que es distinta en cada uno.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import {
  abrirModalNuevoChecklist,
  botonCerrarModal,
  botonRegistrar,
  elegirEquipoYPlantilla,
  sembrarEquipoYPlantilla,
} from "./fixtures/checklists";
import { adminA } from "./fixtures/entorno";

const RUTA_CREACION = "/api/erp/checklists";

/** El service worker de la app hace `skipWaiting()` + `clientsClaim()` (ver
 *  el sw.js generado), así que toma control de la página apenas se activa,
 *  sin necesidad de recargar. A partir de ahí los `fetch()` salen mediados
 *  por él — y Playwright NO intercepta igual esas requests en todos los
 *  motores: en WebKit, `page.route` deja de verlas.
 *
 *  Se manifestó exactamente así: este spec pasó en Chromium y Firefox y
 *  falló solo en WebKit, sin capturar NINGUNA request. Es también el único
 *  de los tres specs de checklists que usa `page.route`.
 *
 *  Bloquear el SW acá no debilita nada: lo que este spec prueba es el ciclo
 *  de vida del `cliente_uuid` en el formulario, que no tiene nada que ver
 *  con el SW. El comportamiento CON service worker activo lo cubre
 *  offline-checklists.spec.ts, que es donde sí importa.
 *
 *  Verificado que no rompe el arranque: el registro de vite-plugin-pwa
 *  envuelve `new Workbox(...)` en un `.catch()` y hace `if (!wb) return`,
 *  así que una registración fallida no tira ni deja la app a medias. */
test.use({ serviceWorkers: "block" });

test("el cliente_uuid está atado al formulario abierto, no al clic", async ({ page }) => {
  const marca = `UUID-${randomBytes(3).toString("hex").toUpperCase()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);

  // Los prerrequisitos se siembran ANTES de instalar la intercepción — así
  // el route no tiene que discriminar estas llamadas de las que sí importan.
  await sembrarEquipoYPlantilla(page, marca);

  // El alert de error del 500 bloquearía el test si nadie lo atiende.
  page.on("dialog", (dialog) => void dialog.accept());

  const uuidsEnviados: string[] = [];
  await page.route(`**${RUTA_CREACION}`, async (route) => {
    const req = route.request();
    // Comparación exacta de pathname: sin esto, el glob también taparía
    // /api/erp/checklists/plantillas y este spec dejaría de poder crear
    // sus propios prerrequisitos si algún día se mueven acá abajo.
    const esCreacion = req.method() === "POST" && new URL(req.url()).pathname === RUTA_CREACION;
    if (!esCreacion) {
      await route.continue();
      return;
    }

    // El parseo va en try/catch y ANTES del fulfill, pero sin poder
    // impedirlo: si `postDataJSON()` tirara (pasa si el motor no expone el
    // body como se espera), el handler moriría sin responder, la request
    // quedaría colgada para siempre y el síntoma sería idéntico al de no
    // capturar nada. Mejor registrar lo que se pueda y responder igual.
    try {
      const body = req.postDataJSON() as { cliente_uuid?: string } | null;
      if (body?.cliente_uuid) uuidsEnviados.push(body.cliente_uuid);
    } catch {
      const crudo = req.postData();
      if (crudo) {
        const match = /"cliente_uuid"\s*:\s*"([^"]+)"/.exec(crudo);
        if (match) uuidsEnviados.push(match[1]);
      }
    }

    // 500 y no continue(): mantiene el modal abierto para poder submitear
    // de nuevo sobre la misma instancia del formulario, y de paso no
    // ensucia la base con checklists de prueba.
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "Error simulado por el test" }),
    });
  });

  await abrirModalNuevoChecklist(page);
  await elegirEquipoYPlantilla(page, marca);

  const registrar = botonRegistrar(page);

  // ── Mitad 1: dos submits del MISMO modal ─────────────────────────────
  // Secuenciales y esperando cada uno, a propósito: lo que se prueba acá
  // NO es que dos clics simultáneos se bloqueen (eso es la capa A, y ya
  // lo cubre doble-clic-duplicados.spec.ts) sino que el uuid no cambie
  // entre un envío y el siguiente del mismo formulario.
  await registrar.click();
  await expect.poll(() => uuidsEnviados.length).toBe(1);

  await registrar.click();
  await expect.poll(() => uuidsEnviados.length).toBe(2);

  const unicos = new Set(uuidsEnviados);
  expect(
    unicos.size,
    `Dos envíos del MISMO modal mandaron ${unicos.size} cliente_uuid distintos (se esperaba 1). ` +
      `El uuid volvió a generarse dentro del handler de submit en vez de al abrir el formulario, ` +
      `así que un doble clic crearía dos checklists. UUIDs: ${[...unicos].join(", ")}`
  ).toBe(1);

  const uuidDelPrimerModal = [...unicos][0];

  // ── Mitad 2: cerrar y reabrir ⇒ uuid NUEVO ───────────────────────────
  await botonCerrarModal(page).click();
  await expect(registrar).toBeHidden();

  uuidsEnviados.length = 0;
  await page.getByRole("button", { name: "Nuevo Checklist" }).click();
  // `reabriendo` no es un detalle: al cerrar, el <select> conserva su valor
  // y volver a elegir lo mismo no dispara onChange -- ver la fixture.
  await elegirEquipoYPlantilla(page, marca, { reabriendo: true });

  await registrar.click();
  await expect.poll(() => uuidsEnviados.length).toBe(1);

  expect(
    uuidsEnviados[0],
    `Al reabrir el modal se reusó el cliente_uuid de la vez anterior. Eso NO duplica, hace algo ` +
      `peor: el segundo checklist legítimo del turno chocaría contra la clave del primero y el ` +
      `servidor devolvería aquel en silencio — se perdería un registro sin que nadie se entere.`
  ).not.toBe(uuidDelPrimerModal);
});
