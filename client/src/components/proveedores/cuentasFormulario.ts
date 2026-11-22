// client/src/components/proveedores/cuentasFormulario.ts
//
// Lógica pura de las cuentas bancarias del proveedor (PR3b): lo que se escribe en el formulario, lo que
// falta antes de enviar y el cuerpo que se envía. Sin React ni red. El número se limpia (sin espacios ni
// guiones) y el servidor lo vuelve a validar.
import type { CuentaBancaria, CuerpoCuenta, MonedaDePago, TipoDeCuenta } from "./proveedoresApi";

export const TIPOS_DE_CUENTA: { valor: TipoDeCuenta; texto: string }[] = [
  { valor: "corriente", texto: "Corriente" },
  { valor: "ahorros", texto: "Ahorros" },
  { valor: "detraccion", texto: "Detracciones (Banco de la Nación)" },
];

export const textoDeTipoDeCuenta = (tipo: TipoDeCuenta) =>
  TIPOS_DE_CUENTA.find((t) => t.valor === tipo)?.texto ?? tipo;

export const textoDeMonedaDeCuenta = (moneda: MonedaDePago) =>
  moneda === "PEN" ? "Soles (S/)" : "Dólares (US$)";

/** Lo que escribe la persona (todo texto, como sale de los campos). */
export interface FormularioDeCuenta {
  banco: string;
  tipo_cuenta: TipoDeCuenta;
  moneda: MonedaDePago;
  titular: string;
  /** Al editar arranca vacío: vacío = no se cambia el número. */
  numero: string;
  principal: boolean;
}

export function formularioDeCuenta(cuenta?: CuentaBancaria): FormularioDeCuenta {
  return {
    banco: cuenta?.banco ?? "",
    tipo_cuenta: cuenta?.tipoCuenta ?? "corriente",
    moneda: cuenta?.moneda ?? "PEN",
    titular: cuenta?.titular ?? "",
    numero: "",
    principal: cuenta?.principal ?? false,
  };
}

/** Solo los dígitos: se aceptan espacios y guiones al escribir o pegar el número. */
export const limpiarNumero = (texto: string) => texto.replace(/[\s-]/g, "");

/** Lo que falta o está mal antes de enviar, en palabras; vacío si se puede enviar. `editando` = el número
 *  es opcional (vacío = se conserva el que está). */
export function problemasDeLaCuenta(f: FormularioDeCuenta, editando: boolean): string[] {
  const problemas: string[] = [];
  if (f.banco.trim() === "") problemas.push("Escribe el banco.");
  const numero = limpiarNumero(f.numero);
  if (numero === "") {
    if (!editando) problemas.push("Escribe el número de cuenta o CCI.");
  } else if (!/^\d{8,20}$/.test(numero)) {
    problemas.push("El número debe tener de 8 a 20 dígitos.");
  }
  if (f.titular.trim().length > 150) problemas.push("El titular no puede pasar de 150 letras.");
  return problemas;
}

export function cuerpoDeLaCuenta(
  f: FormularioDeCuenta,
  opciones: { clienteUuid?: string } = {}
): CuerpoCuenta {
  const numero = limpiarNumero(f.numero);
  return {
    banco: f.banco.trim(),
    tipo_cuenta: f.tipo_cuenta,
    moneda: f.moneda,
    titular: f.titular.trim() === "" ? null : f.titular.trim(),
    principal: f.principal,
    // Vacío al editar = no se manda: el servidor conserva el número guardado.
    ...(numero === "" ? {} : { numero }),
    ...(opciones.clienteUuid ? { cliente_uuid: opciones.clienteUuid } : {}),
  };
}

/** El número completo en grupos de 4 para leerlo y copiarlo con comodidad. */
export const numeroEnGrupos = (numero: string) => numero.replace(/(.{4})(?=.)/g, "$1 ");
