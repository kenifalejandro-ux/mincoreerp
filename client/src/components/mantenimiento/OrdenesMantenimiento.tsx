// client/src/components/mantenimiento/OrdenesMantenimiento.tsx
//
// Órdenes de trabajo dentro del ecosistema, como la maqueta: las cifras, la lista con búsqueda y filtros, el
// panel de cada orden y «Nueva OT». Los datos son del módulo Órdenes de trabajo (sin él no se ofrece).
import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cuandoFue } from "./actividadDelTurno";
import {
  cifrasDeOrdenes,
  listarAreas,
  listarMecanicos,
  listarOrdenes,
  type AreaMantenimiento,
} from "./mantenimientoApi";
import {
  consultaDeOrdenes,
  ESTADO_DE_ORDEN,
  fechaProgramada,
  origenDeLaOrden,
  PRIORIDAD,
  SIN_ASIGNAR,
  SIN_FILTROS_DE_ORDENES,
  TIPO,
  unidadDeLaOrden,
  type CifrasDeOrdenes,
  type EstadoDeOrden,
  type FiltrosDeOrdenes,
  type MecanicoConCarga,
  type FilaDeOrden,
  type TipoDeOrden,
} from "./ordenesMantenimiento";
import PanelDeOrden from "./PanelDeOrden";
import { useAuth } from "../../context/AuthContext";
import { tieneModulo } from "../../modules/tieneModulo";
import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";
import NuevaOrden from "../ordenes_trabajo/NuevaOrden";
import { useCatalogosDeOrden } from "../ordenes_trabajo/useCatalogosDeOrden";

/** Cuánto se espera a que la persona termine de escribir. */
const ESPERA_AL_ESCRIBIR_MS = 300;

const control =
  "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#84cc16]";
const chip = "rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap";

function Cifra({
  etiqueta,
  valor,
  nota,
  color,
}: {
  etiqueta: string;
  valor: number | undefined;
  nota: string;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <span className="block text-xs font-semibold text-slate-500">{etiqueta}</span>
      <b className={`block text-2xl font-extrabold ${color}`}>{valor ?? "—"}</b>
      <span className="block text-[11px] leading-4 text-slate-500">{nota}</span>
    </div>
  );
}

