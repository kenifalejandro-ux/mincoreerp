// client/src/components/bandeja/BandejaView.tsx
//
// La Bandeja de alertas del ERP: un solo lugar para leer y resolver las
// alertas, con una pestaña por módulo. Hoy solo Combustible genera alertas,
// así que es la única pestaña; cuando otro módulo las tenga, se agrega una
// entrada a MODULOS_CON_BANDEJA (bandejaAcceso.ts) y su pantalla acá.

import { Inbox } from "lucide-react";
import { useState, type ComponentType } from "react";

import { useAuth } from "../../context/AuthContext";
import BandejaCombustible from "../combustible/Bandeja";
import { MODULOS_CON_BANDEJA } from "./bandejaAcceso";

/** La pantalla de cada módulo; las etiquetas y quién la ve, en bandejaAcceso. */
const PANTALLAS: Record<string, ComponentType> = {
  combustible: BandejaCombustible,
};

export default function BandejaView() {
  const { usuario } = useAuth();
  const modulos = usuario ? MODULOS_CON_BANDEJA.filter((m) => m.visiblePara(usuario)) : [];
  const [activoId, setActivoId] = useState(modulos[0]?.id ?? "");
  const activo = modulos.find((m) => m.id === activoId) ?? modulos[0];

  if (!activo || !PANTALLAS[activo.id]) return null;
  const Contenido = PANTALLAS[activo.id];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg sm:text-xl lg:text-2xl font-extrabold text-white tracking-tight flex items-center gap-2">
          <Inbox className="w-6 h-6" aria-hidden="true" /> Bandeja de alertas
        </h1>
        <p className="text-xs sm:text-sm text-[#94a3b8]">
          Las alertas de los módulos que ves. Abrirla la marca como leída; ciérrala con un motivo
          cuando la revises.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Módulo"
        className="flex flex-wrap gap-2 border-b border-[#2a2e37]"
      >
        {modulos.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={m.id === activo.id}
            onClick={() => setActivoId(m.id)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              m.id === activo.id
                ? "border-[#BADC1E] text-[#BADC1E]"
                : "border-transparent text-[#94a3b8] hover:text-white"
            }`}
          >
            {m.etiqueta}
          </button>
        ))}
      </div>

      <Contenido />
    </div>
  );
}
