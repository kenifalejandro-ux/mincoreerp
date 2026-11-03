// client/src/components/flota/FlotaPanel.tsx
//
// Gestión operacional de flota: el módulo central. Hoy lo componen Registro de
// unidades (lo que antes era "Equipos") y Viajes, que salió de Combustible. Cada
// uno sigue siendo la pantalla de siempre; acá solo se elige cuál, con la
// sub-pestaña que pide el menú lateral (ver App.tsx), y cada una se baja al
// navegador recién cuando se abre. Viajes tiene dos pestañas: la lista y el
// consumo por viaje.
import { Suspense, lazy, useState } from "react";

import { puedeVerConsumoDeViajes } from "./flotaAcceso";
import { useAuth } from "../../context/AuthContext";

const EquiposTable = lazy(() => import("../equipos/EquiposTable"));
const ViajesPanel = lazy(() => import("../combustible/ViajesPanel"));
const ConsumoViajeVista = lazy(() => import("../combustible/ConsumoViajeVista"));

interface FlotaPanelProps {
  pestanaInicial?: "unidades" | "viajes";
}

const TITULO_VISTA = { lista: "Viajes", consumo: "Consumo por viaje" } as const;

/** Viajes con sus dos pestañas. Vive aparte para que, al pasar a otro ítem del menú y
 *  volver, empiece otra vez en la lista y no en la pestaña que se había dejado abierta. */
function ViajesConPestanas() {
  const { usuario } = useAuth();
  const [vista, setVista] = useState<"lista" | "consumo">("lista");
  const hayConsumo = puedeVerConsumoDeViajes(usuario);

  return (
    <>
      {hayConsumo && (
        <div
          role="tablist"
          aria-label="Vistas de Viajes"
          className="mx-2 mt-2 flex gap-2 sm:mx-4 sm:mt-4 lg:mx-8 lg:mt-8"
        >
          {(["lista", "consumo"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={vista === v}
              onClick={() => setVista(v)}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
                vista === v ? "bg-[#192526] text-[#BADC1E]" : "text-slate-500 hover:text-[#BADC1E]"
              }`}
            >
              {TITULO_VISTA[v]}
            </button>
          ))}
        </div>
      )}
      {vista === "consumo" && hayConsumo ? (
        <div className="p-2 sm:p-4 lg:p-8">
          <ConsumoViajeVista />
        </div>
      ) : (
        <ViajesPanel />
      )}
    </>
  );
}

export default function FlotaPanel({ pestanaInicial = "unidades" }: FlotaPanelProps) {
  return (
    <Suspense fallback={<div className="p-20 text-center text-slate-500">Cargando...</div>}>
      {pestanaInicial === "viajes" ? <ViajesConPestanas /> : <EquiposTable />}
    </Suspense>
  );
}
