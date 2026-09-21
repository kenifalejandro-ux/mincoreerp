/** src/modules/registry.ts
 *
 * Fuente única de verdad para "qué módulos tiene el ERP" — ver
 * docs/adr/0002-contrato-de-modulo.md. Antes de este archivo, un módulo se
 * registraba a mano en 5 lugares que nadie sincronizaba (enum de Postgres,
 * MODULOS_ERP en platform.schema.ts, routes/index.ts, Sidebar.tsx,
 * App.tsx) — así fue como Equipos/Checklists/IPERC terminaron con backend
 * completo pero invisibles en el cliente.
 *
 * De acá se derivan: MODULOS_ERP (platform.schema.ts), el montaje de
 * rutas (routes/index.ts) y la lista de tablas de backup/restore
 * (platformBackup.service.ts). El enum `modulo_erp` de Postgres sigue
 * existiendo aparte (da un CHECK real a nivel de base de datos que este
 * archivo no puede dar) — tests/module-registry.test.ts falla si alguna
 * vez este array y el enum divergen.
 *
 * Agregar un módulo nuevo: ver el checklist en el ADR. En resumen, un
 * `ModuloDefinicion` acá + una migración que sume el valor al enum
 * `modulo_erp` (y le dé RLS a sus tablas) son los dos únicos lugares que
 * hace falta tocar a mano.
 *
 * ── Orden del array: importa, no es solo estético ────────────────────────
 * `platformBackup.service.ts` concatena las `tablas` de todos los módulos
 * EN ESTE ORDEN para el INSERT de un restore -- padres antes que hijos
 * (ver ADR sección 2), y `restaurarTablas()` NO usa
 * `SET CONSTRAINTS ALL DEFERRED` -- el orden real importa, no es solo una
 * guía de lectura. Encadenado hoy: `equipos` antes que `combustible`
 * (combustible_despachos.equipo_id, Fase B, migrations/0062) e `iperc`
 * antes que `ordenes_trabajo` (FK a ambos), `ordenes_trabajo` antes que
 * `repuestos` (repuestos_movimientos.orden_trabajo_id) y antes que
 * `documentos` (documentos.orden_trabajo_id). `repuestos` se movió de la
 * posición 1 a después de `ordenes_trabajo`, y `equipos` de después de
 * `combustible` a antes, cada uno en el PR que agregó el vínculo que lo
 * exigía -- nada más depende de que estén temprano, así que no rompió nada.
 */
import dashboardRoutes from "./dashboard/dashboard.routes";
import repuestosRoutes from "./repuestos/repuestos.routes";
import combustibleRoutes from "./combustible/combustible.routes";
import documentosRoutes from "./documentos/documentos.routes";
import equiposRoutes from "./equipos/equipos.routes";
import checklistsRoutes from "./checklists/checklists.routes";
import ipercRoutes from "./iperc/iperc.routes";
import ordenesTrabajoRoutes from "./ordenes_trabajo/ordenes_trabajo.routes";
import type { ModuloDefinicion } from "./types";

