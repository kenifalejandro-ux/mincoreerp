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
