// La lógica de "Registrar compra" y de la lista de compras, aparte de la pantalla para probarla con
// datos sueltos: qué se rellena solo al elegir el proveedor, qué falta antes de enviar, el cuerpo que
// se manda y cómo se filtra la lista.
import type {
  CompraDeCisterna,
  DatosParaElFormulario,
  EstadoDeCompra,
  TipoCombustibleDeCompra,
  TipoDocumentoDeCompra,
} from "./comprasCisternaTipos";

export const ETIQUETA_COMBUSTIBLE: Record<TipoCombustibleDeCompra, string> = {
  diesel_b5: "Diésel B5",
  gasolina_90: "Gasolina 90",
  glp: "GLP",
};

export const ETIQUETA_DOCUMENTO: Record<TipoDocumentoDeCompra, string> = {
  guia_remision: "Guía de remisión",
  factura: "Factura",
};

export const ETIQUETA_ESTADO: Record<EstadoDeCompra, string> = {
  registrada: "Registrada",
  por_llegar: "Por llegar",
  recibida: "Recibida",
  anulada: "Anulada",
};

/** La fecha de hoy en Lima (AAAA-MM-DD): el servidor decide "ya llegó" con ella, no con la UTC. */
export function hoyEnLima(ahora: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(ahora));
}

/** Lo que el formulario escribe el usuario (todo texto, como sale de los campos). */
export interface FormularioDeCompra {
  grifo_id: string;
  grifo_interno_id: string;
  tipo_combustible: TipoCombustibleDeCompra;
  unidad: "gal" | "L";
  tipo_documento: TipoDocumentoDeCompra;
  numero_documento: string;
  fecha_compra: string;
  llegada_estimada: string;
  cantidad_facturada: string;
  costo_unitario: string;
  transportista: string;
  transportista_ruc: string;
}

export function formularioInicial(ahora: number = Date.now()): FormularioDeCompra {
  const hoy = hoyEnLima(ahora);
  return {
    grifo_id: "",
    grifo_interno_id: "",
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_documento: "guia_remision",
    numero_documento: "",
    fecha_compra: hoy,
    llegada_estimada: hoy,
    cantidad_facturada: "",
    costo_unitario: "",
    transportista: "",
    transportista_ruc: "",
  };
}

/** Lo que se rellena solo al elegir el proveedor: la sede, el combustible y el transportista de su
 *  última compra, y el precio de compra vigente de ese proveedor para ese combustible. Solo
 *  devuelve lo que sabe: lo que no hay no pisa nada. La última compra no cuenta si se anuló. */
export function sugerenciasPara(
  grifoId: number,
  compras: CompraDeCisterna[],
  datos: DatosParaElFormulario,
  tipoCombustible?: TipoCombustibleDeCompra
): Partial<FormularioDeCompra> {
  const ultima = compras
    .filter((c) => c.grifo_id === grifoId && c.estado !== "anulada")
    .sort((a, b) => b.creado_en.localeCompare(a.creado_en) || Number(b.id) - Number(a.id))[0];
  const combustible: TipoCombustibleDeCompra =
    tipoCombustible ?? ultima?.tipo_combustible ?? "diesel_b5";
  const sugerido: Partial<FormularioDeCompra> = {};
  if (ultima) {
    sugerido.grifo_interno_id = String(ultima.grifo_interno_id);
    sugerido.unidad = ultima.unidad;
    if (ultima.transportista) sugerido.transportista = ultima.transportista;
    if (ultima.transportista_ruc) sugerido.transportista_ruc = ultima.transportista_ruc;
  }
  if (!sugerido.grifo_interno_id && datos.sedes.length === 1) {
    sugerido.grifo_interno_id = String(datos.sedes[0].id);
  }
  if (tipoCombustible === undefined) sugerido.tipo_combustible = combustible;
  const precio = datos.precios.find(
    (p) => p.grifo_id === grifoId && p.tipo_combustible === combustible
  );
  if (precio) sugerido.costo_unitario = String(Number(precio.precio_unitario));
  return sugerido;
}

