// client/src/components/comunes/ventanasFlotantesEstado.ts
//
// El estado que los paneles flotantes comparten entre sí: quién está
// adelante, qué documentos hay abiertos en otras ventanas del navegador, y
// la posición y el tamaño que cada panel recuerda entre sesiones.
//
// Está separado de VentanaFlotante.tsx a propósito:
//   1) es estado a nivel de módulo, no un componente;
//   2) react-refresh/only-export-components se queja si un archivo que
//      exporta componentes exporta además funciones sueltas.
//
// OJO con los imports si algún día hay que agregarle alguno: este archivo y
// VentanaFlotante.tsx son HERMANOS, y eslint-plugin-import + ESLint 10
// crashea cuando un archivo mezcla imports padre (../../x) con hermanos
// (./x). Ver el encabezado de components/combustible/gravedadAlertas.ts,
// donde el mismo problema obligó a duplicar una lista.

/** Dónde arranca la franja de z-index de los paneles flotantes. */
export const Z_BASE = 30;

/** Techo absoluto, y no es decorativo. Los modales del módulo usan `z-50` y
 *  los de confirmación -- "Anular lectura", "Anular vale", "Anular
 *  recepción" -- usan `z-[60]`, y se abren DESDE estos paneles. Si el
 *  z-index de foco fuera un contador que sube con cada clic, al rato un
 *  panel taparía al modal que pide el motivo de la anulación y la pantalla
 *  quedaría trabada con un formulario invisible.
 *
 *  Por eso el z-index NO es un contador: es la posición en la pila de foco.
 *  Con N paneles abiertos nunca pasa de Z_BASE + N - 1, y este clamp lo deja
 *  por debajo de 50 aunque alguien abra cincuenta. */
const Z_TECHO = 49;

const PREFIJO_ALMACEN = "mincore.panelFlotante.";

// --- Orden de foco -------------------------------------------------------
//
// Un array de ids, del que está más atrás al que está adelante. Traer un
// panel al frente es moverlo al final; su z-index sale de su índice.

const pilaFoco: string[] = [];
const suscriptores = new Set<() => void>();

function avisarCambio() {
  for (const avisar of suscriptores) avisar();
}

export function suscribirseAlFoco(avisar: () => void): () => void {
  suscriptores.add(avisar);
  return () => {
    suscriptores.delete(avisar);
  };
}

export function registrarPanel(id: string) {
  if (pilaFoco.includes(id)) return;
  pilaFoco.push(id);
  avisarCambio();
}

export function olvidarPanel(id: string) {
  const i = pilaFoco.indexOf(id);
  if (i === -1) return;
  pilaFoco.splice(i, 1);
  avisarCambio();
}

export function traerAlFrente(id: string) {
  const i = pilaFoco.indexOf(id);
  // Ya está adelante: salir sin avisar evita un re-render por cada clic
  // dentro del panel que ya tenía el foco.
  if (i === pilaFoco.length - 1) return;
  if (i !== -1) pilaFoco.splice(i, 1);
  pilaFoco.push(id);
  avisarCambio();
}

export function zIndexDe(id: string): number {
  const i = pilaFoco.indexOf(id);
  return Math.min(Z_BASE + Math.max(i, 0), Z_TECHO);
}

// --- Cascada al abrir ----------------------------------------------------
//
// Un panel sin posición guardada no puede caer exactamente encima del
// anterior: se vería uno solo. Cada uno reserva un "slot" y se corre ese
// tanto respecto de la posición base.
//
// Va en un registro propio y NO se deriva de la pila de foco, aunque a
// primera vista alcanzaría: la pila se llena en un efecto, y los efectos
// corren DESPUÉS del render de todo el árbol. Con varios paneles abiertos
// de una, los tres calculaban su posición inicial viendo la pila todavía
// vacía y se apilaban en el mismo pixel (visto en pantalla, no deducido).
//
// La reserva está memoizada por id para que sea idempotente: el
// inicializador de useState corre dos veces bajo <React.StrictMode> y no
// puede consumir dos slots.

