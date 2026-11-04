// Los tipos de lo que devuelve el servidor para las cisternas. Van en un .ts aparte (no dentro de las
// pantallas .tsx) para que la lógica pura y sus pruebas puedan importarlos: el compilador de la raíz
// no compila JSX y se negaría a resolver un import de un .tsx, ni siquiera para un tipo.

/** Una cisterna con saldo, tal como la reparte el modal (migración 0168). */
export interface CisternaConSaldo {
  id: string;
  cantidad: string;
  saldo: string;
  recepcion_id: string;
  recibido_en: string;
  costo_unitario: string;
  tanque_codigo: string;
  tipo_combustible: "diesel_b5" | "gasolina_90" | "glp";
  unidad: string;
  grifo_interno_id: number | null;
  proveedor: string | null;
}

export interface SalidaDeCisterna {
  id: string;
  tipo: "unidad" | "tanqueta" | "tanque";
  cantidad: string;
  fecha: string;
  /** Placa, código de tanqueta o de tanque. Sin Flota la placa no viene. */
  destino: string | null;
}

/** Una cisterna de la pestaña "Cisternas": con saldo, vaciada o de una recepción anulada. */
export interface CisternaDeLista extends CisternaConSaldo {
  estado: "con_saldo" | "vaciada" | "anulada";
  /** El proveedor de la recepción (para filtrar el historial); null si no tiene. */
  proveedor_id: number | null;
  salidas: SalidaDeCisterna[];
  /** Días que se le dan a una cisterna con saldo antes de alertar. Ausente: sin color de plazo. */
  plazo_dias?: number | null;
  /** Solo en las anuladas: quién, cuándo y por qué. */
  anulada_en?: string | null;
  anulada_por_nombre?: string | null;
  motivo_anulacion?: string | null;
}