/** Lo que falta o está mal antes de enviar, en palabras; vacío si se puede enviar. */
export function problemasDeLaCompra(f: FormularioDeCompra): string[] {
  const problemas: string[] = [];
  if (f.grifo_id === "") problemas.push("Elige el proveedor.");
  if (f.grifo_interno_id === "") problemas.push("Elige la sede a la que llega.");
  if (f.numero_documento.trim() === "") problemas.push("Escribe el número del documento.");
  if (f.fecha_compra === "") problemas.push("Pon la fecha de emisión.");
  if (f.llegada_estimada === "") problemas.push("Pon la llegada a planta.");
  if (f.fecha_compra !== "" && f.llegada_estimada !== "" && f.llegada_estimada < f.fecha_compra) {
    problemas.push("La llegada no puede ser antes de la emisión.");
  }
  if (!(Number(f.cantidad_facturada) > 0))
    problemas.push("La cantidad tiene que ser mayor que cero.");
  if (!(Number(f.costo_unitario) > 0)) problemas.push("Falta el costo por unidad.");
  const ruc = f.transportista_ruc.trim();
  if (ruc !== "" && !/^\d{11}$/.test(ruc))
    problemas.push("El RUC del transportista tiene 11 dígitos.");
  if (ruc !== "" && f.transportista.trim() === "") {
    problemas.push("Si pones el RUC del transportista, pon también su nombre.");
  }
  return problemas;
}

/** El cuerpo de POST /compras-cisterna. Los textos vacíos no se mandan. */
export function cuerpoDeLaCompra(f: FormularioDeCompra, clienteUuid: string) {
  const texto = (v: string) => (v.trim() === "" ? undefined : v.trim());
  return {
    cliente_uuid: clienteUuid,
    grifo_interno_id: Number(f.grifo_interno_id),
    grifo_id: Number(f.grifo_id),
    tipo_combustible: f.tipo_combustible,
    unidad: f.unidad,
    tipo_documento: f.tipo_documento,
    numero_documento: f.numero_documento.trim(),
    fecha_compra: f.fecha_compra,
    llegada_estimada: f.llegada_estimada,
    cantidad_facturada: Number(f.cantidad_facturada),
    costo_unitario: Number(f.costo_unitario),
    transportista: texto(f.transportista),
    transportista_ruc: texto(f.transportista_ruc),
  };
}

export type FiltroDeEstado = "pendientes" | "recibidas" | "anuladas" | "todas";

/** "Pendientes" son las que todavía no se descargaron ni se anularon: lo que la encargada vigila. */
export function filtrarCompras(
  compras: CompraDeCisterna[],
  estado: FiltroDeEstado,
  proveedor: string
): CompraDeCisterna[] {
  return compras.filter((c) => {
    if (proveedor !== "" && String(c.grifo_id) !== proveedor) return false;
    if (estado === "todas") return true;
    if (estado === "recibidas") return c.estado === "recibida";
    if (estado === "anuladas") return c.estado === "anulada";
    return c.estado === "registrada" || c.estado === "por_llegar";
  });
}

/** Los proveedores que aparecen en la lista, sin repetir y por nombre. */
export function proveedoresDeCompras(
  compras: CompraDeCisterna[]
): { valor: string; nombre: string }[] {
  const vistos = new Map<string, string>();
  for (const c of compras) vistos.set(String(c.grifo_id), c.proveedor);
  return [...vistos]
    .map(([valor, nombre]) => ({ valor, nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

/** Cuántos días faltan para la llegada (negativo: ya pasó). Fechas AAAA-MM-DD. */
export function diasParaLaLlegada(llegada: string, hoy: string): number {
  const ms = (f: string) => new Date(`${f}T00:00:00Z`).getTime();
  return Math.round((ms(llegada) - ms(hoy)) / 86_400_000);
}
