// client/src/components/administracion/SedesYGrifosView.tsx
//
// Administración → Sedes y grifos (migración 0097). Las plantas de la empresa
// y sus grifos internos: los puntos PROPIOS donde se abastecen los equipos.
// No confundir con los proveedores externos (PRIMAX...), que viven en
// Combustible.
//
// Nada se borra: dar de baja pide motivo y queda en el Log de eventos. Un
// grifo con tanques o equipos activos, o una sede con grifos activos, no se
// puede dar de baja: primero se mueven. La sede de un grifo no se cambia.
import { useState } from "react";

import {
  bajaGrifoApi,
  bajaSedeApi,
  crearGrifoApi,
  crearSedeApi,
  reactivarGrifoApi,
  reactivarSedeApi,
  renombrarGrifoApi,
  renombrarSedeApi,
  type Sede,
} from "../../services/sedesApi";
import { useSedes } from "../comunes/useSedes";

export default function SedesYGrifosView() {
  const { sedes, recargar } = useSedes();
  const [nuevaSede, setNuevaSede] = useState("");
  const [nuevoGrifo, setNuevoGrifo] = useState<Record<number, string>>({});
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ejecutar = async (accion: () => Promise<unknown>) => {
    if (trabajando) return;
    setTrabajando(true);
    setError(null);
    try {
      await accion();
      recargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar");
    } finally {
      setTrabajando(false);
    }
  };

  const pedirTexto = (pregunta: string, inicial = "") => {
    const r = window.prompt(pregunta, inicial);
    return r && r.trim() !== "" ? r.trim() : null;
  };

  const crearSede = (e: React.FormEvent) => {
    e.preventDefault();
    const nombre = nuevaSede.trim();
    if (!nombre) return;
    void ejecutar(async () => {
      await crearSedeApi(nombre);
      setNuevaSede("");
    });
  };

  const crearGrifo = (e: React.FormEvent, sede: Sede) => {
    e.preventDefault();
    const nombre = (nuevoGrifo[sede.id] ?? "").trim();
    if (!nombre) return;
    void ejecutar(async () => {
      await crearGrifoApi(sede.id, nombre);
      setNuevoGrifo((prev) => ({ ...prev, [sede.id]: "" }));
    });
  };

  const renombrar = (que: "sede" | "grifo", id: number, actual: string) => {
    const nombre = pedirTexto("Nuevo nombre:", actual);
    if (!nombre || nombre === actual) return;
    void ejecutar(() =>
      que === "sede" ? renombrarSedeApi(id, nombre) : renombrarGrifoApi(id, nombre)
    );
  };

  const cambiarEstado = (que: "sede" | "grifo", id: number, darDeBaja: boolean, nombre: string) => {
    const motivo = pedirTexto(
      darDeBaja
        ? `¿Por qué se da de baja "${nombre}"? Queda en el Log de eventos.`
        : `¿Por qué se reactiva "${nombre}"?`
    );
    if (!motivo) return;
    void ejecutar(() => {
      if (que === "sede") return darDeBaja ? bajaSedeApi(id, motivo) : reactivarSedeApi(id, motivo);
      return darDeBaja ? bajaGrifoApi(id, motivo) : reactivarGrifoApi(id, motivo);
    });
  };

  const boton =
    "px-2 py-1 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50";

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-600 max-w-3xl">
        Las plantas de tu empresa y sus <strong>grifos internos</strong>: los puntos propios donde
        se abastecen los equipos. Cada tanque y cada equipo pertenece a un grifo. Si tienes una sola
        planta con un solo grifo, no hace falta tocar nada acá.
      </p>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
          {error}
        </p>
      )}

      {sedes.map((sede) => (
        <section
          key={sede.id}
          className={`border border-slate-200 rounded-2xl p-5 ${sede.activo ? "" : "opacity-60"}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div>
              <h3 className="text-lg font-bold text-slate-800">{sede.nombre}</h3>
              {!sede.activo && (
                <p className="text-xs text-slate-500">Dada de baja: {sede.motivo_baja}</p>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className={boton}
                disabled={trabajando}
                onClick={() => renombrar("sede", sede.id, sede.nombre)}
              >
                Renombrar
              </button>
              <button
                type="button"
                className={boton}
                disabled={trabajando}
                onClick={() => cambiarEstado("sede", sede.id, sede.activo, sede.nombre)}
              >
                {sede.activo ? "Dar de baja" : "Reactivar"}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs font-bold text-slate-700 uppercase border-b">
                  <th className="p-2">Grifo interno</th>
                  <th className="p-2 text-right">Tanques activos</th>
                  <th className="p-2 text-right">Equipos activos</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {sede.grifos.map((g) => (
                  <tr key={g.id} className={`border-b ${g.activo ? "" : "text-slate-400"}`}>
                    <td className="p-2">
                      <div className="font-medium">{g.nombre}</div>
                      {!g.activo && (
                        <div className="text-[11px]">Dado de baja: {g.motivo_baja}</div>
                      )}
                    </td>
                    <td className="p-2 text-right">{g.tanques_activos}</td>
                    <td className="p-2 text-right">{g.equipos_activos}</td>
                    <td className="p-2 text-right whitespace-nowrap space-x-2">
                      <button
                        type="button"
                        className={boton}
                        disabled={trabajando}
                        onClick={() => renombrar("grifo", g.id, g.nombre)}
                      >
                        Renombrar
                      </button>
                      <button
                        type="button"
                        className={boton}
                        disabled={trabajando}
                        title={
                          g.activo && (g.tanques_activos > 0 || g.equipos_activos > 0)
                            ? "Primero mueve sus tanques y equipos a otro grifo"
                            : undefined
                        }
                        onClick={() => cambiarEstado("grifo", g.id, g.activo, g.nombre)}
                      >
                        {g.activo ? "Dar de baja" : "Reactivar"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {sede.activo && (
            <form onSubmit={(e) => crearGrifo(e, sede)} className="flex flex-wrap gap-2 mt-3">
              <label htmlFor={`nuevo-grifo-${sede.id}`} className="sr-only">
                Nombre del grifo nuevo en {sede.nombre}
              </label>
              <input
                id={`nuevo-grifo-${sede.id}`}
                maxLength={80}
                className="flex-1 min-w-[12rem] border border-slate-200 rounded-xl p-2 outline-none"
                placeholder="Nombre del grifo nuevo"
                value={nuevoGrifo[sede.id] ?? ""}
                onChange={(e) => setNuevoGrifo((prev) => ({ ...prev, [sede.id]: e.target.value }))}
              />
              <button
                type="submit"
                disabled={trabajando}
                className="px-4 py-2 bg-slate-900 text-white text-sm rounded-lg disabled:opacity-50"
              >
                Agregar grifo
              </button>
            </form>
          )}
        </section>
      ))}

      <form onSubmit={crearSede} className="flex flex-wrap gap-2">
        <label htmlFor="nueva-sede" className="sr-only">
          Nombre de la sede nueva
        </label>
        <input
          id="nueva-sede"
          maxLength={80}
          className="flex-1 min-w-[12rem] border border-slate-200 rounded-xl p-2 outline-none"
          placeholder="Nombre de la sede nueva (ej.: Planta Huamachuco)"
          value={nuevaSede}
          onChange={(e) => setNuevaSede(e.target.value)}
        />
        <button
          type="submit"
          disabled={trabajando}
          className="px-4 py-2 bg-slate-900 text-white text-sm rounded-lg disabled:opacity-50"
        >
          Agregar sede
        </button>
      </form>
    </div>
  );
}
