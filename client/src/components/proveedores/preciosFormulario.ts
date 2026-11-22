// client/src/components/proveedores/preciosFormulario.ts
//
// Lógica pura del formulario «Nuevo precio» (Gestión comercial): valores iniciales, la variación contra el
// precio vigente, cuándo pedir confirmación, lo que falta y el cuerpo que se envía. Sin React ni red. Son
// las mismas reglas que Combustible → Precios; el servidor las vuelve a validar (son las suyas).
import type {
  CuerpoPrecioUrea,
  CuerpoPreciosCombustible,
  DatosFormularioPrecio,
  FilaPrecio,
  TipoCombustibleDePrecio,
} from "./proveedoresApi";

/** Un salto mayor a este porcentaje (hacia arriba o abajo) pide confirmación explícita. */
export const UMBRAL_CONFIRMACION_PCT = 50;
/** Hacia adelante, un año: más allá es casi seguro un error de tipeo (el servidor lo rechaza igual). */
const TOPE_FUTURO_DIAS = 366;

export type ProductoDePrecio = "combustible" | "urea";

/** Lo que escribe la persona (todo texto, como sale de los campos). */
export interface FormularioDePrecio {
  producto: ProductoDePrecio;
  tipo_combustible: TipoCombustibleDePrecio;
  /** Combustible: varios proveedores a la vez. */
  grifo_ids: number[];
  /** Urea: un proveedor. */
  grifo_id: string;
  presentacion: string;
  marca: string;
  precio: string;
  /** Valor de un `datetime-local` («AAAA-MM-DDTHH:mm», hora local) o vacío = desde ahora. */
  vigente_desde: string;
  /** «Vigencia hasta» (opcional): un día, «AAAA-MM-DD», o vacío = sin fecha. Solo una alerta de vencimiento. */
  vigente_hasta: string;
  /** Marcó la confirmación del cambio grande. */
  confirmado: boolean;
}

export function formularioInicialDePrecio(
  datos: DatosFormularioPrecio,
  proveedorInicial?: number
): FormularioDePrecio {
  const producto: ProductoDePrecio = datos.combustible ? "combustible" : "urea";
  const esDeCombustible = datos.proveedoresCombustible.some((p) => p.id === proveedorInicial);
  const esDeUrea = datos.proveedoresUrea.some((p) => p.id === proveedorInicial);
  return {
    producto: proveedorInicial !== undefined && !esDeCombustible && esDeUrea ? "urea" : producto,
    tipo_combustible: "diesel_b5",
    grifo_ids: proveedorInicial !== undefined && esDeCombustible ? [proveedorInicial] : [],
    grifo_id: proveedorInicial !== undefined && esDeUrea ? String(proveedorInicial) : "",
    presentacion: datos.presentaciones[0]?.codigo ?? "",
    marca: "",
    precio: "",
    vigente_desde: "",
    vigente_hasta: "",
    confirmado: false,
  };
}

const numero = (texto: string) => Number(texto.replace(",", "."));