export default function OrdenesMantenimiento({
  filtrosIniciales,
  ordenInicial,
  onCambio,
}: {
  /** Con qué abre filtrada (viene de un aviso del Centro). */
  filtrosIniciales?: Partial<FiltrosDeOrdenes>;
  /** La orden cuyo panel se abre al entrar (viene de un checklist). */
  ordenInicial?: number;
  /** Cambió una orden: el ecosistema vuelve a leer su resumen. */
  onCambio: () => void;
}) {
  const { usuario } = useAuth();
  const puedeEscribir = usePuedeEscribir("ordenes_trabajo");
  const conIperc = tieneModulo(usuario, "iperc");
  const catalogos = useCatalogosDeOrden({
    conUnidades: true,
    conIperc,
    soloMecanicos: true,
    conAsignables: puedeEscribir,
  });
  const [filtros, setFiltros] = useState<FiltrosDeOrdenes>({
    ...SIN_FILTROS_DE_ORDENES,
    ...filtrosIniciales,
  });
  const [texto, setTexto] = useState(filtros.busqueda);
  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState<{
    filas: FilaDeOrden[];
    total: number;
    paginas: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cifras, setCifras] = useState<CifrasDeOrdenes | null>(null);
  const [mecanicos, setMecanicos] = useState<MecanicoConCarga[]>([]);
  const [areas, setAreas] = useState<AreaMantenimiento[]>([]);
  const [abierta, setAbierta] = useState<number | null>(ordenInicial ?? null);
  const [creando, setCreando] = useState(false);

  // Solo vale la última lectura pedida: una respuesta lenta de antes no pisa a la nueva.
  const ultima = useRef(0);
  const cargar = useCallback(() => {
    const esta = ++ultima.current;
    setError(null);
    setDatos(null);
    listarOrdenes(consultaDeOrdenes(filtros, pagina))
      .then((d) => {
        if (esta !== ultima.current) return;
        // La página quedó vacía (se borró o cambió de filtro desde otro lado): se vuelve a la última.
        if (d.filas.length === 0 && pagina > 1) setPagina(d.paginas);
        else setDatos(d);
      })
      .catch((e: unknown) => {
        if (esta === ultima.current) setError(e instanceof Error ? e.message : "Error");
      });
  }, [filtros, pagina]);

  const ultimasCifras = useRef(0);
  const cargarCifras = useCallback(() => {
    const esta = ++ultimasCifras.current;
    // Sin las cifras la lista sigue sirviendo: las tarjetas quedan con «—».
    cifrasDeOrdenes()
      .then((c) => {
        if (esta === ultimasCifras.current) setCifras(c);
      })
      .catch(() => {
        if (esta === ultimasCifras.current) setCifras(null);
      });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);
  useEffect(cargarCifras, [cargarCifras]);
  useEffect(() => {
    // Quien solo mira no puede pedir los mecánicos: su filtro queda en «todos» y «sin asignar».
    if (puedeEscribir) {
      listarMecanicos()
        .then(setMecanicos)
        .catch(() => setMecanicos([]));
    }
    listarAreas()
      .then(setAreas)
      .catch(() => setAreas([]));
  }, [puedeEscribir]);

  const cambiado = useCallback(() => {
    cargar();
    cargarCifras();
    onCambio();
  }, [cargar, cargarCifras, onCambio]);

  // Las órdenes creadas sin señal aparecen cuando la cola termina de enviarlas.
  useEffect(
    () =>
      suscribirseASincronizacion(({ sincronizadas }) => {
        if (sincronizadas > 0) cambiado();
      }),
    [cambiado]
  );

  /** Un filtro nuevo vuelve a la primera página. */
  const filtrar = useCallback((parcial: Partial<FiltrosDeOrdenes>) => {
    setPagina(1);
    setFiltros((f) => ({ ...f, ...parcial }));
  }, []);

  useEffect(() => {
    if (texto === filtros.busqueda) return;
    const espera = window.setTimeout(() => filtrar({ busqueda: texto }), ESPERA_AL_ESCRIBIR_MS);
    return () => window.clearTimeout(espera);
  }, [texto, filtros.busqueda, filtrar]);

  const columnas = conIperc ? 8 : 7;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            Correctivo / Órdenes de trabajo
          </p>
          <h1 className="text-3xl font-semibold text-slate-900 mt-1">Órdenes de trabajo</h1>
          <p className="text-sm text-slate-500 mt-1">
            Reparaciones y servicios por unidad. Las que nacen de un checklist llegan solas.
          </p>
        </div>
        {puedeEscribir && (
          <button
            type="button"
            onClick={() => setCreando(true)}
            className="flex items-center gap-2 min-h-[44px] sm:min-h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
          >
            <Plus size={16} /> Nueva OT
          </button>
        )}
      </header>

      <section aria-label="Cifras de órdenes" className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <Cifra
          etiqueta="Abiertas"
          valor={cifras?.abiertas}
          nota="Sin iniciar"
          color="text-blue-700"
        />
        <Cifra
          etiqueta="En progreso"
          valor={cifras?.en_progreso}
          nota="Trabajo en curso"
          color="text-amber-700"
        />
        <Cifra
          etiqueta="Urgentes"
          valor={cifras?.urgentes}
          nota="Sin cerrar"
          color="text-red-700"
        />
        <Cifra
          etiqueta="Completadas"
          valor={cifras?.completadas_del_mes}
          nota="Este mes"
          color="text-emerald-600"
        />
      </section>

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-slate-200">
          <label className="relative flex-1 min-w-56 max-w-md">
            <span className="sr-only">Buscar orden</span>
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input
              value={texto}
              maxLength={80}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Buscar por OT, unidad, trabajo o mecánico..."
              className={`${control} w-full pl-9`}
            />
          </label>
          <select
            aria-label="Estado"
            className={control}
            value={filtros.estado}
            onChange={(e) => filtrar({ estado: e.target.value as EstadoDeOrden | "" })}
          >
            <option value="">Todos los estados</option>
            {Object.entries(ESTADO_DE_ORDEN).map(([valor, e]) => (
              <option key={valor} value={valor}>
                {e.texto}
              </option>
            ))}
          </select>
          <select
            aria-label="Tipo"
            className={control}
            value={filtros.tipo}
            onChange={(e) => filtrar({ tipo: e.target.value as TipoDeOrden | "" })}
          >
            <option value="">Todos los tipos</option>
            {Object.entries(TIPO).map(([valor, t]) => (
              <option key={valor} value={valor}>
                {t}
              </option>
            ))}
          </select>
          <select
            aria-label="Mecánico"
            className={`${control} max-w-full`}
            value={filtros.mecanico}
            onChange={(e) => filtrar({ mecanico: e.target.value })}
          >
            <option value="">Todos los mecánicos</option>
            <option value={SIN_ASIGNAR}>Sin asignar</option>
            {mecanicos.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nombre}
              </option>
            ))}
          </select>
          {areas.length > 0 && (
            <select
              aria-label="Área"
              className={`${control} max-w-full`}
              value={filtros.area}
              onChange={(e) => filtrar({ area: e.target.value })}
            >
              <option value="">Todas las áreas</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nombre}
                </option>
              ))}
            </select>
          )}
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
            <table className="w-full min-w-[960px] text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b border-slate-200">
                  <th className="px-4 py-3">OT</th>
                  <th className="px-4 py-3">Unidad</th>
                  <th className="px-4 py-3">Trabajo</th>
                  <th className="px-4 py-3">Tipo</th>
                  <th className="px-4 py-3">Prioridad</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Mecánico</th>
                  {conIperc && <th className="px-4 py-3">IPERC</th>}
                </tr>
              </thead>
              <tbody>
                {(datos === null || datos.filas.length === 0) && (
                  <tr>
                    <td colSpan={columnas} className="px-4 py-8 text-center text-slate-500">
                      {datos === null ? "Cargando…" : "Sin resultados"}
                    </td>
                  </tr>
                )}
                {datos?.filas.map((o) => (
                  <tr
                    key={o.id}
                    onClick={() => setAbierta(o.id)}
                    className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      <button
                        type="button"
                        aria-label={`Ver la orden ${o.id}`}
                        className="text-left"
                      >
                        <b className="block text-slate-900">#{o.id}</b>
                        <small className="text-slate-500">{cuandoFue(o.creado_en)}</small>
                      </button>
                    </td>
                    <td className="px-4 py-3 max-w-[180px] break-words">
                      <b className="block text-slate-800">{unidadDeLaOrden(o)}</b>
                      <small className="text-slate-500">
                        {[o.equipo_tipo, o.area].filter(Boolean).join(" · ")}
                      </small>
                    </td>
                    <td className="px-4 py-3 max-w-[240px] break-words">
                      <b className="block text-slate-900">{o.titulo}</b>
                      <small className="text-slate-500">
                        {origenDeLaOrden(o)}
                        {o.fecha_programada
                          ? ` · programada ${fechaProgramada(o.fecha_programada)}`
                          : ""}
                      </small>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{TIPO[o.tipo]}</td>
                    <td className="px-4 py-3">
                      <span className={`${chip} ${PRIORIDAD[o.prioridad].clase}`}>
                        {PRIORIDAD[o.prioridad].texto}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`${chip} ${ESTADO_DE_ORDEN[o.estado].clase}`}>
                        {ESTADO_DE_ORDEN[o.estado].texto}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-[160px] break-words text-slate-700">
                      {o.asignado_a_nombre ?? (
                        <span className="font-semibold text-red-700">Sin asignar</span>
                      )}
                    </td>
                    {conIperc && (
                      <td className="px-4 py-3">
                        {o.iperc_estado === "aprobado" ? (
                          <span className={`${chip} bg-emerald-100 text-emerald-700`}>
                            Autorizado
                          </span>
                        ) : o.iperc_estado ? (
                          <span className={`${chip} bg-amber-100 text-amber-700`}>
                            Sin autorizar
                          </span>
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

        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-slate-200">
          <p className="text-xs text-slate-500">
            Iniciar, completar, cancelar y eliminar se hacen en el módulo Órdenes de trabajo.
          </p>
          <div className="flex items-center gap-2">
            {datos && (
              <span className="text-xs text-slate-500">
                Página {pagina} de {datos.paginas}
              </span>
            )}
            <button
              type="button"
              onClick={() => setPagina((p) => p - 1)}
              disabled={pagina === 1}
              className={`${control} flex items-center gap-1 font-semibold disabled:opacity-40`}
            >
              <ChevronLeft size={15} /> Anterior
            </button>
            <button
              type="button"
              onClick={() => setPagina((p) => p + 1)}
              disabled={!datos || pagina >= datos.paginas}
              className={`${control} flex items-center gap-1 font-semibold disabled:opacity-40`}
            >
              Siguiente <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </section>

      {abierta !== null && (
        <PanelDeOrden
          key={abierta}
          id={abierta}
          onCerrar={() => setAbierta(null)}
          onCambio={cambiado}
        />
      )}
      {creando && (
        <NuevaOrden
          conUnidades
          catalogos={catalogos}
          onCerrar={() => setCreando(false)}
          onCreada={cambiado}
        />
      )}
    </div>
  );
}
