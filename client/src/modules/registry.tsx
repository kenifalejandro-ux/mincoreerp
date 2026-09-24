// client/src/modules/registry.tsx
//
// Fuente única del cliente para "qué módulos existen" — ver
// docs/adr/0002-contrato-de-modulo.md. Antes de este archivo, Sidebar.tsx
// y App.tsx tenían cada uno su propia lista hardcodeada, y quedaron
// desincronizadas: Equipos/Checklists/IPERC tenían backend completo pero
// nunca se agregaron acá, así que eran invisibles para cualquier usuario.
//
// `id` DEBE coincidir con un id de src/modules/registry.ts (backend) — o
// sea, con un valor del enum modulo_erp. No se comparte el archivo entre
// server y cliente (son dos builds de Vite/tsx separados); mantener este
// archivo sin ninguna lógica, solo datos + import perezoso, es lo que
// hace barato ese único punto de duplicación.
//
// El componente se carga con React.lazy (code-splitting): el chunk de un
// módulo solo viaja al navegador si ese usuario realmente lo tiene
// habilitado y lo abre — ver App.tsx (<Suspense>).
import {
  ClipboardCheck,
  FileText,
  Fuel,
  Hammer,
  LayoutDashboard,
  ShieldAlert,
  Tractor,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { lazy, type LazyExoticComponent, type ComponentType } from "react";

// Qué escrituras de cada módulo participan de la cola offline se declara en
// ./offlineRegistry.ts, no acá: este archivo es .tsx (React.lazy) y tanto el
// motor de client/src/offline/ como el test que compara ambos registries
// corren donde no hay JSX. Ver el comentario de ese archivo.

export interface ModuloCliente {
  id: string;
  label: string;
  // De trazo (lucide), no emoji: coherente con el resto de la app y con
  // Administración/Facturación, que ya vivían hardcodeadas en Sidebar.tsx
  // con íconos de este mismo tipo.
  icono: LucideIcon;
  componente: LazyExoticComponent<ComponentType>;
}

export const MODULOS_CLIENTE: ModuloCliente[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icono: LayoutDashboard,
    componente: lazy(() => import("../components/dashboard/Dashboard")),
  },
  {
    id: "repuestos",
    label: "Repuestos",
    icono: Wrench,
    componente: lazy(() => import("../components/repuestos/RepuestosTable")),
  },
  {
    id: "combustible",
    label: "Combustible",
    icono: Fuel,
    componente: lazy(() => import("../components/combustible/CombustiblePanel")),
  },
  {
    id: "documentos",
    label: "Documentos",
    icono: FileText,
    componente: lazy(() => import("../components/documentos/DocumentosTable")),
  },
  {
    id: "equipos",
    label: "Equipos",
    icono: Tractor,
    componente: lazy(() => import("../components/equipos/EquiposTable")),
  },
  {
    id: "checklists",
    label: "Checklists",
    icono: ClipboardCheck,
    componente: lazy(() => import("../components/checklists/ChecklistsView")),
  },
  {
    id: "iperc",
    label: "IPERC",
    icono: ShieldAlert,
    componente: lazy(() => import("../components/iperc/IpercView")),
  },
  {
    id: "ordenes_trabajo",
    label: "Órdenes de Trabajo",
    icono: Hammer,
    componente: lazy(() => import("../components/ordenes_trabajo/OrdenesTrabajoView")),
  },
];
