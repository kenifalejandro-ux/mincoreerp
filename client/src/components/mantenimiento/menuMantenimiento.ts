// client/src/components/mantenimiento/menuMantenimiento.ts
//
// Qué lleva el menú lateral del ecosistema, sin React: los grupos, sus entradas y cuáles ya existen. Lo que
// todavía no está construido sale en su sitio con la marca «Pronto», como en la maqueta, y no se esconde.
//
// Autonomía: el ecosistema no exige ningún otro módulo. Las entradas de los módulos vecinos (Checklists,
// Órdenes de trabajo, Almacén, IPERC) solo se dibujan si la persona TIENE ese módulo, como lo hace la maqueta
// con los módulos que la empresa enciende; sin él, no hay entrada ni pantalla rota.
import type { SeccionDeRuta } from "./rutaMantenimiento";
import { tieneModulo } from "../../modules/tieneModulo";

export type IconoDeMenu =
  | "centro"
  | "equipos"
  | "checklists"
  | "ordenes"
  | "preventivo"
  | "indicadores"
  | "historial"
  | "almacen"
  | "iperc";

export interface EntradaDelMenu {
  /** Una sección que ya existe (se abre) o un id propio de una que llega después. */
  id: string;
  label: string;
  icono: IconoDeMenu;
  /** Todavía no existe: se dibuja apagada con «Pronto». */
  pronto: boolean;
  /** Se muestra solo si la persona tiene este módulo. */
  requiereModulo?: string;
}

export interface GrupoDelMenu {
  etiqueta: string;
  entradas: EntradaDelMenu[];
}

const GRUPOS: GrupoDelMenu[] = [
  {
    etiqueta: "Operación",
    entradas: [
      { id: "centro", label: "Centro de mantenimiento", icono: "centro", pronto: false },
      { id: "equipos", label: "Equipos", icono: "equipos", pronto: false },
      {
        id: "checklists",
        label: "Checklists",
        icono: "checklists",
        pronto: true,
        requiereModulo: "checklists",
      },
      {
        id: "ordenes",
        label: "Órdenes de trabajo",
        icono: "ordenes",
        pronto: true,
        requiereModulo: "ordenes_trabajo",
      },
      { id: "preventivo", label: "Mantenimiento preventivo", icono: "preventivo", pronto: true },
    ],
  },
  {
    etiqueta: "Seguimiento",
    entradas: [
      { id: "indicadores", label: "Indicadores", icono: "indicadores", pronto: true },
      { id: "historial", label: "Historial", icono: "historial", pronto: true },
    ],
  },
  {
    etiqueta: "Recursos conectados",
    entradas: [
      {
        id: "almacen",
        label: "Almacén",
        icono: "almacen",
        pronto: true,
        requiereModulo: "repuestos",
      },
      {
        id: "iperc",
        label: "Seguridad · IPERC",
        icono: "iperc",
        pronto: true,
        requiereModulo: "iperc",
      },
    ],
  },
];

/** Los grupos que esta persona ve: sin las entradas de módulos que no tiene y sin grupos que quedan vacíos. */
export function gruposDelMenu(usuario: { modulosPermitidos: string[] } | null | undefined) {
  return GRUPOS.map((g) => ({
    ...g,
    entradas: g.entradas.filter((e) => !e.requiereModulo || tieneModulo(usuario, e.requiereModulo)),
  })).filter((g) => g.entradas.length > 0);
}

/** ¿Esta entrada abre una pantalla? Solo las secciones que existen. */
export function esSeccion(id: string): id is SeccionDeRuta {
  return id === "centro" || id === "equipos" || id === "configuracion";
}

/** La insignia numérica de una entrada, o null si no lleva. Hoy solo Equipos: las unidades de Operaciones por
 *  completar (0 sin Flota, el servidor lo decide). */
export function insigniaDe(id: string, porImportar: number): number | null {
  return id === "equipos" && porImportar > 0 ? porImportar : null;
}

/** Cuántos módulos vecinos comparten datos con el ecosistema hoy: solo Flota, que comparte el maestro de
 *  equipos. Los demás se cuentan cuando de verdad se integren. */
export function modulosIntegrados(usuario: { modulosPermitidos: string[] } | null | undefined) {
  return tieneModulo(usuario, "flota") ? 1 : 0;
}
