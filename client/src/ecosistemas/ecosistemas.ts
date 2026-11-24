// client/src/ecosistemas/ecosistemas.ts
//
// Qué ecosistemas existen en el ERP y qué módulos viven dentro de cada uno. Un ecosistema es un espacio
// aparte (menú propio, cabecera propia, dirección propia) al que se entra desde el menú del ERP. Es la ÚNICA
// parte del cliente que nombra a cada uno: App.tsx y el menú lateral solo preguntan por aquí («¿esta pestaña
// es de un ecosistema?», «¿esta dirección?», «¿esta persona lo ve?»), de modo que sumar otro es agregarlo a
// `ECOSISTEMAS` y no tocar quien decide a dónde ir.
//
// Sin JSX, React ni librerías del cliente (los íconos se piden por nombre y los resuelve `iconos.ts`): lo usan
// App.tsx, el menú y los tests, y los tests corren fuera del cliente.
//
// Regla de autonomía (ver feedback de módulos autónomos): un ecosistema no exige ningún otro módulo y
// `puedeVer` mira solo los módulos propios. Las secciones de adentro declaran de qué dependen para mostrarse
// (ver proveedoresAcceso.ts).
import { puedeVerMantenimiento } from "../components/mantenimiento/mantenimientoAcceso";
import { PREFIJO_DE_RUTA as PREFIJO_DE_MANTENIMIENTO } from "../components/mantenimiento/rutaMantenimiento";
import { puedeVerProveedores } from "../components/proveedores/proveedoresAcceso";
import { PREFIJO_DE_RUTA as PREFIJO_DE_PROVEEDORES } from "../components/proveedores/rutaProveedores";

type UsuarioDeEcosistema = { modulosPermitidos: string[] } | null | undefined;

/** Los íconos que un ecosistema puede pedir. Se resuelven en `iconos.ts`. */
export type NombreDeIcono = "edificio" | "panel" | "herramienta";

export interface EntradaDeSubmenu {
  /** La pestaña que abre, con el formato `modulo:seccion` del menú. */
  tab: string;
  label: string;
  icono: NombreDeIcono;
}

export interface DefinicionDeEcosistema {
  /** Identifica al ecosistema (no es un id de módulo). */
  id: string;
  /** Cómo se llama: pantalla de carga y entrada del menú. */
  titulo: string;
  icono: NombreDeIcono;
  /** Los ids de módulo (los del registro) que viven dentro. Su primera pestaña es la puerta. */
  modulos: readonly string[];
  /** El primer tramo de su dirección: `/proveedores`, `/proveedores/directorio`… */
  prefijoDeRuta: string;
  /** La pestaña a la que cae quien llega por una dirección suya. */
  pestaniaDeEntrada: string;
  /** El submenú de su entrada en el menú del ERP (la entrada solo despliega; se entra por él). */
  submenu: readonly EntradaDeSubmenu[];
  /** Clave de la etiqueta «Nuevo» de su entrada (ver controlTv/novedad.ts); sin ella, no lleva. */
  novedad?: string;
  /** Si esta persona ve el ecosistema. Mira solo sus propios módulos. */
  puedeVer: (usuario: UsuarioDeEcosistema) => boolean;
}

export const ECOSISTEMAS: readonly DefinicionDeEcosistema[] = [
  {
    id: "proveedores",
    titulo: "Gestión de proveedores",
    icono: "edificio",
    modulos: ["proveedores"],
    prefijoDeRuta: PREFIJO_DE_PROVEEDORES,
    pestaniaDeEntrada: "proveedores:centro",
    submenu: [{ tab: "proveedores:centro", label: "Centro de administración", icono: "panel" }],
    novedad: "gestion-proveedores-2026-11",
    puedeVer: puedeVerProveedores,
  },
  {
    id: "mantenimiento",
    titulo: "Gestión de mantenimiento",
    icono: "herramienta",
    // Hoy vive aquí solo su módulo propio. Checklists y Órdenes de trabajo seguirán siendo módulos aparte:
    // se sumarán cuando se hospeden dentro, sin que tenerlos sea requisito para ver el ecosistema.
    modulos: ["mantenimiento"],
    prefijoDeRuta: PREFIJO_DE_MANTENIMIENTO,
    pestaniaDeEntrada: "mantenimiento:centro",
    submenu: [{ tab: "mantenimiento:centro", label: "Centro de control", icono: "panel" }],
    novedad: "gestion-mantenimiento-2026-11",
    puedeVer: puedeVerMantenimiento,
  },
];

/** El id del módulo detrás de una pestaña (`combustible:urea` → `combustible`). */
export function moduloDeLaPestana(tab: string): string {
  return tab.split(":")[0];
}

/** El ecosistema al que pertenece un módulo, si pertenece a alguno. */
export function ecosistemaDeModulo(
  moduloId: string,
  ecosistemas: readonly DefinicionDeEcosistema[] = ECOSISTEMAS
): DefinicionDeEcosistema | undefined {
  return ecosistemas.find((e) => e.modulos.includes(moduloId));
}

/** El ecosistema al que pertenece una pestaña, si pertenece a alguno. */
export function ecosistemaDeLaPestana(
  tab: string,
  ecosistemas: readonly DefinicionDeEcosistema[] = ECOSISTEMAS
): DefinicionDeEcosistema | undefined {
  return ecosistemaDeModulo(moduloDeLaPestana(tab), ecosistemas);
}

/** El ecosistema dueño de una dirección (`/proveedores/directorio/3`), si es de alguno. El prefijo debe ser
 *  un tramo completo: `/proveedoresX` no es de `/proveedores`. */
export function ecosistemaDeLaRuta(
  pathname: string,
  ecosistemas: readonly DefinicionDeEcosistema[] = ECOSISTEMAS
): DefinicionDeEcosistema | undefined {
  return ecosistemas.find(
    (e) => pathname === e.prefijoDeRuta || pathname.startsWith(`${e.prefijoDeRuta}/`)
  );
}

/** Los ids de módulo que viven en algún ecosistema, para ordenar el menú (ver ordenDelMenu.ts). */
export function modulosDeEcosistemas(
  ecosistemas: readonly DefinicionDeEcosistema[] = ECOSISTEMAS
): string[] {
  return ecosistemas.flatMap((e) => e.modulos);
}
