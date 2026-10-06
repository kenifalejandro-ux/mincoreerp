// client/src/modules/offlineRegistry.ts
//
// Qué escrituras de cada módulo participan de la cola offline, del lado del
// cliente. Es el espejo de `ModuloDefinicion.offline` del backend
// (src/modules/types.ts) — ver el ADR-0002, sección "Offline-first".
//
// ── Por qué está acá y no dentro de registry.tsx ─────────────────────────
//
// Conceptualmente pertenece a la entrada de cada módulo, junto a su `label`
// y su `componente`. Vive aparte por una razón concreta y no estética:
// registry.tsx es un .tsx (usa React.lazy), y tanto el motor offline como
// tests/offline-registry.test.ts —que corre con el vitest de la RAÍZ, donde
// no hay ni JSX configurado ni @types/react— necesitan leer esta
// declaración. Importar el .tsx desde ahí rompe `tsc --noEmit` del backend.
//
// Como efecto secundario bueno: el motor de client/src/offline/ no arrastra
// el grafo de componentes lazy solo para saber qué rutas encolar.
//
// Sigue siendo UNA sola fuente por lado (esta, en el cliente; el registry en
// el backend), y tests/offline-registry.test.ts falla si las dos divergen.

export interface EscrituraOffline {
  metodo: "POST" | "PUT" | "PATCH";
  /** Relativa al montaje del módulo — routes/index.ts monta cada uno bajo
   *  /api/erp/<id>, igual que en su archivo de rutas del backend. */
  ruta: string;
}

/** Clave = id del módulo (el mismo del registry y del enum modulo_erp).
 *  Un módulo ausente de este mapa no participa del offline: sus escrituras
 *  fallan como siempre cuando no hay red.
 *
 *  Requisito para agregar uno: el servicio que atiende esa ruta tiene que
 *  pasar por idempotentInsert() en el backend. Encolar una escritura que no
 *  sea idempotente es peor que no tener offline — el reintento duplica en
 *  silencio. */
export const ESCRITURAS_OFFLINE: Record<string, EscrituraOffline[]> = {
  // Llenar un checklist es EL flujo de campo: pasa en la cancha, con el
  // equipo delante y muchas veces sin señal.
  //
  // Las plantillas NO están acá a propósito: son configuración, se arman
  // desde la oficina con red, y un DELETE encolado a ciegas es justo el
  // tipo de operación que no debe reintentarse sola.
  checklists: [{ metodo: "POST", ruta: "/" }],

  // Solo crear el IPERC. Las líneas base son catálogo de oficina (mismo
  // criterio que las plantillas de checklists), y aprobar/rechazar NO debe
  // encolarse nunca: son transiciones de estado, no creaciones, y el 409
  // anti-carrera del backend haría que un reintento tardío se descarte
  // igual.
  iperc: [{ metodo: "POST", ruta: "/" }],

  // Registrar una lectura de tanque, o un despacho (Fase B -- el vale
  // digital). Los dos son rutas literales, sin `:id` -- combustible_id/
  // equipo_id viajan en el body. Alta/edición/baja de tanques y GET
  // /despachos(/huecos) NO están acá: configuración de planta o lecturas,
  // no escrituras de campo -- ver ADR-0002 §8.
  combustible: [
    { metodo: "POST", ruta: "/lecturas" },
    { metodo: "POST", ruta: "/despachos" },
    // La foto del comprobante de una compra en ruta (0109). Apunta a la
    // compra por el uuid del dispositivo y no por su id: si se saca sin señal,
    // la compra todavía no existe en el servidor y no tiene id. La cola drena
    // en orden, así que el registro llega antes que su foto.
    { metodo: "POST", ruta: "/despachos/por-uuid/:clienteUuid/comprobante" },
    // La foto de la boleta de una compra de UREA en ruta (0119): misma idea,
    // ruta propia porque el permiso es otro (urea:registrar_compra).
    { metodo: "POST", ruta: "/urea/compras/por-uuid/:clienteUuid/comprobante" },
  ],

  // Crear el registro (pólizas, SOAT, etc. son `documentos` con otro
  // nombre, no un tipo aparte) Y subir el archivo adjunto. `/:id/versiones`
  // usa un segmento comodín -- rutasOffline.ts lo matchea sin importar el
  // id real (que igual viaja completo en la URL guardada). Editar y la
  // carga masiva por Excel NO están acá a propósito: editar sobreescribe
  // campos existentes -- ver ADR-0002 §8.
  documentos: [
    { metodo: "POST", ruta: "/" },
    { metodo: "POST", ruta: "/:id/versiones" },
  ],

  // Solo registrar un movimiento de stock (entrada/salida). `/movimientos`,
  // NO `/:id/movimientos` -- el motor offline (rutasOffline.ts) solo
  // matchea rutas literales, sin parámetros de URL, así que repuesto_id
  // viaja en el body. Editar el catálogo y la carga masiva por Excel NO
  // están acá a propósito: editar sobreescribe campos existentes -- ver
  // ADR-0002 §8.
  repuestos: [{ metodo: "POST", ruta: "/movimientos" }],

  // Solo crear la orden de trabajo. Es de los casos más claros del ERP
  // para trabajar sin señal (el equipo se rompe en cancha, se abre la OT
  // ahí mismo). Iniciar/completar/cancelar (`PATCH /:id/estado`) y editar
  // (`PUT /:id`) NO están acá a propósito: son transición de estado y
  // sobreescritura de campos existentes respectivamente, mismo criterio
  // que aprobar/rechazar en IPERC y editar en Documentos -- ver ADR-0002 §8.
  ordenes_trabajo: [{ metodo: "POST", ruta: "/" }],

  // Solo dar de alta el equipo. Registrar un equipo nuevo en cancha, sin
  // señal, es un caso de campo real -- mismo criterio que checklists/iperc/
  // ordenes_trabajo. Editar (`PUT`) y eliminar (`DELETE`) NO están acá a
  // propósito: editar sobreescribe campos existentes -- ver ADR-0002 §8.
  equipos: [{ metodo: "POST", ruta: "/" }],
};
