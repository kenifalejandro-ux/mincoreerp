// client/src/ecosistemas/ecosistemas.ts
//
// Registro central de los ecosistemas de MinCoreERP.
//
// Un ecosistema es un espacio independiente dentro del ERP:
// - Menú propio.
// - Cabecera propia.
// - Identidad visual propia.
// - Dirección propia.
// - Control de acceso independiente.
//
// App.tsx, el menú y los tests consultan este registro.
// Para agregar un ecosistema nuevo, basta con declararlo aquí
// y conectar su módulo correspondiente.
//
// IMPORTANTE:
// - Un ecosistema no exige ningún otro módulo.
// - puedeVer() evalúa únicamente los módulos propios.
// - Las pestañas internas gestionan sus dependencias por separado.
// - La seguridad real también debe validarse en el backend.

import { puedeVerMantenimiento } from "../components/mantenimiento/mantenimientoAcceso";
import { PREFIJO_DE_RUTA as PREFIJO_DE_MANTENIMIENTO } from "../components/mantenimiento/rutaMantenimiento";
import { puedeVerProveedores } from "../components/proveedores/proveedoresAcceso";
import { PREFIJO_DE_RUTA as PREFIJO_DE_PROVEEDORES } from "../components/proveedores/rutaProveedores";

// -----------------------------------------------------------------------------
// TIPOS
// -----------------------------------------------------------------------------

type UsuarioDeEcosistema =
  | {
      modulosPermitidos: string[];
    }
  | null
  | undefined;

/**
 * Íconos disponibles para los ecosistemas.
 * Se resuelven centralmente desde iconos.ts.
 */
export type NombreDeIcono = "edificio" | "panel" | "herramienta" | "engranaje";

/**
 * Identidad cromática de cada ecosistema.
 *
 * lima     -> Proveedores
 * naranja  -> Gestión de Flotas / Mantenimiento
 * azul     -> Operaciones
 */
export type AcentoDeEcosistema = "lima" | "naranja" | "azul";

/**
 * Cada elemento del submenú representa una pestaña interna.
 */
export interface EntradaDeSubmenu {
  readonly tab: string;
  readonly label: string;
  readonly icono: NombreDeIcono;
  readonly imagen?: string;
}

/**
 * Definición completa de un ecosistema.
 */
export interface DefinicionDeEcosistema {
  /** Identificador único del ecosistema. */
  readonly id: string;

  /** Nombre que aparece en la pantalla de carga y en el menú. */
  readonly titulo: string;

  /** Imagen de identidad visual del ecosistema. */
  readonly imagen?: string;

  /** Ícono principal. */
  readonly icono: NombreDeIcono;

  /** Color identificativo del ecosistema. */
  readonly acento?: AcentoDeEcosistema;

  /**
   * Módulos que pertenecen a este ecosistema.
   * No son dependencias obligatorias.
   */
  readonly modulos: readonly string[];

  /** Prefijo de las direcciones del ecosistema. */
  readonly prefijoDeRuta: string;

  /** Pestaña inicial al entrar. */
  readonly pestaniaDeEntrada: string;

  /** Elementos del menú interno. */
  readonly submenu: readonly EntradaDeSubmenu[];

  /** Identificador de novedad, si corresponde. */
  readonly novedad?: string;

  /**
   * Determina si el usuario puede acceder al ecosistema.
   * Evalúa únicamente los módulos propios.
   */
  readonly puedeVer: (usuario: UsuarioDeEcosistema) => boolean;
}

// -----------------------------------------------------------------------------
// REGISTRO CENTRAL DE ECOSISTEMAS
// -----------------------------------------------------------------------------

