// client/src/components/proveedores/BotonNuevoPrecio.tsx
//
// El botón «Nuevo precio» y su formulario. Lo usan Gestión comercial y la pestaña «Comercial» de la ficha: al
// pulsarlo trae a qué proveedores y presentaciones puede poner precio esta persona y abre el formulario.
import { Plus } from "lucide-react";
import { useState } from "react";

import FormularioPrecio from "./FormularioPrecio";
import {
  datosFormularioPrecio,
  type DatosFormularioPrecio,
  type FilaPrecio,
} from "./proveedoresApi";

export default function BotonNuevoPrecio({
  filas,
  proveedorInicial,
  onCargado,
}: {
  filas: FilaPrecio[];
  proveedorInicial?: number;
  onCargado: (mensaje: string) => void;
}) {
  const [datos, setDatos] = useState<DatosFormularioPrecio | null>(null);
  const [abriendo, setAbriendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abrir = async () => {
    if (abriendo) return;
    setAbriendo(true);
    setError(null);
    try {
      setDatos(await datosFormularioPrecio());
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo abrir el formulario.");
    } finally {
      setAbriendo(false);
    }
  };

  return (
    <>
      <button
        onClick={abrir}
        disabled={abriendo}
        className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95 disabled:opacity-60"
      >
        <Plus size={16} /> Nuevo precio
      </button>
      {error && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {error}
        </p>
      )}
      {datos && (
        <FormularioPrecio
          datos={datos}
          filas={filas}
          proveedorInicial={proveedorInicial}
          onCerrar={() => setDatos(null)}
          onCargado={(mensaje) => {
            setDatos(null);
            onCargado(mensaje);
          }}
        />
      )}
    </>
  );
}
