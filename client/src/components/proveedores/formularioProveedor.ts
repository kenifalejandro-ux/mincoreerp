// client/src/components/proveedores/formularioProveedor.ts
//
// Lógica pura del formulario de «Registrar / Editar proveedor» (como la maqueta): razón social, RUC, ciudad y
// dos listas, «Qué suministra» (Combustible, Urea o los dos) y «Abastece a» (Interno, Externo o los dos).
// Las cuatro banderas del servidor (combustible interno/externo, urea interno/externo) salen de esas dos
// listas. Un proveedor que ya existe con una mezcla que las listas no pueden decir (p. ej. combustible interno
// y urea externa) se edita con las cuatro casillas, para no perder lo que ya tiene. Sin React.
import type { DatosProveedor, Proveedor } from "./proveedoresApi";

export type Suministra = "combustible" | "urea" | "ambos";
export type UsoDeProveedor = "interno" | "externo" | "ambos";

export interface Banderas {
  abastece_tanque: boolean;
  abastece_ruta: boolean;
  abastece_urea: boolean;
  abastece_urea_ruta: boolean;
}

export const ETIQUETA_SUMINISTRA: Record<Suministra, string> = {
  combustible: "Combustible",
  urea: "Urea",
  ambos: "Combustible y urea",
};
export const ETIQUETA_USO: Record<UsoDeProveedor, string> = {
  interno: "Interno",
  externo: "Externo",
  ambos: "Interno y externo",
};

export interface FormularioDeProveedor {
  nombre: string;
  ruc: string;
  ciudad: string;
  suministra: Suministra;
  uso: UsoDeProveedor;
  /** Con valor = el proveedor tiene una mezcla que las listas no dicen: se edita con las cuatro casillas. */
  casillas: Banderas | null;
}

/** Las cuatro banderas de lo que dicen las dos listas. */
export function banderasDe(suministra: Suministra, uso: UsoDeProveedor): Banderas {
  const interno = uso === "interno" || uso === "ambos";
  const externo = uso === "externo" || uso === "ambos";
  const comb = suministra === "combustible" || suministra === "ambos";
  const urea = suministra === "urea" || suministra === "ambos";
  return {
    abastece_tanque: comb && interno,
    abastece_ruta: comb && externo,
    abastece_urea: urea && interno,
    abastece_urea_ruta: urea && externo,
  };
}

/** Lo que dicen las dos listas de unas banderas, o `null` si no se pueden decir (mezcla o vacío). */
export function seleccionDe(b: Banderas): { suministra: Suministra; uso: UsoDeProveedor } | null {
  const comb = b.abastece_tanque || b.abastece_ruta;
  const urea = b.abastece_urea || b.abastece_urea_ruta;
  if (!comb && !urea) return null;
  const suministra: Suministra = comb && urea ? "ambos" : comb ? "combustible" : "urea";
  for (const uso of ["interno", "externo", "ambos"] as const) {
    const candidata = banderasDe(suministra, uso);
    if (
      candidata.abastece_tanque === b.abastece_tanque &&
      candidata.abastece_ruta === b.abastece_ruta &&
      candidata.abastece_urea === b.abastece_urea &&
      candidata.abastece_urea_ruta === b.abastece_urea_ruta
    ) {
      return { suministra, uso };
    }
  }
  return null;
}

export const hayBandera = (b: Banderas) =>
  b.abastece_tanque || b.abastece_ruta || b.abastece_urea || b.abastece_urea_ruta;

/** El formulario de un proveedor nuevo (Combustible · Interno, como la maqueta) o el de uno que se edita. */
export function formularioInicial(
  proveedor?: Pick<Proveedor, "nombre" | "ruc" | "combustible" | "urea"> & {
    ciudad?: string | null;
  }
): FormularioDeProveedor {
  if (!proveedor) {
    return {
      nombre: "",
      ruc: "",
      ciudad: "",
      suministra: "combustible",
      uso: "interno",
      casillas: null,
    };
  }
  const banderas: Banderas = {
    abastece_tanque: proveedor.combustible.interno,
    abastece_ruta: proveedor.combustible.externo,
    abastece_urea: proveedor.urea.interno,
    abastece_urea_ruta: proveedor.urea.externo,
  };
  const seleccion = seleccionDe(banderas);
  return {
    nombre: proveedor.nombre,
    ruc: proveedor.ruc ?? "",
    ciudad: proveedor.ciudad ?? "",
    suministra: seleccion?.suministra ?? "combustible",
    uso: seleccion?.uso ?? "interno",
    casillas: seleccion ? null : banderas,
  };
}

/** Lo que falta o está mal antes de enviar, en palabras; vacío si se puede enviar. */
export function problemasDelProveedor(f: FormularioDeProveedor): string[] {
  const problemas: string[] = [];
  if (f.nombre.trim() === "") problemas.push("Escribe el nombre del proveedor.");
  if (f.nombre.trim().length > 150) problemas.push("El nombre no puede pasar de 150 letras.");
  const ruc = f.ruc.trim();
  if (ruc !== "" && !/^\d{11}$/.test(ruc)) problemas.push("El RUC debe tener 11 dígitos.");
  if (f.ciudad.trim().length > 80) problemas.push("La ciudad no puede pasar de 80 letras.");
  if (f.casillas && !hayBandera(f.casillas)) problemas.push("Elige qué abastece el proveedor.");
  return problemas;
}

/** El cuerpo que se envía al servidor. */
export function cuerpoDelProveedor(f: FormularioDeProveedor): DatosProveedor {
  return {
    nombre: f.nombre.trim(),
    ruc: f.ruc.trim(),
    ciudad: f.ciudad.trim(),
    ...(f.casillas ?? banderasDe(f.suministra, f.uso)),
  };
}
