// client/src/components/proveedores/rutaProveedores.ts
//
// La dirección (URL) del ecosistema «Gestión de proveedores». Una por sección y por ficha, para que F5 deje a la
// persona donde estaba, el botón «atrás» funcione y un enlace se pueda guardar o mandar:
//
//   /proveedores                              Centro de gestión
//   /proveedores/directorio                   Directorio
//   /proveedores/directorio/123               ficha del proveedor 123 (Resumen)
//   /proveedores/directorio/123/comercial     su pestaña (datos, contactos, cuentas, comercial, contratos,
//                                             documentos, compras o historial)
//   /proveedores/precios                      Gestión comercial
//   /proveedores/compras                      Compras y recepciones
//   /proveedores/historial                    Historial y auditoría
//   /proveedores/homologacion …               las secciones que todavía son «Pronto» también tienen la suya
//
// Lógica pura, sin React ni `window`: leer una dirección, armarla y titular la pantalla. Una dirección que no
// se entiende (sección desconocida, id raro, pestaña desconocida) se lee como la parte que sí vale y se corrige,
// nunca rompe. Qué sección o pestaña puede ver cada persona NO se decide acá: lo decide el ecosistema.

/** Los ids de sección del ecosistema (los mismos del menú). */
export type SeccionDeRuta =
  | "centro"
  | "directorio"
  | "comercial"
  | "compras"
  | "historial"
  | "homologacion"
  | "documentos"
  | "contratos"
  | "riesgos"
  | "pagos"
  | "evaluacion";

/** Las pestañas de la ficha. «datos» es «Datos generales». */
export type PestanaDeRuta =
  | "resumen"
  | "datos"
  | "contactos"
  | "cuentas"
  | "comercial"
  | "contratos"
  | "documentos"
  | "compras"
  | "historial";

export interface EstadoDeRuta {
  seccion: SeccionDeRuta;
  /** Solo en el Directorio, con una ficha abierta. */
  proveedorId?: number;
  /** Solo con una ficha abierta; ausente = Resumen. */
  pestana?: PestanaDeRuta;
}

export const PREFIJO_DE_RUTA = "/proveedores";

/** Cómo se escribe cada sección en la dirección (en español, no los ids internos). */
const SLUG_DE_SECCION: Record<SeccionDeRuta, string> = {
  centro: "",
  directorio: "directorio",
  comercial: "precios",
  compras: "compras",
  historial: "historial",
  homologacion: "homologacion",
  documentos: "documentos",
  contratos: "contratos",
  riesgos: "riesgos",
  pagos: "pagos",
  evaluacion: "evaluacion",
};

const ETIQUETA_DE_SECCION: Record<SeccionDeRuta, string> = {
  centro: "Centro de gestión",
  directorio: "Directorio de proveedores",
  comercial: "Gestión comercial",
  compras: "Compras y recepciones",
  historial: "Historial y auditoría",
  homologacion: "Homologación",
  documentos: "Gestión documental",
  contratos: "Contratos",
  riesgos: "Riesgos y cumplimiento",
  pagos: "Facturación y pagos",
  evaluacion: "Evaluación y desempeño",
};

const PESTANAS_CON_SLUG: PestanaDeRuta[] = [
  "datos",
  "contactos",
  "cuentas",
  "comercial",
  "contratos",
  "documentos",
  "compras",
  "historial",
];

const SECCION_DE_SLUG = new Map<string, SeccionDeRuta>(
  (Object.entries(SLUG_DE_SECCION) as [SeccionDeRuta, string][])
    .filter(([, slug]) => slug !== "")
    .map(([seccion, slug]) => [slug, seccion])
);

/** ¿Esta dirección es del ecosistema? (`/proveedores` o `/proveedores/…`; no `/proveedoresX`). */
export function esRutaDeProveedores(pathname: string): boolean {
  return pathname === PREFIJO_DE_RUTA || pathname.startsWith(`${PREFIJO_DE_RUTA}/`);
}

/** El estado que describe una dirección, o `null` si no es del ecosistema. Lo que sobra o no se entiende se
 *  descarta: `/proveedores/xyz` es el Centro, `/proveedores/directorio/abc` es el Directorio. */
export function leerRuta(pathname: string): EstadoDeRuta | null {
  if (!esRutaDeProveedores(pathname)) return null;
  const partes = pathname
    .slice(PREFIJO_DE_RUTA.length)
    .split("/")
    .filter((p) => p !== "")
    .map((p) => p.toLowerCase());
  const seccion = partes.length === 0 ? "centro" : SECCION_DE_SLUG.get(partes[0]);
  if (!seccion) return { seccion: "centro" };
  if (seccion !== "directorio") return { seccion };

  const id = partes[1] !== undefined && /^\d{1,9}$/.test(partes[1]) ? Number(partes[1]) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) return { seccion };
  const pestana = PESTANAS_CON_SLUG.find((p) => p === partes[2]);
  return pestana ? { seccion, proveedorId: id, pestana } : { seccion, proveedorId: id };
}

/** La dirección de un estado. La inversa de `leerRuta` para todo estado válido. */
export function rutaDe(estado: EstadoDeRuta): string {
  const slug = SLUG_DE_SECCION[estado.seccion];
  let ruta = slug === "" ? PREFIJO_DE_RUTA : `${PREFIJO_DE_RUTA}/${slug}`;
  if (estado.seccion === "directorio" && estado.proveedorId !== undefined) {
    ruta += `/${estado.proveedorId}`;
    if (estado.pestana && estado.pestana !== "resumen") ruta += `/${estado.pestana}`;
  }
  return ruta;
}

/** El título de la pestaña del navegador: la sección en la que está. */
export function tituloDeRuta(estado: EstadoDeRuta): string {
  return `${ETIQUETA_DE_SECCION[estado.seccion]} · Gestión de proveedores`;
}
