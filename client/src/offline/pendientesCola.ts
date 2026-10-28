// client/src/offline/pendientesCola.ts
//
// Qué de lo que hay en la cola del equipo se muestra en un historial como
// "pendiente de enviar". Sin esto, lo registrado sin señal no aparece en
// ninguna parte hasta sincronizar, y quien lo registró no tiene cómo saber que
// quedó guardado.
//
// Función pura sobre las entradas de la cola (que guardan el body ya
// serializado): no sabe de React ni de IndexedDB, así se prueba aparte.

import type { EntradaCola } from "./offlineQueue";
import { ETIQUETA_COMBUSTIBLE } from "../components/combustible/preciosUnificados";

/** `compras`: Compra en ruta y Tanques (compra en ruta o carga desde tanqueta).
 *  `urea`: el historial de compras de urea en ruta. */
export type AmbitoPendiente = "compras" | "urea";

export interface Pendiente {
  clienteUuid: string;
  titulo: string;
  fecha: string | null;
  detalle: string;
  creadoEn: number;
}

const RUTA_COMPRAS = "/api/erp/combustible/compras-ruta";
const RUTA_DESPACHOS = "/api/erp/combustible/despachos";

function soloRuta(url: string): string {
  const sinOrigen = url.startsWith("http") ? new URL(url).pathname : url;
  const ruta = (sinOrigen.split("?")[0] ?? "").split("#")[0] ?? "";
  return ruta.length > 1 && ruta.endsWith("/") ? ruta.slice(0, -1) : ruta;
}

interface LineaUrea {
  presentacion?: string;
  cantidad_bultos?: number;
}

function textoUrea(lineas: LineaUrea[] | undefined): string {
  if (!lineas?.length) return "Urea";
  return `Urea: ${lineas.map((l) => `${l.cantidad_bultos ?? "?"}× ${l.presentacion ?? "envase"}`).join(", ")}`;
}

/** "diesel_b5" -> "Diésel B5"; un código que no se conoce se muestra tal cual. */
function nombreCombustible(codigo: unknown): string {
  if (typeof codigo !== "string") return "Combustible";
  return (ETIQUETA_COMBUSTIBLE as Record<string, string>)[codigo] ?? codigo;
}

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function tituloComprobante(b: Record<string, unknown>, porDefecto: string): string {
  const tipo = typeof b.comprobante_tipo === "string" ? b.comprobante_tipo : "";
  const numero = typeof b.comprobante_numero === "string" ? b.comprobante_numero : "";
  return `${capitalizar(tipo)} ${numero}`.trim() || porDefecto;
}

/** La entrada como fila de historial, o null si no pertenece a este ámbito
 *  (otra pantalla, una foto suelta, una lectura de varilla...). */
export function pendienteParaHistorial(
  entrada: EntradaCola,
  ambito: AmbitoPendiente
): Pendiente | null {
  if (entrada.metodo.toUpperCase() !== "POST" || !entrada.body) return null;
  const ruta = soloRuta(entrada.url);
  if (ruta !== RUTA_COMPRAS && ruta !== RUTA_DESPACHOS) return null;

  let b: Record<string, unknown>;
  try {
    b = JSON.parse(entrada.body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const fecha = typeof b.despachado_en === "string" ? b.despachado_en : null;
  const base = { clienteUuid: entrada.clienteUuid, fecha, creadoEn: entrada.creadoEn };

  if (ruta === RUTA_COMPRAS) {
    const combustible = b.combustible as
      { tipo_combustible?: string; cantidad?: number; unidad?: string } | undefined;
    const urea = b.urea as { lineas?: LineaUrea[] } | undefined;
    if (ambito === "urea" && !urea) return null;
    const partes: string[] = [];
    if (combustible) {
      partes.push(
        `${nombreCombustible(combustible.tipo_combustible)}: ${combustible.cantidad ?? "?"} ${combustible.unidad === "L" ? "L" : "gal"}`
      );
    }
    if (urea) partes.push(textoUrea(urea.lineas));
    return { ...base, titulo: tituloComprobante(b, "Compra en ruta"), detalle: partes.join(" · ") };
  }

  // /despachos: solo lo que se ve en estos historiales. Un vale del tanque
  // propio o del almacén es de otra pantalla.
  const origen = b.origen;
  const esUrea = b.producto === "urea";
  if (ambito === "urea") {
    if (!esUrea || origen !== "compra_externa") return null;
    const lineas = b.lineas as LineaUrea[] | undefined;
    return { ...base, titulo: tituloComprobante(b, "Compra de urea"), detalle: textoUrea(lineas) };
  }
  if (esUrea || (origen !== "tanqueta" && origen !== "compra_externa")) return null;
  const cantidad = typeof b.cantidad === "number" ? b.cantidad : undefined;
  const titulo =
    origen === "tanqueta" ? "Carga desde tanqueta" : tituloComprobante(b, "Compra en ruta");
  return {
    ...base,
    titulo,
    detalle:
      cantidad !== undefined ? `${nombreCombustible(b.tipo_combustible)}: ${cantidad} gal` : "",
  };
}

export function pendientesDeLaCola(entradas: EntradaCola[], ambito: AmbitoPendiente): Pendiente[] {
  return entradas
    .map((e) => pendienteParaHistorial(e, ambito))
    .filter((p): p is Pendiente => p !== null)
    .sort((a, b) => b.creadoEn - a.creadoEn);
}
