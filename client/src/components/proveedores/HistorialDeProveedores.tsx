// client/src/components/proveedores/HistorialDeProveedores.tsx
//
// «Historial y auditoría»: lo que la gente de la empresa hizo con los proveedores (registrar, editar, cargar
// precios, compras, datos, contactos y cuentas bancarias), de más nuevo a más viejo. Solo el admin. Se puede
// filtrar por tipo, por fechas y por proveedor. Nunca muestra un número de cuenta ni datos de contacto: la
// bitácora guarda ids, no contenido.
import { Search } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  CATEGORIAS_DE_HISTORIAL,
  fechaYHoraDeLima,
  leerHistorialDeProveedores,
  type EventoDeHistorial,
  type FiltroDeHistorial,
} from "./historialProveedores";

const CONTROL =
  "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#84cc16]";

export default function HistorialDeProveedores({
  onAbrirProveedor,
  proveedorId,
}: {
  /** Abre la ficha del proveedor del evento. */
  onAbrirProveedor?: (id: number) => void;
  /** Solo lo de este proveedor (la pestaña Historial de su ficha): sin título de página ni filtro de proveedor. */
  proveedorId?: number;
}) {
  const [eventos, setEventos] = useState<EventoDeHistorial[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Lo que se escribe en los campos y lo que se buscó de verdad (se busca al pulsar «Buscar»).
  const [campos, setCampos] = useState<FiltroDeHistorial>({});
  const [aplicado, setAplicado] = useState<FiltroDeHistorial>({});

  const cargar = useCallback(
    async (filtro: FiltroDeHistorial, antesDe?: string) => {
      setCargando(true);
      setError(null);
      try {
        const pagina = await leerHistorialDeProveedores({ ...filtro, proveedorId, antesDe });
        // Con cursor se agrega; sin cursor es una búsqueda nueva y reemplaza.
        setEventos((previos) => (antesDe ? [...previos, ...pagina.eventos] : pagina.eventos));
        setSiguiente(pagina.siguiente);
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo cargar el historial.");
      } finally {
        setCargando(false);
      }
    },
    [proveedorId]
  );

  // La primera carga no pasa por `cargar()` a propósito: esa función arranca poniendo `cargando` en true, y
  // hacerlo dentro de un efecto de montaje es una cascada de renders para nada (ya arranca en true).
  useEffect(() => {
    let vigente = true;
    leerHistorialDeProveedores({ proveedorId })
      .then((pagina) => {
        if (!vigente) return;
        setEventos(pagina.eventos);
        setSiguiente(pagina.siguiente);
      })
      .catch((e: Error) => vigente && setError(e.message))
      .finally(() => vigente && setCargando(false));
    return () => {
      vigente = false;
    };
  }, [proveedorId]);

  const buscar = (e: FormEvent) => {
    e.preventDefault();
    setAplicado(campos);
    void cargar(campos);
  };
  const limpiar = () => {
    setCampos({});
    setAplicado({});
    void cargar({});
  };

  return (
    <div className="space-y-5">
      {proveedorId === undefined && (
        <header>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            Seguimiento / Historial y auditoría
          </p>
          <h1 className="text-3xl font-semibold text-slate-900 mt-1">Historial y auditoría</h1>
          <p className="text-sm text-slate-500 mt-1">
            Quién hizo qué con los proveedores y cuándo. Aquí no aparecen números de cuenta ni datos
            de contacto: solo qué se hizo y sobre qué proveedor.
          </p>
        </header>
      )}

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        {proveedorId !== undefined && (
          <div className="px-5 pt-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              Auditoría
            </p>
            <h2 className="text-base font-semibold text-slate-900">Historial de cambios</h2>
          </div>
        )}
        <form
          onSubmit={buscar}
          className="flex flex-wrap items-end gap-3 p-4 border-b border-slate-200"
        >
          <label className="text-xs font-semibold text-slate-600">
            Tipo
            <select
              className={`${CONTROL} mt-1 block`}
              value={campos.categoria ?? ""}
              onChange={(e) =>
                setCampos({
                  ...campos,
                  categoria: e.target.value as FiltroDeHistorial["categoria"],
                })
              }
            >
              {CATEGORIAS_DE_HISTORIAL.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.etiqueta}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Desde
            <input
              type="date"
              className={`${CONTROL} mt-1 block`}
              value={campos.desde ?? ""}
              onChange={(e) => setCampos({ ...campos, desde: e.target.value })}
            />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Hasta
            <input
              type="date"
              className={`${CONTROL} mt-1 block`}
              value={campos.hasta ?? ""}
              onChange={(e) => setCampos({ ...campos, hasta: e.target.value })}
            />
          </label>
          {proveedorId === undefined && (
            <label className="relative flex-1 min-w-56 max-w-sm text-xs font-semibold text-slate-600">
              Proveedor
              <Search size={16} className="absolute left-3 bottom-3 text-slate-400" />
              <input
                className={`${CONTROL} mt-1 block w-full pl-9`}
                value={campos.proveedor ?? ""}
                onChange={(e) => setCampos({ ...campos, proveedor: e.target.value })}
                placeholder="Buscar por nombre del proveedor"
              />
            </label>
          )}
          <button
            type="submit"
            disabled={cargando}
            className="h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95 disabled:opacity-60"
          >
            Buscar
          </button>
          <button
            type="button"
            onClick={limpiar}
            className="h-10 px-4 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Limpiar
          </button>
        </form>

        {error && (
          <p
            role="alert"
            className="m-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
          >
            {error}
          </p>
        )}

        {!error && !cargando && eventos.length === 0 ? (
          <p className="p-6 text-sm text-slate-600">
            {Object.values(aplicado).some((v) => v)
              ? "No hay movimientos con esos filtros."
              : "Todavía no hay movimientos de proveedores."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                  <th className="px-5 py-2">Fecha</th>
                  <th className="px-5 py-2">Quién</th>
                  <th className="px-5 py-2">Qué hizo</th>
                  {proveedorId === undefined && <th className="px-5 py-2">Proveedor</th>}
                </tr>
              </thead>
              <tbody>
                {eventos.map((e) => (
                  <tr key={e.id} className="border-b border-slate-100 last:border-0 align-top">
                    <td className="px-5 py-3 whitespace-nowrap text-slate-600">
                      {fechaYHoraDeLima(e.creadoEn)}
                    </td>
                    <td className="px-5 py-3 text-slate-800">{e.actor ?? "—"}</td>
                    <td className="px-5 py-3">
                      <p className="font-medium text-slate-900">{e.titulo}</p>
                      {e.lineas.map((linea) => (
                        <p key={linea} className="text-xs text-slate-500">
                          {linea}
                        </p>
                      ))}
                    </td>
                    {proveedorId === undefined && (
                      <td className="px-5 py-3">
                        {e.proveedorId !== null && e.proveedorNombre ? (
                          onAbrirProveedor ? (
                            <button
                              onClick={() => onAbrirProveedor(e.proveedorId!)}
                              className="text-left font-medium text-[#3f6212]"
                            >
                              {e.proveedorNombre}
                            </button>
                          ) : (
                            e.proveedorNombre
                          )
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {cargando && <p className="p-4 text-sm text-slate-500">Cargando…</p>}
        {siguiente && !cargando && (
          <div className="p-4 border-t border-slate-200">
            <button
              onClick={() => void cargar(aplicado, siguiente)}
              className="h-10 px-4 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Ver más
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
