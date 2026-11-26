// client/src/components/mantenimiento/ChecklistsMantenimiento.tsx
//
// Checklists dentro del ecosistema, como la maqueta: en Registros las cifras de hoy, la lista con búsqueda y
// filtros, y el panel de cada checklist; Formatos vive en FormatosMantenimiento.tsx. Los datos son del módulo Checklists (sin él esta pantalla no se
// ofrece). Llenar y eliminar siguen en el módulo, en el ERP.
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cuandoFue } from "./actividadDelTurno";
import {
  consultaDeRegistros,
  RESULTADO_EN_OFICINA,
  SIN_FILTROS,
  unidadDelRegistro,
  type ChecklistsDeHoy,
  type FiltrosDeRegistros,
  type RegistroDeChecklist,
  type ResultadoDeChecklist,
} from "./checklistsMantenimiento";
import FormatosMantenimiento from "./FormatosMantenimiento";
import { listarRegistros, registrosDeHoy, type ResumenMantenimiento } from "./mantenimientoApi";
import PanelDeChecklist from "./PanelDeChecklist";
import { useAuth } from "../../context/AuthContext";
import { tieneModulo } from "../../modules/tieneModulo";
import { SALIDAS } from "../checklists/registro";
import { marcarNovedadVista, novedadVigente } from "../controlTv/novedad";

/** Cuánto se espera a que la persona termine de escribir. */
const ESPERA_AL_ESCRIBIR_MS = 300;

/** La etiqueta «Nuevo» de Formatos, 24 horas desde el primer clic. */
const NOVEDAD_FORMATOS = "mantenimiento-formatos-2026-11";
const formatosSonNuevos = () => novedadVigente(Date.now(), undefined, NOVEDAD_FORMATOS);
const marcarFormatosVistos = () => marcarNovedadVista(Date.now(), undefined, NOVEDAD_FORMATOS);

const control =
  "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#84cc16]";

function Cifra({
  etiqueta,
  valor,
  nota,
  color = "text-slate-900",
}: {
  etiqueta: string;
  valor: string | number;
  nota: string;
  color?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <span className="block text-xs font-semibold text-slate-500">{etiqueta}</span>
      <b className={`block text-2xl font-extrabold ${color}`}>{valor}</b>
      <span className="block text-[11px] leading-4 text-slate-500">{nota}</span>
    </div>
  );
}

