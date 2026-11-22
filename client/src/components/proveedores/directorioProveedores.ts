// client/src/components/proveedores/directorioProveedores.ts
//
// Lógica pura del Directorio de proveedores (como la maqueta): a qué abastece cada proveedor, el filtro y
// las cuatro mini-tarjetas. Sin React ni red.
import type { ProveedorEnDirectorio, TipoProveedor } from "./proveedoresApi";

export type FiltroAbastece = "todos" | "interno" | "externo";
export type FiltroEstado = "todos" | "activos" | "inactivos";

export interface FiltrosDelDirectorio {
  busqueda: string;
  tipo: "todos" | TipoProveedor;
  abastece: FiltroAbastece;
  estado: FiltroEstado;
}

/** Interno y externo de un proveedor, juntando combustible y urea (la columna «Abastece a»). */
export function abasteceA(p: Pick<ProveedorEnDirectorio, "combustible" | "urea">): {
  interno: boolean;
  externo: boolean;
} {
  return {
    interno: p.combustible.interno || p.urea.interno,
    externo: p.combustible.externo || p.urea.externo,
  };
}

const sinTildes = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Busca por razón social, código, RUC o ciudad (sin distinguir mayúsculas ni tildes). */
export function filtrarDirectorio(
  lista: ProveedorEnDirectorio[],
  f: FiltrosDelDirectorio
): ProveedorEnDirectorio[] {
  const q = sinTildes(f.busqueda.trim());
  return lista.filter((p) => {
    if (q && !sinTildes(`${p.nombre} ${p.codigo} ${p.ruc ?? ""} ${p.ciudad ?? ""}`).includes(q))
      return false;
    if (f.tipo !== "todos" && !p.tipos.includes(f.tipo)) return false;
    const uso = abasteceA(p);
    if (f.abastece === "interno" && !uso.interno) return false;
    if (f.abastece === "externo" && !uso.externo) return false;
    if (f.estado === "activos" && !p.activo) return false;
    if (f.estado === "inactivos" && p.activo) return false;
    return true;
  });
}

/** Las cuatro mini-tarjetas: total, activos, y cuántos son de combustible y de urea. */
export function resumenDelDirectorio(lista: ProveedorEnDirectorio[]) {
  return {
    total: lista.length,
    activos: lista.filter((p) => p.activo).length,
    combustible: lista.filter((p) => p.tipos.includes("Combustible")).length,
    urea: lista.filter((p) => p.tipos.includes("Urea")).length,
  };
}

/** Por debajo de este porcentaje la barra de «Ficha completa» sale ámbar (como la maqueta). */
export const FICHA_COMPLETA_MINIMA = 80;

export const fichaIncompleta = (porcentaje: number) => porcentaje < FICHA_COMPLETA_MINIMA;

/** «S/ 15.80» */
export const dineroDelDirectorio = (precio: number) => `S/ ${precio.toFixed(2)}`;
