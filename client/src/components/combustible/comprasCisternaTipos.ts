// Los tipos de lo que devuelve el servidor para las compras de cisterna (migraciones 0171 a 0174).
// Van en un .ts aparte (no dentro de las pantallas .tsx) para que la lógica pura y sus pruebas
// puedan importarlos: el compilador de la raíz no compila JSX.

export type EstadoDeCompra = "registrada" | "por_llegar" | "recibida" | "anulada";

export type TipoDocumentoDeCompra = "factura" | "guia_remision";

export type TipoCombustibleDeCompra = "diesel_b5" | "gasolina_90" | "glp";

/** Una compra de cisterna, tal como la lista el servidor. */
export interface CompraDeCisterna {
  id: string;
  grifo_interno_id: number;
  grifo_id: number;
  proveedor: string;
  tipo_combustible: TipoCombustibleDeCompra;
  unidad: "gal" | "L";
  tipo_documento: TipoDocumentoDeCompra;
  numero_documento: string;
  /** AAAA-MM-DD. */
  fecha_compra: string;
  /** AAAA-MM-DD: cuándo llega la cisterna a planta, estimado por la encargada. */
  llegada_estimada: string;
  cantidad_facturada: string;
  costo_unitario: string;
  transportista: string | null;
  transportista_ruc: string | null;
  creado_en: string;
  estado: EstadoDeCompra;
  recepcion_id: string | null;
  motivo_anulacion: string | null;
}

/** Lo que necesita el formulario (GET /compras-cisterna/formulario). */
export interface DatosParaElFormulario {
  proveedores: { id: number; nombre: string }[];
  sedes: { id: number; nombre: string; sede: string }[];
  /** El precio de compra que rige hoy, por proveedor y combustible. */
  precios: {
    grifo_id: number;
    tipo_combustible: TipoCombustibleDeCompra;
    precio_unitario: string;
  }[];
}