export default function ChecklistsMantenimiento({
  filtrosIniciales,
  resumen,
  onCambio,
}: {
  /** Con qué abre filtrada (viene de un aviso del Centro). */
  filtrosIniciales?: Partial<FiltrosDeRegistros>;
  resumen: ResumenMantenimiento | null;
  /** Se decidió una salida: el ecosistema vuelve a leer su resumen. */
  onCambio: () => void;
}) {
  const { usuario } = useAuth();
  const conOrdenes = tieneModulo(usuario, "ordenes_trabajo");
  const [filtros, setFiltros] = useState<FiltrosDeRegistros>({
    ...SIN_FILTROS,
    ...filtrosIniciales,
  });
  const [texto, setTexto] = useState(filtros.busqueda);
  // Los cursores de las páginas recorridas; el último es el de la página que se ve.
  const [cursores, setCursores] = useState<(number | null)[]>([null]);
  const [pagina, setPagina] = useState<{
    filas: RegistroDeChecklist[];
    siguiente: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoy, setHoy] = useState<ChecklistsDeHoy | null>(null);
  const [abierto, setAbierto] = useState<number | null>(null);
  const [pestana, setPestana] = useState<"registros" | "formatos">("registros");
  const cursor = cursores[cursores.length - 1];

  // Solo vale la última lectura pedida: una respuesta lenta de antes no pisa a la nueva.
  const ultima = useRef(0);
  const cargar = useCallback(() => {
    const esta = ++ultima.current;
    setError(null);
    setPagina(null);
    listarRegistros(consultaDeRegistros(filtros, cursor))
      .then((p) => {
        if (esta === ultima.current) setPagina(p);
      })
      .catch((e: unknown) => {
        if (esta === ultima.current) setError(e instanceof Error ? e.message : "Error");
      });
  }, [filtros, cursor]);

  const cargarHoy = useCallback(() => {
    // Sin las cifras de hoy la lista sigue sirviendo: las tarjetas quedan con «—».
    registrosDeHoy()
      .then(setHoy)
      .catch(() => setHoy(null));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);
  useEffect(cargarHoy, [cargarHoy]);

  /** Un filtro nuevo vuelve a la primera página. */
  const filtrar = useCallback((parcial: Partial<FiltrosDeRegistros>) => {
    setCursores([null]);
    setFiltros((f) => ({ ...f, ...parcial }));
  }, []);

  useEffect(() => {
    if (texto === filtros.busqueda) return;
    const espera = window.setTimeout(() => filtrar({ busqueda: texto }), ESPERA_AL_ESCRIBIR_MS);
    return () => window.clearTimeout(espera);
  }, [texto, filtros.busqueda, filtrar]);

  const ck = resumen?.checklists ?? null;
  const columnas = conOrdenes ? 6 : 5;

  return (
    <div className="space-y-5">
      <header>
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
          Checklists / {pestana === "registros" ? "Registros" : "Formatos"}
        </p>
        <h1 className="text-3xl font-semibold text-slate-900 mt-1">
          {pestana === "registros" ? "Checklists pre-uso" : "Formatos de checklist"}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {pestana === "registros"
            ? "Lo que llenaron conductores y operarios antes de salir. Una falla crítica deja la unidad No apta."
            : "Las preguntas que ve cada tipo de unidad. Cada cambio crea una versión nueva."}
        </p>
      </header>

      <div role="tablist" aria-label="Checklists" className="flex gap-2">
        {(["registros", "formatos"] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={pestana === p}
            onClick={() => {
              if (p === "formatos") marcarFormatosVistos();
              else cargar();
              setPestana(p);
            }}
            className={`flex min-h-[44px] sm:min-h-9 items-center gap-2 rounded-lg border px-4 text-sm font-semibold ${
              pestana === p
                ? "border-[#BADC1E] bg-[#BADC1E] text-[#0A1014]"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {p === "registros" ? "Registros" : "Formatos"}
            {p === "formatos" && formatosSonNuevos() && (
              <span className="rounded-full bg-[#0A1014] px-2 py-0.5 text-[10px] font-extrabold text-[#BADC1E]">
                Nuevo
              </span>
            )}
          </button>
        ))}
      </div>

      {pestana === "formatos" ? (
        <FormatosMantenimiento onCambio={onCambio} />
      ) : (
        <>
          <section aria-label="Checklists de hoy" className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <Cifra
              etiqueta="Hechos hoy"
              valor={ck && resumen ? `${ck.hechos_hoy} de ${resumen.total}` : "—"}
              nota={
                ck
                  ? `${ck.sin_checklist_hoy.total} ${ck.sin_checklist_hoy.total === 1 ? "unidad" : "unidades"} sin checklist`
                  : "Unidades con checklist"
              }
            />
            <Cifra
              etiqueta="Apta"
              valor={hoy?.bien ?? "—"}
              nota="Pueden salir"
              color="text-emerald-600"
            />
            <Cifra
              etiqueta="Con observaciones"
              valor={hoy?.observado ?? "—"}
              nota="Fallas no críticas"
              color="text-amber-700"
            />
            <Cifra
              etiqueta="No apta"
              valor={hoy?.no_apta ?? "—"}
              nota="No salen"
              color="text-red-700"
            />
          </section>

          <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 p-4 border-b border-slate-200">
              <label className="relative flex-1 min-w-56 max-w-md">
                <span className="sr-only">Buscar checklist</span>
                <Search size={16} className="absolute left-3 top-3 text-slate-400" />
                <input
                  value={texto}
                  maxLength={80}
                  onChange={(e) => setTexto(e.target.value)}
                  placeholder="Buscar por número, unidad, persona o falla..."
                  className={`${control} w-full pl-9`}
                />
              </label>
              <select
                aria-label="Resultado"
                className={control}
                value={filtros.resultado}
                onChange={(e) =>
                  filtrar({ resultado: e.target.value as ResultadoDeChecklist | "" })
                }
              >
                <option value="">Todos los resultados</option>
                {Object.entries(RESULTADO_EN_OFICINA).map(([valor, r]) => (
                  <option key={valor} value={valor}>
                    {r.texto}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-pressed={filtros.porAutorizar}
                onClick={() => filtrar({ porAutorizar: !filtros.porAutorizar })}
                className={`min-h-[44px] sm:min-h-10 rounded-lg border px-4 text-sm font-semibold ${
                  filtros.porAutorizar
                    ? "bg-[#BADC1E] border-[#BADC1E] text-[#0A1014]"
                    : "bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
                }`}
              >
                Por autorizar
              </button>
            </div>

            {error ? (
              <div role="alert" className="px-5 py-8 text-center text-sm text-red-700">
                No se pudo leer la lista. {error}
                <button
                  type="button"
                  onClick={cargar}
                  className="mx-auto mt-2 block min-h-[44px] sm:min-h-9 px-4 rounded-lg border border-slate-300 bg-white font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Reintentar
                </button>
              </div>
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b border-slate-200">
                      <th className="px-4 py-3">Checklist</th>
                      <th className="px-4 py-3">Unidad</th>
                      <th className="px-4 py-3">Llenado por</th>
                      <th className="px-4 py-3">Resultado</th>
                      <th className="px-4 py-3">Fallas</th>
                      {conOrdenes && <th className="px-4 py-3">Orden generada</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(pagina === null || pagina.filas.length === 0) && (
                      <tr>
                        <td colSpan={columnas} className="px-4 py-8 text-center text-slate-500">
                          {pagina === null ? "Cargando…" : "Sin resultados"}
                        </td>
                      </tr>
                    )}
                    {pagina?.filas.map((c) => {
                      const r = RESULTADO_EN_OFICINA[c.resultado];
                      return (
                        <tr
                          key={c.id}
                          onClick={() => setAbierto(c.id)}
                          className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                        >
                          <td className="px-4 py-3 whitespace-nowrap">
                            <button
                              type="button"
                              aria-label={`Ver el checklist ${c.id}`}
                              className="text-left"
                            >
                              <b className="block text-slate-900">#{c.id}</b>
                              <small className="text-slate-500">{cuandoFue(c.creado_en)}</small>
                            </button>
                          </td>
                          <td className="px-4 py-3 max-w-[200px] break-words font-semibold text-slate-800">
                            {unidadDelRegistro(c)}
                          </td>
                          <td className="px-4 py-3 text-slate-600">{c.usuario_nombre}</td>
                          <td className="px-4 py-3">
                            <span
                              className={`px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap ${r.clase}`}
                            >
                              {r.texto}
                            </span>
                            {c.salida && SALIDAS[c.salida] && (
                              <span
                                className={`block mt-1.5 text-xs font-bold ${SALIDAS[c.salida].clase}`}
                              >
                                {SALIDAS[c.salida].texto}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 max-w-[260px] break-words text-xs text-slate-600">
                            {c.fallas ?? <span className="text-slate-400">Sin fallas</span>}
                          </td>
                          {conOrdenes && (
                            <td className="px-4 py-3 font-semibold text-[#4d7c0f]">
                              {c.ordenes_trabajo.map((o) => `#${o}`).join(", ") || (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-slate-200">
              <p className="text-xs text-slate-500">
                {ck && ck.sin_checklist_hoy.total > 0
                  ? `Sin checklist hoy: ${ck.sin_checklist_hoy.casos.join(", ")}${
                      ck.sin_checklist_hoy.total > ck.sin_checklist_hoy.casos.length
                        ? ` y ${ck.sin_checklist_hoy.total - ck.sin_checklist_hoy.casos.length} más`
                        : ""
                    }.`
                  : ""}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setCursores((c) => c.slice(0, -1))}
                  disabled={cursores.length === 1}
                  className={`${control} flex items-center gap-1 font-semibold disabled:opacity-40`}
                >
                  <ChevronLeft size={15} /> Anterior
                </button>
                <button
                  type="button"
                  onClick={() => pagina && setCursores((c) => [...c, pagina.siguiente])}
                  disabled={!pagina || pagina.siguiente === null}
                  className={`${control} flex items-center gap-1 font-semibold disabled:opacity-40`}
                >
                  Siguiente <ChevronRight size={15} />
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      {abierto !== null && (
        <PanelDeChecklist
          key={abierto}
          id={abierto}
          onCerrar={() => setAbierto(null)}
          onDecidida={() => {
            cargar();
            cargarHoy();
            onCambio();
          }}
        />
      )}
    </div>
  );
}
