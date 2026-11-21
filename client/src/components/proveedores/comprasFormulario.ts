// client/src/components/proveedores/comprasFormulario.ts
//
// Lógica pura del formulario «Registrar compra»: valores iniciales, lo que se sugiere al elegir el proveedor,
// lo que falta o está mal, y el cuerpo que se envía. Sin React ni red. Son las mismas reglas que el
// formulario de Combustible → Cisternas; el servidor las vuelve a validar (son las suyas).
import type {
  CompraDeCisterna,
  CuerpoCompra,
  DatosFormularioCompra,
  TipoCombustibleCompra,
} from "./proveedoresApi";

/** La fecha de hoy en Lima (AAAA-MM-DD): el servidor decide «ya llegó» con ella, no con la UTC. */
export function hoyEnLima(ahora: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(ahora));
}

/** Lo que escribe la persona (todo texto, como sale de los campos). */
export interface FormularioDeCompra {
  grifo_id: string;
  grifo_interno_id: string;
  tipo_combustible: TipoCombustibleCompra;
  unidad: "gal" | "L";
  tipo_documento: "factura" | "guia_remision";
  numero_documento: string;
  fecha_compra: string;
  llegada_estimada: string;
  cantidad_facturada: string;
  costo_unitario: string;
  transportista: string;
  transportista_ruc: string;
}

export function formularioInicial(
  datos: DatosFormularioCompra,
  ahora: number = Date.now()
): FormularioDeCompra {
  const hoy = hoyEnLima(ahora);
  return {
    grifo_id: "",
    // Una sola sede: no hay nada que elegir.
    grifo_interno_id: datos.sedes.length === 1 ? String(datos.sedes[0].id) : "",
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

/** Lo que se rellena solo al elegir el proveedor (o el combustible): la unidad y el transportista de su
 *  última compra, y el precio de compra vigente de ese proveedor para ese combustible. Solo devuelve lo
 *  que sabe: lo que no hay no pisa nada. La última compra no cuenta si se anuló. */
export function sugerenciasPara(
  grifoId: number,
  compras: CompraDeCisterna[],
  datos: DatosFormularioCompra,
  tipoCombustible?: TipoCombustibleCompra
): Partial<FormularioDeCompra> {
  const ultima = [...compras]
    .filter((c) => c.proveedorId === grifoId && c.estado !== "anulada")
    .sort((a, b) => b.id - a.id)[0];
  const combustible: TipoCombustibleCompra =
    tipoCombustible ?? ultima?.tipoCombustible ?? "diesel_b5";
  const sugerido: Partial<FormularioDeCompra> = {};
  if (ultima) {
    sugerido.unidad = ultima.unidad === "L" ? "L" : "gal";
    if (ultima.transportista) sugerido.transportista = ultima.transportista;
    if (ultima.transportistaRuc) sugerido.transportista_ruc = ultima.transportistaRuc;
  }
  if (tipoCombustible === undefined) sugerido.tipo_combustible = combustible;
  const precio = datos.precios.find(
    (p) => p.grifo_id === grifoId && p.tipo_combustible === combustible
  );
  if (precio) sugerido.costo_unitario = String(Number(precio.precio_unitario));
  return sugerido;
}

/** El precio vigente de un proveedor para un combustible, si lo hay (para el aviso del formulario). */
export function precioVigenteDe(
  grifoId: number,
  tipo: TipoCombustibleCompra,
  datos: DatosFormularioCompra
): number | null {
  const p = datos.precios.find((x) => x.grifo_id === grifoId && x.tipo_combustible === tipo);
  return p ? Number(p.precio_unitario) : null;
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

/** El cuerpo de `POST /compras`. Los textos vacíos no se mandan. */
export function cuerpoDeLaCompra(f: FormularioDeCompra, clienteUuid: string): CuerpoCompra {
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
