// client/src/components/flota/FlotaPanel.tsx
//
// Gestión operacional de flota: el módulo central. Hoy lo componen Registro de
// unidades (lo que antes era "Equipos") y Viajes, que salió de Combustible.
// Cada uno sigue siendo la pantalla de siempre; acá solo se elige cuál, con la
// sub-pestaña que pide el menú lateral (ver App.tsx), y cada una se baja al
// navegador recién cuando se abre.
import { Suspense, lazy } from "react";

const EquiposTable = lazy(() => import("../equipos/EquiposTable"));
const ViajesPanel = lazy(() => import("../combustible/ViajesPanel"));

interface FlotaPanelProps {
  pestanaInicial?: "unidades" | "viajes";
}

export default function FlotaPanel({ pestanaInicial = "unidades" }: FlotaPanelProps) {
  return (
    <Suspense fallback={<div className="p-20 text-center text-slate-500">Cargando...</div>}>
      {pestanaInicial === "viajes" ? <ViajesPanel /> : <EquiposTable />}
    </Suspense>
  );
}
