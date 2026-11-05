// La historia de la recepción de una cisterna, en renglones que se leen sin abrir ninguna tabla:
// cuánto dejó el proveedor, cuánto entró al tanque y adónde fue el sobrante. Aparte de la pantalla
// para probarla con números sueltos.
import type { CisternaDeLista, LineaDeReparto, MovimientoDeCisterna } from "./cisternasTipos";

export interface RenglonDelDesglose {
  clave: string;
  texto: string;
  cantidad: number;
  /** Lo que sigue en la cisterna: se resalta. */
  enCisterna?: boolean;
}

const TEXTO_DE_LINEA: Record<LineaDeReparto["destino"], (nombre: string | null) => string> = {
  cubeta: (n) => (n ? `A la tanqueta ${n}` : "A una tanqueta"),
  equipo: (n) => (n ? `Directo a la unidad ${n}` : "Directo a una unidad"),
  devolucion: () => "Devuelto al proveedor",
  cisterna: () => "Quedó en la cisterna",
};

const ORDEN_DE_DESTINO: LineaDeReparto["destino"][] = [
  "cubeta",
  "equipo",
  "devolucion",
  "cisterna",
];

/** Los renglones de "adónde fue lo que llegó": primero lo que entró al tanque, después el sobrante
 *  por destino. Vacío si el servidor no mandó el desglose (datos viejos de la caché). */
export function renglonesDelDesglose(c: CisternaDeLista): RenglonDelDesglose[] {
  if (c.al_tanque === undefined || c.reparto === undefined) return [];
  const filas: RenglonDelDesglose[] = [];
  const alTanque = Number(c.al_tanque);
  if (alTanque > 0) {
    filas.push({
      clave: "tanque",
      texto: `Al tanque ${c.tanque_codigo}`,
      cantidad: alTanque,
    });
  }
  const lineas = [...c.reparto].sort(
    (a, b) =>
      ORDEN_DE_DESTINO.indexOf(a.destino) - ORDEN_DE_DESTINO.indexOf(b.destino) ||
      Number(a.id) - Number(b.id)
  );
  for (const l of lineas) {
    filas.push({
      clave: l.id,
      texto: TEXTO_DE_LINEA[l.destino](l.destino_nombre),
      cantidad: Number(l.cantidad),
      enCisterna: l.destino === "cisterna",
    });
  }
  return filas;
}

/** Lo que dejó el proveedor en total; si el servidor no lo mandó, lo que se sabe de la cisterna. */
export function totalEntregado(c: CisternaDeLista): number {
  return Number(c.entregado ?? c.cantidad);
}

/** El nombre de una fila del kardex de la cisterna. */
export function textoDelMovimiento(m: MovimientoDeCisterna): string {
  if (m.tipo === "entrada") return "Quedó al recibir";
  const que = { unidad: "A la unidad", tanqueta: "A la tanqueta", tanque: "Pase al tanque" }[
    m.tipo
  ];
  return m.destino ? `${que} ${m.destino}` : que;
}

const ETIQUETA_DOCUMENTO: Record<string, string> = {
  factura: "Factura",
  guia_remision: "Guía de remisión",
};

/** Las líneas de "de dónde viene esta cisterna": proveedor, documento, costo y transporte. Solo las
 *  que se saben: una cisterna de antes de las compras no trae documento ni transporte y esas líneas
 *  no salen. */
export function lineasDeOrigen(c: CisternaDeLista): { etiqueta: string; valor: string }[] {
  const lineas: { etiqueta: string; valor: string }[] = [];
  if (c.numero_documento) {
    const tipo = c.tipo_documento
      ? (ETIQUETA_DOCUMENTO[c.tipo_documento] ?? c.tipo_documento)
      : "Documento";
    lineas.push({ etiqueta: tipo, valor: c.numero_documento });
  }
  const costo = Number(c.costo_unitario);
  if (Number.isFinite(costo) && costo > 0) {
    lineas.push({
      etiqueta: `Costo por ${c.unidad}`,
      valor: costo.toLocaleString("es-PE", { maximumFractionDigits: 4 }),
    });
  }
  if (c.transportista) {
    lineas.push({
      etiqueta: "Transporte",
      valor: c.transportista_ruc
        ? `${c.transportista} · RUC ${c.transportista_ruc}`
        : c.transportista,
    });
  }
  return lineas;
}

/** Lo que decía el documento contra lo descargado: la línea de la diferencia. null sin compra (no
 *  hay documento contra qué comparar). `fuera` es true pasada la tolerancia, que es de la empresa. */
export function diferenciaConElDocumento(
  c: CisternaDeLista
): { texto: string; fuera: boolean } | null {
  if (c.diferencia_compra_galones == null || c.compra_cantidad == null) return null;
  const dif = Number(c.diferencia_compra_galones);
  if (!Number.isFinite(dif)) return null;
  const tolerancia = Number(c.tolerancia_galones ?? 3);
  const f = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 2 });
  const unidad = c.compra_unidad ?? "gal";
  const signo = dif > 0 ? "+" : dif < 0 ? "−" : "";
  return {
    texto: `Documento ${f(Number(c.compra_cantidad))} ${unidad} · Descargado ${f(totalEntregado(c))} ${c.unidad} · ${dif === 0 ? "sin diferencia" : `${signo}${f(Math.abs(dif))} gal`}`,
    fuera: Math.abs(dif) > tolerancia,
  };
}

/** El detalle de un movimiento del kardex: la hora, quién lo registró y su vale. Lo que no se sabe
 *  no sale. La fecha sola ya la muestra la fila. */
export function detalleDelMovimiento(m: MovimientoDeCisterna): string {
  const partes: string[] = [];
  const t = new Date(m.fecha);
  if (!Number.isNaN(t.getTime())) {
    partes.push(t.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }));
  }
  if (m.por) partes.push(m.por);
  if (m.vale) partes.push(`vale ${m.vale}`);
  return partes.join(" · ");
}