export const ECOSISTEMAS = [
  {
    id: "proveedores",
    titulo: "Gestión de proveedores",

    imagen: "/ecosistemas/ecosistema_vendor.png",
    icono: "edificio",
    acento: "lima",

    modulos: ["proveedores"],

    prefijoDeRuta: PREFIJO_DE_PROVEEDORES,

    pestaniaDeEntrada: "proveedores:centro",

    submenu: [
      {
        tab: "proveedores:centro",
        label: "Centro de administración",
        icono: "panel",
      },
    ],

    novedad: "gestion-proveedores-2026-11",

    puedeVer: puedeVerProveedores,
  },

  {
    id: "mantenimiento",
    titulo: "Gestión de mantenimiento",

    imagen: "/ecosistemas/ecosistema_mantenimiento.png",
    icono: "engranaje",
    acento: "naranja",

    // Actualmente vive aquí su módulo propio.
    // Checklists y Órdenes de trabajo podrán incorporarse posteriormente
    // sin convertirse en requisitos para acceder al ecosistema.
    modulos: ["mantenimiento"],

    prefijoDeRuta: PREFIJO_DE_MANTENIMIENTO,

    pestaniaDeEntrada: "mantenimiento:centro",

    submenu: [
      {
        tab: "mantenimiento:centro",
        label: "Centro de mantenimiento",
        icono: "herramienta",
      },
    ],

    novedad: "gestion-mantenimiento-2026-11",

    puedeVer: puedeVerMantenimiento,
  },
] as const satisfies readonly DefinicionDeEcosistema[];

// -----------------------------------------------------------------------------
// UTILIDADES
// -----------------------------------------------------------------------------

/**
 * Obtiene el módulo detrás de una pestaña.
 *
 * Ejemplo:
 * "combustible:urea" -> "combustible"
 */
export function moduloDeLaPestana(tab: string): string {
  const tabNormalizada = tab.trim();
  const separador = tabNormalizada.indexOf(":");

  return (separador === -1 ? tabNormalizada : tabNormalizada.slice(0, separador)).trim();
}

/**
 * Obtiene el ecosistema al que pertenece un módulo.
 */
export function ecosistemaDeModulo(
  moduloId: string,
  ecosistemas: readonly DefinicionDeEcosistema[] = ECOSISTEMAS
): DefinicionDeEcosistema | undefined {
  return ecosistemas.find((ecosistema) => ecosistema.modulos.includes(moduloId));
}

/**
 * Obtiene el ecosistema al que pertenece una pestaña.
 */
export function ecosistemaDeLaPestana(
  tab: string,
  ecosistemas: readonly DefinicionDeEcosistema[] = ECOSISTEMAS
): DefinicionDeEcosistema | undefined {
  return ecosistemaDeModulo(moduloDeLaPestana(tab), ecosistemas);
}

/**
 * Normaliza una dirección para realizar comparaciones.
 *
 * Ejemplos:
 * "/proveedores/"       -> "/proveedores"
 * "proveedores"         -> "/proveedores"
 * "/proveedores/?x=1"   -> "/proveedores"
 */
function normalizarRuta(ruta: string): string {
  const sinParametros = (ruta.split(/[?#]/, 1)[0] ?? "").trim();

  const conBarraInicial = sinParametros.startsWith("/") ? sinParametros : `/${sinParametros}`;

  const sinBarraFinal = conBarraInicial.replace(/\/+$/, "");

  return sinBarraFinal || "/";
}

/**
 * Determina el ecosistema dueño de una dirección.
 *
 * El prefijo debe representar un segmento completo.
 *
 * Ejemplos:
 * /proveedores                  -> proveedores
 * /proveedores/directorio/3     -> proveedores
 * /proveedores/                 -> proveedores
 * /proveedoresX                 -> undefined
 */
export function ecosistemaDeLaRuta(
  pathname: string,
  ecosistemas: readonly DefinicionDeEcosistema[] = ECOSISTEMAS
): DefinicionDeEcosistema | undefined {
  const ruta = normalizarRuta(pathname);

  return ecosistemas.find((ecosistema) => {
    const prefijo = normalizarRuta(ecosistema.prefijoDeRuta);

    return ruta === prefijo || (prefijo !== "/" && ruta.startsWith(`${prefijo}/`));
  });
}

/**
 * Obtiene todos los módulos que pertenecen a ecosistemas.
 *
 * Se conserva el orden de declaración y se evitan duplicados.
 */
export function modulosDeEcosistemas(
  ecosistemas: readonly DefinicionDeEcosistema[] = ECOSISTEMAS
): string[] {
  return [...new Set(ecosistemas.flatMap((ecosistema) => ecosistema.modulos))];
}
