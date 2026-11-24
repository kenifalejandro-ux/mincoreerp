// client/src/components/mantenimiento/EquiposMantenimiento.tsx
//
// Equipos: lo que la empresa mantiene. Es el registro PROPIO del ecosistema (no depende de Flota): con solo
// el módulo `mantenimiento` la empresa ve aquí sus equipos. La lista se filtra en el cliente (ver
// equiposMantenimiento.ts). Admin y operador registran, editan y quitan equipos y manejan las áreas; Lectura
// solo mira. El estado de cada unidad (Detenida, En mantenimiento, Operativa) llega cuando
// existan las órdenes de trabajo y los checklists: hoy no se inventa.
import { MapPin, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import AreasDeMantenimiento from "./AreasDeMantenimiento";
import {
  FILTROS_VACIOS,
  TODAS_LAS_AREAS,
  TODOS_LOS_TIPOS,
  areasDeLosEquipos,
  filtrarEquipos,
  lecturaConUnidad,
  type FiltrosDeEquipos,
} from "./equiposMantenimiento";
import FormularioEquipo from "./FormularioEquipo";
import {
  COLUMNAS_DE_LA_PLANILLA,
  MAX_FILAS_IMPORTACION,
  mensajeDeImportacion,
  type FilaImportacionEquipo,
} from "./importarEquipos";
import {
  listarAreas,
  listarEquipos,
  type AreaMantenimiento,
  type EquipoMantenimiento,
  type ListaDeEquipos,
} from "./mantenimientoApi";
import { parsearPlanillaEquipos } from "./parsearPlanillaEquipos";
import QuitarEquipo from "./QuitarEquipo";
import {
  BannerImportacion,
  BotonImportarExcel,
  ModalVistaPreviaImportacion,
  type ColumnaVistaPreviaExcel,
} from "../comunes/ImportarExcel";
import { useImportacionExcel } from "../comunes/useImportacionExcel";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";

const control =
  "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#84cc16]";

export default function EquiposMantenimiento() {
  const [datos, setDatos] = useState<ListaDeEquipos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [areasLista, setAreasLista] = useState<AreaMantenimiento[]>([]);
  const [filtros, setFiltros] = useState<FiltrosDeEquipos>(FILTROS_VACIOS);
  const puedeEscribir = usePuedeEscribir("mantenimiento");
  // Lo que hay abierto encima de la lista: el formulario (nuevo o de un equipo), quitar o las áreas.
  const [ventana, setVentana] = useState<
    | { tipo: "formulario"; equipo?: EquipoMantenimiento }
    | { tipo: "quitar"; equipo: EquipoMantenimiento }
    | { tipo: "areas" }
    | null
  >(null);

  /** Lee de nuevo los equipos y las áreas (después de guardar algo). */
  const cargar = useCallback(() => {
    setError(null);
    return Promise.all([listarEquipos(), listarAreas()])
      .then(([d, a]) => {
        setDatos(d);
        setAreasLista(a);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Error"));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);
  // Importar desde Excel: se lee el archivo en el navegador, se muestra qué se va a importar y solo al
  // confirmar viaja al servidor (todo o nada, con la fila y la columna de cada problema).
  const importacion = useImportacionExcel<FilaImportacionEquipo>({
    endpoint: "/api/erp/mantenimiento/equipos/bulk",
    parsear: parsearPlanillaEquipos,
    maxFilas: MAX_FILAS_IMPORTACION,
    etiquetaEntidad: "equipos",
    onImportado: (cuerpo) => {
      void cargar();
      return mensajeDeImportacion(cuerpo);
    },
  });
  const columnasVistaPrevia: ColumnaVistaPreviaExcel<FilaImportacionEquipo>[] = [
    { encabezado: "Placa o código", render: (f) => f.placa_codigo || "---" },
    { encabezado: "Tipo", render: (f) => f.tipo || "---" },
    { encabezado: "Marca", render: (f) => f.marca || "—" },
    { encabezado: "Modelo", render: (f) => f.modelo || "—" },
    {
      encabezado: "Lectura",
      render: (f) => `${f.lectura} ${f.medidor === "horometro" ? "h" : "km"}`,
    },
    {
      encabezado: "Propiedad",
      render: (f) => (f.propiedad === "alquilada" ? "Alquilada" : "Propia"),
    },
    { encabezado: "Área", render: (f) => f.area || "Sin área" },
  ];
  const cerrarYRecargar = () => {
    setVentana(null);
    cargar();
  };

  const filtrados = useMemo(
    () => (datos ? filtrarEquipos(datos.equipos, filtros) : []),
    [datos, filtros]
  );
  const areas = useMemo(() => (datos ? areasDeLosEquipos(datos.equipos) : []), [datos]);
  const cambiar = (parcial: Partial<FiltrosDeEquipos>) =>
    setFiltros((actual) => ({ ...actual, ...parcial }));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            Operación / Equipos
          </p>
          <h1 className="text-3xl font-semibold text-slate-900 mt-1">Equipos</h1>
          <p className="text-sm text-slate-500 mt-1">
            Todo lo que la empresa mantiene: vehículos, maquinaria y equipos de planta.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setVentana({ tipo: "areas" })}
            className="flex items-center gap-2 h-10 px-4 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <MapPin size={16} /> Áreas
          </button>
          {puedeEscribir && (
            <BotonImportarExcel cargando={importacion.cargando} onFile={importacion.handleFile} />
          )}
          {puedeEscribir && (
            <button
              onClick={() => setVentana({ tipo: "formulario" })}
              className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
            >
              <Plus size={16} /> Nuevo equipo
            </button>
          )}
        </div>
      </header>

      <BannerImportacion error={importacion.error} resultado={importacion.resultado} />

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-slate-200">
          <label className="relative flex-1 min-w-56 max-w-md">
            <span className="sr-only">Buscar equipo</span>
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input
              value={filtros.busqueda}
              onChange={(e) => cambiar({ busqueda: e.target.value })}
              placeholder="Buscar por placa, tipo, marca, modelo o área..."
              className={`${control} w-full pl-9`}
            />
          </label>
          <select
            aria-label="Tipo"
            className={control}
            value={filtros.tipo}
            onChange={(e) => cambiar({ tipo: e.target.value })}
          >
            <option value={TODOS_LOS_TIPOS}>{TODOS_LOS_TIPOS}</option>
            {(datos?.tipos ?? []).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            aria-label="Área"
            className={control}
            value={filtros.area}
            onChange={(e) => cambiar({ area: e.target.value })}
          >
            <option value={TODAS_LAS_AREAS}>{TODAS_LAS_AREAS}</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p
            role="alert"
            className="m-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
          >
            {error}
          </p>
        )}

        {/* `relative`: evita que un «sr-only» absoluto ensanche la PÁGINA en el celular. */}
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b border-slate-200">
                <th className="px-4 py-3">Equipo</th>
                <th className="px-4 py-3">Área</th>
                <th className="px-4 py-3">Lectura</th>
                <th className="px-4 py-3">Propiedad</th>
                {puedeEscribir && (
                  <th className="px-2 py-3">
                    <span className="sr-only">Acciones</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {datos === null && !error && (
                <tr>
                  <td
                    colSpan={puedeEscribir ? 5 : 4}
                    className="px-4 py-8 text-center text-slate-500"
                  >
                    Cargando…
                  </td>
                </tr>
              )}
              {datos !== null && filtrados.length === 0 && (
                <tr>
                  <td
                    colSpan={puedeEscribir ? 5 : 4}
                    className="px-4 py-8 text-center text-slate-500"
                  >
                    {datos.total === 0 ? "Todavía no hay equipos registrados." : "Sin resultados"}
                  </td>
                </tr>
              )}
              {filtrados.map((e) => (
                <tr key={e.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="w-9 h-9 rounded-lg bg-slate-100 text-[#4d7c0f] grid place-items-center text-xs font-bold shrink-0">
                        {e.placa_codigo.slice(0, 3).toUpperCase()}
                      </span>
                      <span>
                        <b className="block text-slate-900">{e.placa_codigo}</b>
                        <small className="text-slate-500">
                          {[e.tipo, e.marca, e.modelo].filter(Boolean).join(" · ")}
                        </small>
                        {e.por_completar && (
                          <span className="ml-2 px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 text-[10px] font-semibold">
                            Por completar
                          </span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {e.area ? (
                      <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-xs font-semibold whitespace-nowrap">
                        {e.area}
                      </span>
                    ) : (
                      <span className="text-slate-400">Sin área</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-semibold text-slate-800">{lecturaConUnidad(e)}</td>
                  <td className="px-4 py-3 text-slate-700">
                    {e.propiedad === "alquilada" ? "Alquilada" : "Propia"}
                  </td>
                  {puedeEscribir && (
                    <td className="px-2 py-3">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => setVentana({ tipo: "formulario", equipo: e })}
                          aria-label={`Editar el equipo ${e.placa_codigo}`}
                          title="Editar"
                          className="p-2 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          onClick={() => setVentana({ tipo: "quitar", equipo: e })}
                          aria-label={`Quitar el equipo ${e.placa_codigo}`}
                          title="Quitar"
                          className="p-2 rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {datos !== null && datos.total > 0 && (
          <p className="px-4 py-3 text-xs text-slate-500 border-t border-slate-200">
            Mostrando {filtrados.length} de {datos.total} equipos.
          </p>
        )}
        {puedeEscribir && (
          <p className="px-4 py-3 text-xs text-slate-500 border-t border-slate-200">
            Para importar: una hoja de Excel con las columnas {COLUMNAS_DE_LA_PLANILLA} (Placa y
            Tipo son obligatorias). Si el Área no existe, se crea.
          </p>
        )}
      </section>

      {importacion.filasPendientes && (
        <ModalVistaPreviaImportacion
          filas={importacion.filasPendientes}
          columnas={columnasVistaPrevia}
          etiquetaEntidad="equipos"
          confirmando={importacion.importando}
          onConfirmar={importacion.confirmar}
          onCancelar={importacion.cancelar}
        />
      )}
      {ventana?.tipo === "formulario" && (
        <FormularioEquipo
          equipo={ventana.equipo}
          areas={areasLista}
          tipos={datos?.tipos ?? []}
          onGuardado={cerrarYRecargar}
          onCerrar={() => setVentana(null)}
        />
      )}
      {ventana?.tipo === "quitar" && (
        <QuitarEquipo
          equipo={ventana.equipo}
          onQuitado={cerrarYRecargar}
          onCerrar={() => setVentana(null)}
        />
      )}
      {ventana?.tipo === "areas" && (
        <AreasDeMantenimiento
          puedeEscribir={puedeEscribir}
          onCambio={cargar}
          onCerrar={() => setVentana(null)}
        />
      )}
    </div>
  );
}