export const MODULOS: ModuloDefinicion[] = [
  {
    id: "equipos",
    label: "Equipos",
    icono: "🚜",
    version: "v1",
    router: equiposRoutes,
    tablas: [{ nombre: "equipos", pk: "serial" }],
    raices: ["equipos"],
    cuota: { tabla: "equipos", porDefecto: 2_000 },
    // Solo crear el equipo califica para offline -- ver ADR-0002 §8. Dar de
    // alta un equipo nuevo en cancha, sin señal, es un caso de campo real
    // (mismo criterio que checklists/iperc/ordenes_trabajo). `PUT`/`DELETE`
    // NO están acá a propósito: editar sobreescribe campos existentes y
    // borrar no debe reintentarse a ciegas.
    offline: { escrituras: [{ metodo: "POST", ruta: "/" }] },
  },
  {
    id: "combustible",
    label: "Combustible",
    icono: "⛽",
    version: "v1",
    router: combustibleRoutes,
    tablas: [
      {
        nombre: "combustible",
        pk: "serial",
        // `nivel_actual` y `fecha_actualizacion` DEJARON de existir en la
        // migración 0059 (el nivel se deriva de las lecturas). Los backups
        // tomados ANTES todavía las traen, y restaurarTablas() arma el
        // INSERT con las claves que vengan en el JSON -- sin esto, restaurar
        // un backup viejo fallaría con "column does not exist". Mismo
        // mecanismo que usa iperc para `nivel_riesgo`.
        columnasExcluidasAlRestaurar: ["nivel_actual", "fecha_actualizacion"],
      },
      {
        nombre: "combustible_lecturas",
        pk: "serial",
        fks: {
          combustible_id: "combustible",
          usuario_id: "usuarios",
          anulada_por: "usuarios",
        },
      },
      // Fase B, precios (migrations/0063) -- catálogo chico de grifos
      // externos (PRIMAX, VELASQUEZ...). Va ANTES de combustible_despachos
      // y combustible_precios en este array: las dos lo referencian por FK,
      // y el restore necesita padres antes que hijos.
      {
        nombre: "combustible_grifos",
        pk: "serial",
        fks: { usuario_id: "usuarios" },
      },
      // Fase B (migrations/0062) -- el vale digital. A diferencia de
      // combustible_lecturas, NO cascadea desde `combustible`:
      // combustible_id es nullable (solo aplica a origen='tanque_propio',
      // ver el CHECK de forma en la migración) y sin ON DELETE, así que
      // necesita su propia entrada en `raices` para el DELETE del wipe de
      // tenant.
      {
        nombre: "combustible_despachos",
        pk: "serial",
        fks: {
          combustible_id: "combustible",
          equipo_id: "equipos",
          grifo_id: "combustible_grifos",
          usuario_id: "usuarios",
        },
      },
      // Precios (migrations/0063) -- historial apilado, nunca se pisa. Sin
      // ON DELETE, mismo motivo que combustible_despachos: necesita su
      // propia entrada en `raices`.
      {
        nombre: "combustible_precios",
        pk: "serial",
        fks: {
          combustible_id: "combustible",
          grifo_id: "combustible_grifos",
          usuario_id: "usuarios",
          anulada_por: "usuarios",
        },
      },
      // Fase C (migrations/0064) -- cuánto ENTRA al tanque y a qué costo.
      // Mismo criterio que combustible_despachos/combustible_precios: sin
      // ON DELETE, así que necesita su propia entrada en `raices`. A
      // diferencia de aquellas dos, combustible_id y grifo_id son NOT NULL
      // (una recepción sin tanque o sin proveedor no existe).
      {
        nombre: "combustible_recepciones",
        pk: "serial",
        fks: {
          combustible_id: "combustible",
          grifo_id: "combustible_grifos",
          usuario_id: "usuarios",
          anulada_por: "usuarios",
          // Quién validó contra la guía (0088).
          validada_por: "usuarios",
        },
      },
      // Precintos numerados (migración 0095). Las tres cascadean desde su
      // padre (el tanque, el punto o la lectura), así que no necesitan
      // entrada en `raices`. Van DESPUÉS de combustible_recepciones y
      // combustible_lecturas: los precintos referencian la recepción que los
      // cambió y las verificaciones la varilla en que se vieron.
      {
        nombre: "combustible_precinto_puntos",
        pk: "serial",
        fks: { combustible_id: "combustible", creado_por: "usuarios" },
      },
      {
        nombre: "combustible_precintos",
        pk: "serial",
        fks: {
          punto_id: "combustible_precinto_puntos",
          colocado_por: "usuarios",
          recepcion_id: "combustible_recepciones",
        },
      },
      {
        nombre: "combustible_precinto_verificaciones",
        pk: "serial",
        fks: {
          lectura_id: "combustible_lecturas",
          punto_id: "combustible_precinto_puntos",
        },
      },
      // Urea (migración 0092) -- el conteo físico, la contraparte de la
      // varilla que combustible_lecturas es para el tanque. Va ANTES de
      // combustible_alertas, que la referencia por FK (urea_conteo_id, el
      // ancla de urea_descuadre_conteo) -- padres antes que hijos.
      {
        nombre: "combustible_conteos_urea",
        pk: "serial",
        fks: { usuario_id: "usuarios", anulada_por: "usuarios" },
      },
      // Fase D (migrations/0068) -- el aviso vivo: hueco de talonario, vale
      // anulado, sobredespacho, despacho tardío. Va ANTES de
      // combustible_anomalias, que la referencia por FK.
      //
      // NO estaba registrada acá cuando se creó la tabla: un backup de
      // tenant no la incluía y un restore la habría perdido en silencio.
      // Lo agarró la exploración de esta entrega, no un test -- ver
      // tests/backup-tablas-registradas.test.ts, agregado para que la
      // próxima tabla no se escape igual.
      {
        nombre: "combustible_alertas",
        pk: "serial",
        // Las anclas van TODAS: al clonar un backup a otro tenant los ids se
        // regeneran, y una FK que no esté acá se queda apuntando a la fila
        // del tenant de ORIGEN. Faltaban `combustible_id` y `recepcion_id`
        // desde 0073 (lo encontró la 5ª auditoría); `lectura_id` es de 0086;
        // `urea_conteo_id` es de 0092.
        fks: {
          despacho_id: "combustible_despachos",
          combustible_id: "combustible",
          recepcion_id: "combustible_recepciones",
          lectura_id: "combustible_lecturas",
          urea_conteo_id: "combustible_conteos_urea",
          resuelta_por: "usuarios",
        },
      },
      // Fase D (migrations/0072) -- el hallazgo congelado. Append-only.
      // Va DESPUÉS de combustible_alertas: la referencia por alerta_id, y
      // el restore necesita padres antes que hijos. La relación va en un
      // solo sentido a propósito (no hay anomalia_id en alertas): un
      // puntero de vuelta sería un ciclo de FK y no habría orden de INSERT
      // posible -- ver el comentario en la migración.
      {
        nombre: "combustible_anomalias",
        pk: "serial",
        fks: {
          despacho_id: "combustible_despachos",
          combustible_id: "combustible",
          recepcion_id: "combustible_recepciones",
          lectura_id: "combustible_lecturas",
          urea_conteo_id: "combustible_conteos_urea",
          alerta_id: "combustible_alertas",
        },
      },
      // Fase D (migrations/0071) -- la ventana de gracia por tenant.
      {
        nombre: "combustible_config",
        pk: "serial",
        fks: { actualizado_por: "usuarios" },
      },
    ],
    // combustible_lecturas cascadea desde su padre (ON DELETE CASCADE, ver
    // migrations/0045) -- no necesita DELETE propio. combustible_grifos,
    // combustible_despachos, combustible_precios y combustible_recepciones
    // sí lo necesitan (ver el comentario de sus entradas en `tablas`).
    raices: [
      "combustible",
      "combustible_grifos",
      "combustible_despachos",
      "combustible_precios",
      "combustible_recepciones",
      // Fase D: las tres cascadean desde `tenants`, no desde ninguna tabla
      // de este módulo, así que el wipe de un tenant (que NO borra la fila
      // del tenant) no las alcanzaría solo. Mismo orden padre→hijo que en
      // `tablas` -- RAICES_WIPE lo invierte para borrar hijos primero.
      "combustible_conteos_urea",
      "combustible_alertas",
      "combustible_anomalias",
      "combustible_config",
    ],
    // Fase A (migrations/0057) le dio a Combustible su propio POST / y
    // POST /bulk que crean el recurso base -- un solo `cuota.tabla`
    // compartido con las lecturas habría dejado esas altas sin límite real,
    // mismo problema que ya resolvió Repuestos (ver el comentario largo en
    // su entrada, más abajo). Se aplica el mismo remedio en vez de inventar
    // uno nuevo: `cuota` vuelve a ser el recurso propio del módulo (los
    // tanques), y el histórico de lecturas pasa a `cuotasPorRuta` como
    // recurso aparte.
    // Un tanque real es configuración de planta (unos pocos por tenant),
    // pero el techo del plan no tiene por qué reflejar ese número exacto --
    // mismo criterio que equipos/repuestos: se fija cómodamente por encima
    // de MAX_FILAS_CARGA_MASIVA_TANQUES (5.000, combustible.schema.ts) para
    // que el límite real de la carga masiva lo ponga la validación de Zod,
    // no la cuota.
    cuota: { tabla: "combustible", porDefecto: 10_000 },
    cuotasPorRuta: [
      {
        ruta: "/lecturas",
        metodo: "POST",
        recurso: "combustible_lecturas",
        tabla: "combustible_lecturas",
        porDefecto: 100_000,
      },
      // Fase B -- recurso propio, mismo criterio que combustible_lecturas
      // arriba: el histórico de despachos crece con el trabajo de campo,
      // no con la configuración de tanques que cuenta `cuota`.
      {
        ruta: "/despachos",
        metodo: "POST",
        recurso: "combustible_despachos",
        tabla: "combustible_despachos",
        porDefecto: 100_000,
      },
      // Fase C -- recurso propio por el mismo motivo, pero con un techo
      // mucho más bajo a propósito: una recepción es la llegada de una
      // cisterna (semanal o mensual), no un movimiento de cancha. Miles de
      // recepciones en un tenant serían señal de que algo se está usando
      // mal, no de un cliente grande.
      {
        ruta: "/recepciones",
        metodo: "POST",
        recurso: "combustible_recepciones",
        tabla: "combustible_recepciones",
        porDefecto: 10_000,
      },
    ],
    // Solo registrar una lectura o un despacho califica para offline --
    // ver ADR-0002 §8. combustible_id/equipo_id viajan en el body porque
    // rutasOffline.ts solo matchea rutas literales, sin parámetros de URL.
    // Alta/edición/baja de tanques NO están acá a propósito: es
    // configuración de planta, se hace desde la oficina con red (mismo
    // criterio que las plantillas de Checklists). GET /despachos y GET
    // /despachos/huecos tampoco: son lecturas, no escrituras.
    //
    // POST /recepciones (Fase C) tampoco está acá: una cisterna descarga en
    // planta, con red, y quien la registra es admin desde la oficina -- no
    // es el caso de uso sin señal que justifica la cola (ADR-0002 §8). Sí
    // usa `cliente_uuid` igual, pero por el doble clic, no por offline (ver
    // el comentario del campo en combustible.schema.ts).
    offline: {
      escrituras: [
        { metodo: "POST", ruta: "/lecturas" },
        { metodo: "POST", ruta: "/despachos" },
      ],
    },
  },
  {
    id: "dashboard",
    label: "Dashboard",
    icono: "📊",
    version: "v1",
    router: dashboardRoutes,
    // Solo lee/agrega datos de otros módulos, no tiene tablas propias.
    tablas: [],
    raices: [],
  },
  {
    id: "checklists",
    label: "Checklists",
    icono: "✅",
    version: "v1",
    router: checklistsRoutes,
    tablas: [
      { nombre: "checklist_plantillas", pk: "serial" },
      {
        nombre: "checklist_plantilla_items",
        pk: "serial",
        fks: { plantilla_id: "checklist_plantillas" },
      },
      {
        nombre: "checklists",
        pk: "serial",
        fks: { equipo_id: "equipos", plantilla_id: "checklist_plantillas", usuario_id: "usuarios" },
      },
      { nombre: "checklist_items", pk: "serial", fks: { checklist_id: "checklists" } },
    ],
    // checklist_plantilla_items y checklist_items cascadean desde su padre
    // (ON DELETE CASCADE, ver migrations/0006) — no necesitan DELETE propio.
    raices: ["checklist_plantillas", "checklists"],
    // Se cuentan los checklists LLENADOS, no las plantillas: las plantillas
    // son configuración (unas pocas por tenant), los llenados crecen a
    // razón de uno por equipo por turno.
    cuota: { tabla: "checklists", porDefecto: 200_000 },
    // Llenar un checklist es EL flujo de campo: pasa en la cancha, con el
    // equipo delante y muchas veces sin señal. Califica para la cola
    // porque ChecklistsService.crear pasa por idempotentInsert() — un
    // reintento con el mismo cliente_uuid no duplica (migración 0044).
    //
    // Las plantillas NO están acá a propósito: son configuración, se
    // arman desde la oficina con red, y un DELETE encolado a ciegas es
    // justo el tipo de operación que no debe reintentarse sola.
    offline: { escrituras: [{ metodo: "POST", ruta: "/" }] },
  },
  {
    id: "iperc",
    label: "IPERC",
    icono: "⚠️",
    version: "v1",
    router: ipercRoutes,
    tablas: [
      {
        nombre: "iperc_lineas_base",
        pk: "serial",
        fks: { aprobado_por: "usuarios", creado_por: "usuarios" },
      },
      {
        nombre: "iperc_linea_base_items",
        pk: "serial",
        columnasExcluidasAlRestaurar: ["nivel_riesgo"],
        fks: { linea_base_id: "iperc_lineas_base" },
      },
      {
        nombre: "ipercs",
        pk: "serial",
        fks: {
          equipo_id: "equipos",
          usuario_id: "usuarios",
          aprobado_por: "usuarios",
          linea_base_id: "iperc_lineas_base",
        },
      },
      {
        nombre: "iperc_items",
        pk: "serial",
        columnasExcluidasAlRestaurar: ["nivel_riesgo"],
        fks: { iperc_id: "ipercs", linea_base_item_id: "iperc_linea_base_items" },
      },
    ],
    // iperc_linea_base_items e iperc_items cascadean desde su padre.
    raices: ["iperc_lineas_base", "ipercs"],
    // Ídem: se cuentan los IPERC, no las líneas base (que son el catálogo
    // de riesgos aprobado, deliberadamente acotado).
    cuota: { tabla: "ipercs", porDefecto: 200_000 },
    // Solo la creación del IPERC califica para offline -- ver ADR-0002 §8.
    // Aprobar/rechazar y crear línea base quedan fuera a propósito (esos
    // NO deben encolarse: ver fix_race_condition_iperc_estado).
    offline: { escrituras: [{ metodo: "POST", ruta: "/" }] },
  },
  {
    id: "ordenes_trabajo",
    label: "Órdenes de Trabajo",
    icono: "🛠️",
    version: "v1",
    router: ordenesTrabajoRoutes,
    tablas: [
      {
        nombre: "ordenes_trabajo",
        pk: "serial",
        fks: {
          equipo_id: "equipos",
          iperc_id: "ipercs",
          creado_por: "usuarios",
          asignado_a: "usuarios",
        },
      },
    ],
    raices: ["ordenes_trabajo"],
    cuota: { tabla: "ordenes_trabajo", porDefecto: 50_000 },
    // Solo la creación (`POST /`) califica para offline -- es de los casos
    // más claros del ERP para trabajar sin señal (el equipo se rompe en
    // cancha, se abre la OT ahí mismo). `PATCH /:id/estado` (iniciar/
    // completar/cancelar) NO está acá: es una transición de estado, no una
    // creación, mismo motivo que aprobar/rechazar en IPERC (encolarla a
    // ciegas choca con la misma carrera que resolvió
    // fix_race_condition_iperc_estado). `PUT /:id` tampoco: sobreescribe
    // campos existentes, mismo riesgo que tenía Combustible antes de 0045.
    offline: { escrituras: [{ metodo: "POST", ruta: "/" }] },
  },
  {
    id: "repuestos",
    label: "Repuestos",
    icono: "🔧",
    version: "v1",
    router: repuestosRoutes,
    tablas: [
      { nombre: "repuestos", pk: "serial" },
      {
        nombre: "repuestos_movimientos",
        pk: "serial",
        // orden_trabajo_id referencia una tabla de OTRO módulo (ver
        // migrations/0050) -- hace falta declararlo para que un clonado a
        // otro tenant remapee bien el id, mismo criterio que
        // documentos.orden_trabajo_id. Es la razón por la que `repuestos`
        // tiene que aparecer DESPUÉS de `ordenes_trabajo` en este array
        // (ver el comentario de arriba sobre el orden).
        fks: {
          repuesto_id: "repuestos",
          usuario_id: "usuarios",
          orden_trabajo_id: "ordenes_trabajo",
        },
      },
    ],
    // repuestos_movimientos cascadea desde su padre (ON DELETE CASCADE, ver
    // migrations/0046) -- no necesita DELETE propio.
    raices: ["repuestos"],
    // `cuota` (el catálogo) NO se mueve a repuestos_movimientos -- a
    // diferencia de lo que hizo Combustible con combustible_lecturas en
    // 0045/PR #73, acá el módulo SÍ tiene POST que crea el recurso base
    // (`POST /`, `POST /bulk`), así que un solo `cuota.tabla` compartido
    // habría dejado esas altas sin límite real. En vez de mover el
    // recurso, se declara uno NUEVO y aparte con `cuotasPorRuta` -- ver el
    // comentario largo en modules/types.ts.
    cuota: { tabla: "repuestos", porDefecto: 50_000 },
    // El histórico de movimientos crece con el trabajo de campo (entradas/
    // salidas), no con el catálogo -- mismo criterio que
    // combustible_lecturas, pero como recurso PROPIO en vez de reemplazar
    // el de catálogo (ver el comentario de `cuota` arriba).
    cuotasPorRuta: [
      {
        ruta: "/movimientos",
        metodo: "POST",
        recurso: "repuestos_movimientos",
        tabla: "repuestos_movimientos",
        porDefecto: 100_000,
      },
    ],
    // Solo registrar un movimiento de stock califica para offline -- ver
    // ADR-0002 §8. `repuesto_id` viaja en el body porque rutasOffline.ts
    // solo matchea rutas literales, sin parámetros de URL. Editar (PUT) y
    // la carga masiva por Excel NO están acá a propósito: editar
    // sobreescribe campos existentes (mismo riesgo que tenía Combustible
    // antes de 0045) y el bulk es un flujo de oficina.
    offline: { escrituras: [{ metodo: "POST", ruta: "/movimientos" }] },
  },
  {
    id: "documentos",
    label: "Documentos",
    icono: "📄",
    version: "v1",
    router: documentosRoutes,
    tablas: [
      {
        nombre: "documentos",
        pk: "serial",
        // orden_trabajo_id referencia una tabla de OTRO módulo (evidencia
        // del trabajo -- ver migrations/0049) -- hace falta declararlo acá
        // para que un clonado a otro tenant remapee bien el id, mismo
        // criterio que repuestos_movimientos referenciando repuestos/
        // usuarios. Es la razón por la que `ordenes_trabajo` tiene que
        // aparecer ANTES que `documentos` en este array (ver el comentario
        // de arriba sobre el orden).
        fks: { orden_trabajo_id: "ordenes_trabajo" },
      },
      // El archivo adjunto en sí (PDF/imagen) NO viaja en el backup — vive
      // en R2/disco, aparte de Postgres. Lo que se respalda acá es la fila
      // que lo referencia, que es justo lo que hace falta para que una
      // restauración sobre el MISMO tenant vuelva a enlazar los archivos
      // (que nunca se movieron del storage) con sus documentos.
      //
      // `omitirAlClonar` NO es opcional acá: sin él, clonar a otro tenant
      // le daría al destino filas con storage_key apuntando a los archivos
      // del tenant origen. Ver el comentario largo en modules/types.ts.
      {
        nombre: "documentos_versiones",
        pk: "serial",
        fks: { documento_id: "documentos", subido_por: "usuarios" },
        omitirAlClonar: true,
      },
    ],
    raices: ["documentos"],
    cuota: { tabla: "documentos", porDefecto: 20_000 },
    // Crear el registro (metadata) Y subir el archivo adjunto califican
    // para offline -- ver ADR-0002 §8. `/` cubre también pólizas, SOAT,
    // etc.: son `documentos` con otro `nombre_documento`, no un tipo
    // aparte. `/:id/versiones` es la ruta con archivo binario -- el motor
    // offline lo guarda como Blob en IndexedDB, no como JSON (ver
    // client/src/offline/offlineQueue.ts, CampoFormData). Editar y la
    // carga masiva por Excel quedan FUERA a propósito: editar sobreescribe
    // campos existentes, y el bulk es un flujo de oficina con array grande.
    offline: {
      escrituras: [
        { metodo: "POST", ruta: "/" },
        { metodo: "POST", ruta: "/:id/versiones" },
      ],
    },
  },
];

export const MODULOS_ERP = MODULOS.map((m) => m.id);

export function obtenerModulo(id: string): ModuloDefinicion | undefined {
  return MODULOS.find((m) => m.id === id);
}
