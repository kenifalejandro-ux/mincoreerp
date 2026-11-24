// client/src/ecosistemas/iconos.ts
//
// Los íconos (lucide) de los ecosistemas, por el nombre que pide cada declaración. Aparte de `ecosistemas.ts`
// para que esa declaración no dependa de librerías del cliente y se pueda probar sin ellas.
import { Building2, LayoutDashboard, Wrench, type LucideIcon } from "lucide-react";

import type { NombreDeIcono } from "./ecosistemas";

const ICONOS: Record<NombreDeIcono, LucideIcon> = {
  edificio: Building2,
  panel: LayoutDashboard,
  herramienta: Wrench,
};

export function iconoDe(nombre: NombreDeIcono): LucideIcon {
  return ICONOS[nombre];
}
