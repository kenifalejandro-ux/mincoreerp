import { useState } from "react";

import type { CompraDeCisterna, DatosParaElFormulario } from "./comprasCisternaTipos";
import RegistrarCompraCisterna from "./RegistrarCompraCisterna";
import { apiFetch } from "../../services/apiClient";

// El botón fijo "Registrar compra" de la cabecera de Cisternas. Pide los datos del formulario (los
// proveedores, las sedes, los precios) y las compras anteriores (de ahí sale el transportista que se
// sugiere) recién al apretarlo, para que quien nunca lo usa no pague esas dos consultas.

export default function BotonRegistrarCompra({
  onRegistrado,
}: {
  /** Recibe el texto de confirmación (también el de "sin conexión") para mostrarlo. */
  onRegistrado: (mensaje: string) => void;
}) {
  const [cargando, setCargando] = useState(false);
  const [abierto, setAbierto] = useState<{
    datos: DatosParaElFormulario;
    compras: CompraDeCisterna[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abrir = async () => {
    setCargando(true);
    setError(null);
    try {
      const [rd, rc] = await Promise.all([
        apiFetch("/api/erp/combustible/compras-cisterna/formulario"),
        apiFetch("/api/erp/combustible/compras-cisterna"),
      ]);
      const [datos, compras] = await Promise.all([
        rd.json().catch(() => null),
        rc.json().catch(() => null),
      ]);
      if (!rd.ok || !datos || !rc.ok || !Array.isArray(compras)) {
        setError("No se pudo abrir el formulario.");
        return;
      }
      setAbierto({ datos: datos as DatosParaElFormulario, compras: compras as CompraDeCisterna[] });
    } catch {
      setError("Sin señal: no se pudo abrir el formulario.");
    } finally {
      setCargando(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={cargando}
        onClick={() => void abrir()}
        className="px-4 py-2 rounded-lg text-sm font-semibold transition-all active:scale-95 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d] disabled:opacity-50"
      >
        Registrar compra
      </button>
      {error && (
        <span role="alert" className="text-xs text-amber-300">
          {error}
        </span>
      )}
      {abierto && (
        <RegistrarCompraCisterna
          compras={abierto.compras}
          datos={abierto.datos}
          onCerrar={() => setAbierto(null)}
          onRegistrado={onRegistrado}
        />
      )}
    </>
  );
}