/** El día de hoy en Lima, AAAA-MM-DD. */
const diaDeLima = (ahora: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(ahora);

/** La variación del precio nuevo contra el vigente de cada proveedor elegido, en %. Solo los que ya tienen
 *  un precio vigente para ese producto. */
export function variacionesContraVigente(
  f: FormularioDePrecio,
  filas: FilaPrecio[]
): { proveedorId: number; pct: number }[] {
  const nuevo = numero(f.precio);
  if (!(nuevo > 0)) return [];
  const elegidos =
    f.producto === "combustible" ? f.grifo_ids : f.grifo_id === "" ? [] : [Number(f.grifo_id)];
  const codigo = f.producto === "combustible" ? f.tipo_combustible : f.presentacion;
  const resultado: { proveedorId: number; pct: number }[] = [];
  for (const id of elegidos) {
    const fila = filas.find(
      (x) => x.proveedorId === id && x.producto === f.producto && x.codigo === codigo
    );
    const vigente = fila?.vigente?.precio;
    if (vigente && vigente > 0)
      resultado.push({ proveedorId: id, pct: ((nuevo - vigente) / vigente) * 100 });
  }
  return resultado;
}

export function necesitaConfirmacion(variaciones: { pct: number }[]): boolean {
  return variaciones.some((v) => Math.abs(v.pct) > UMBRAL_CONFIRMACION_PCT);
}

/** La fecha elegida como instante ISO, `undefined` si se dejó vacía (rige desde ahora), `null` si no es válida. */
export function vigenteDesdeIso(texto: string): string | undefined | null {
  if (texto.trim() === "") return undefined;
  const fecha = new Date(texto);
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
}

/** Lo que falta o está mal antes de enviar, en palabras; vacío si se puede enviar. */
export function problemasDelPrecio(
  f: FormularioDePrecio,
  filas: FilaPrecio[],
  ahora: number = Date.now()
): string[] {
  const problemas: string[] = [];
  if (f.producto === "combustible" && f.grifo_ids.length === 0)
    problemas.push("Elige al menos un proveedor.");
  if (f.producto === "urea") {
    if (f.grifo_id === "") problemas.push("Elige el proveedor.");
    if (f.presentacion === "") problemas.push("Elige la presentación.");
  }
  const precio = numero(f.precio);
  if (!(precio > 0)) problemas.push("Escribe el precio.");
  else if (precio > 100_000) problemas.push("El precio no puede pasar de S/ 100,000.");
  const desde = vigenteDesdeIso(f.vigente_desde);
  if (desde === null) problemas.push("La fecha de vigencia no es válida.");
  else if (desde !== undefined && new Date(desde).getTime() > ahora + TOPE_FUTURO_DIAS * 86_400_000)
    problemas.push("La vigencia no puede estar a más de un año.");
  if (f.vigente_hasta !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.vigente_hasta) || Number.isNaN(Date.parse(f.vigente_hasta)))
      problemas.push("La vigencia hasta no es una fecha válida.");
    else {
      // No puede ser anterior al día en que el precio empieza a regir (si no se eligió, hoy).
      const desdeDia = f.vigente_desde !== "" ? f.vigente_desde.slice(0, 10) : diaDeLima(ahora);
      if (f.vigente_hasta < desdeDia)
        problemas.push("La vigencia hasta no puede ser anterior a la fecha desde la que rige.");
    }
  }
  if (necesitaConfirmacion(variacionesContraVigente(f, filas)) && !f.confirmado)
    problemas.push(`El cambio es de más de ${UMBRAL_CONFIRMACION_PCT} %: marca la confirmación.`);
  return problemas;
}

/** El cuerpo de la petición según el producto. */
export function cuerpoDelPrecio(
  f: FormularioDePrecio
):
  | { producto: "combustible"; cuerpo: CuerpoPreciosCombustible }
  | { producto: "urea"; cuerpo: CuerpoPrecioUrea } {
  const desde = vigenteDesdeIso(f.vigente_desde) ?? undefined;
  if (f.producto === "combustible") {
    return {
      producto: "combustible",
      cuerpo: {
        tipo_combustible: f.tipo_combustible,
        grifo_ids: f.grifo_ids,
        precio_unitario: numero(f.precio),
        vigente_desde: desde,
        vigente_hasta: f.vigente_hasta === "" ? undefined : f.vigente_hasta,
      },
    };
  }
  return {
    producto: "urea",
    cuerpo: {
      grifo_id: Number(f.grifo_id),
      presentacion: f.presentacion,
      marca: f.marca.trim() === "" ? undefined : f.marca.trim(),
      precio_por_bulto: numero(f.precio),
      vigente_desde: desde,
      vigente_hasta: f.vigente_hasta === "" ? undefined : f.vigente_hasta,
    },
  };
}
