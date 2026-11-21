// client/src/components/proveedores/fichaFormulario.ts
//
// Lógica pura de la ficha del proveedor (PR3a): los formularios de «Datos y condiciones de pago» y de
// «Contacto», lo que falta antes de enviar, el cuerpo que se envía y cómo se dice una condición de pago.
// Sin React ni red. Son las mismas reglas del servidor, que las vuelve a validar.
import type {
  Contacto,
  CuerpoContacto,
  CuerpoDatosFicha,
  DatosFicha,
  FormaDePago,
  MonedaDePago,
} from "./proveedoresApi";

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEFONO = /^[0-9+()\-\s.]{6,40}$/;

/** Lo que escribe la persona (todo texto, como sale de los campos). */
export interface FormularioDeDatos {
  direccion: string;
  telefono: string;
  correo: string;
  /** "" = sin definir. */
  forma_pago: "" | FormaDePago;
  plazo_pago_dias: string;
  /** "" = sin definir. */
  moneda: "" | MonedaDePago;
}

export interface FormularioDeContacto {
  nombre: string;
  cargo: string;
  telefono: string;
  correo: string;
  principal: boolean;
}

const vacioANull = (texto: string) => (texto.trim() === "" ? null : texto.trim());

export function formularioDeDatos(datos: DatosFicha): FormularioDeDatos {
  return {
    direccion: datos.direccion ?? "",
    telefono: datos.telefono ?? "",
    correo: datos.correo ?? "",
    forma_pago: datos.formaPago ?? "",
    plazo_pago_dias: datos.plazoPagoDias === null ? "" : String(datos.plazoPagoDias),
    moneda: datos.moneda ?? "",
  };
}

/** Lo que falta o está mal antes de enviar, en palabras; vacío si se puede enviar. */
export function problemasDeDatos(f: FormularioDeDatos): string[] {
  const problemas: string[] = [];
  if (f.telefono.trim() !== "" && !TELEFONO.test(f.telefono.trim()))
    problemas.push("El teléfono no es válido.");
  if (f.correo.trim() !== "" && !CORREO.test(f.correo.trim()))
    problemas.push("El correo no es válido.");
  if (f.direccion.trim().length > 250) problemas.push("La dirección no puede pasar de 250 letras.");
  if (f.forma_pago === "credito") {
    const plazo = Number(f.plazo_pago_dias);
    if (!Number.isInteger(plazo) || plazo < 1 || plazo > 365)
      problemas.push("El crédito necesita su plazo: de 1 a 365 días.");
  }
  return problemas;
}

export function cuerpoDeDatos(f: FormularioDeDatos): CuerpoDatosFicha {
  return {
    direccion: vacioANull(f.direccion),
    telefono: vacioANull(f.telefono),
    correo: vacioANull(f.correo),
    forma_pago: f.forma_pago === "" ? null : f.forma_pago,
    // El plazo solo va con crédito: con contado o sin definir se descarta.
    plazo_pago_dias: f.forma_pago === "credito" ? Number(f.plazo_pago_dias) : null,
    moneda: f.moneda === "" ? null : f.moneda,
  };
}

export function formularioDeContacto(contacto?: Contacto): FormularioDeContacto {
  return {
    nombre: contacto?.nombre ?? "",
    cargo: contacto?.cargo ?? "",
    telefono: contacto?.telefono ?? "",
    correo: contacto?.correo ?? "",
    principal: contacto?.principal ?? false,
  };
}

export function problemasDelContacto(f: FormularioDeContacto): string[] {
  const problemas: string[] = [];
  if (f.nombre.trim() === "") problemas.push("Escribe el nombre del contacto.");
  const telefono = f.telefono.trim();
  const correo = f.correo.trim();
  if (telefono === "" && correo === "") problemas.push("Escribe un teléfono o un correo.");
  if (telefono !== "" && !TELEFONO.test(telefono)) problemas.push("El teléfono no es válido.");
  if (correo !== "" && !CORREO.test(correo)) problemas.push("El correo no es válido.");
  return problemas;
}

export function cuerpoDelContacto(f: FormularioDeContacto, clienteUuid?: string): CuerpoContacto {
  return {
    nombre: f.nombre.trim(),
    cargo: vacioANull(f.cargo),
    telefono: vacioANull(f.telefono),
    correo: vacioANull(f.correo),
    principal: f.principal,
    ...(clienteUuid ? { cliente_uuid: clienteUuid } : {}),
  };
}

/** «Contado», «Crédito a 30 días» o «Sin definir». */
export function textoDeFormaDePago(datos: Pick<DatosFicha, "formaPago" | "plazoPagoDias">): string {
  if (datos.formaPago === "contado") return "Contado";
  if (datos.formaPago === "credito")
    return `Crédito a ${datos.plazoPagoDias} ${datos.plazoPagoDias === 1 ? "día" : "días"}`;
  return "Sin definir";
}

export function textoDeMoneda(moneda: MonedaDePago | null): string {
  if (moneda === "PEN") return "Soles (S/)";
  if (moneda === "USD") return "Dólares (US$)";
  return "Sin definir";
}