const slotsReservados = new Map<string, number>();

export function reservarSlotCascada(id: string): number {
  const yaReservado = slotsReservados.get(id);
  if (yaReservado !== undefined) return yaReservado;
  const ocupados = new Set(slotsReservados.values());
  let slot = 0;
  while (ocupados.has(slot)) slot++;
  slotsReservados.set(id, slot);
  return slot;
}

export function liberarSlotCascada(id: string) {
  slotsReservados.delete(id);
}

// --- Documentos desprendidos ---------------------------------------------
//
// Un panel desprendido vive en el `document` de OTRA ventana del navegador.
// Ese documento no es alcanzable con `document.getElementById` desde acá, y
// hay código que busca elementos por id (el scroll a una alerta puntual
// cuando se entra desde la campanita). Este registro es el que permite
// seguir encontrándolos.

const documentosDesprendidos = new Set<Document>();

export function recordarDocumento(doc: Document) {
  documentosDesprendidos.add(doc);
}

export function olvidarDocumento(doc: Document) {
  documentosDesprendidos.delete(doc);
}

/** Trae la ventana principal al frente, pero solo si hay algún panel
 *  desprendido.
 *
 *  Hace falta porque un modal de confirmación o un `window.prompt` que nace
 *  de un botón de un panel desprendido NO aparece en esa ventana: se
 *  renderiza en la página, que puede estar minimizada o en otro monitor.
 *  Desde donde el usuario apretó, la acción parece no haber hecho nada --
 *  y son justamente los botones de anular, donde quedarse sin respuesta es
 *  peor que en cualquier otro lado. */
export function enfocarPaginaPrincipal() {
  if (documentosDesprendidos.size === 0) return;
  try {
    window.focus();
  } catch {
    // Si el navegador no deja robar el foco, el modal igual quedó abierto
    // en la página: es un problema de comodidad, no de datos.
  }
}

/** `document.getElementById` que además mira dentro de los paneles que
 *  fueron desprendidos a otra ventana. Usalo en lugar del nativo para
 *  cualquier elemento que pueda estar dentro de un panel flotante. */
export function buscarElementoEnPaneles(id: string): HTMLElement | null {
  const enLaPagina = document.getElementById(id);
  if (enLaPagina) return enLaPagina;
  for (const doc of documentosDesprendidos) {
    const suelto = doc.getElementById(id);
    if (suelto) return suelto;
  }
  return null;
}

// --- Posición y tamaño recordados ----------------------------------------

export interface GeometriaPanel {
  x: number;
  y: number;
  ancho: number;
  alto: number;
}

function esNumeroUtil(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Lee lo último que el usuario dejó guardado para este panel. Devuelve
 *  null ante cualquier problema -- localStorage tira en modo privado de
 *  algunos navegadores, y el contenido pudo quedar de una versión anterior
 *  con otra forma. */
export function leerGeometria(id: string): GeometriaPanel | null {
  try {
    const crudo = window.localStorage.getItem(PREFIJO_ALMACEN + id);
    if (!crudo) return null;
    const guardado: unknown = JSON.parse(crudo);
    if (typeof guardado !== "object" || guardado === null) return null;
    const { x, y, ancho, alto } = guardado as Record<string, unknown>;
    if (!esNumeroUtil(x) || !esNumeroUtil(y) || !esNumeroUtil(ancho) || !esNumeroUtil(alto)) {
      return null;
    }
    return { x, y, ancho, alto };
  } catch {
    return null;
  }
}

export function guardarGeometria(id: string, geometria: GeometriaPanel) {
  try {
    window.localStorage.setItem(PREFIJO_ALMACEN + id, JSON.stringify(geometria));
  } catch {
    // Que no se pueda recordar dónde quedó el panel no es motivo para
    // romper la pantalla.
  }
}
