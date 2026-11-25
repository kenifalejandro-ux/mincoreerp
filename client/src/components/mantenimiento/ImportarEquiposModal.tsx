// client/src/components/mantenimiento/ImportarEquiposModal.tsx
//
// La ventana «Importar equipos» de la maqueta, con dos pestañas:
//  · «Desde Operaciones»: las unidades que registró Flota. Comparten el maestro de equipos con Mantenimiento, así
//    que NO se copian: solo se les da su área y su propiedad. Solo aparece si la persona tiene Flota; sin ella no
//    hay pestaña ni lista, y el resto funciona igual.
//  · «Desde Excel»: la zona de arrastre. Al soltar o elegir el archivo, esta ventana se cierra y se abre la vista
//    previa de siempre, que valida fila por fila antes de guardar nada.
import { Check, FileSpreadsheet, Truck, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { COLUMNAS_DE_LA_PLANILLA } from "./importarEquipos";
import {
  completarEquipos,
  listarPendientes,
  type AreaMantenimiento,
  type EquipoMantenimiento,
} from "./mantenimientoApi";
import { useAuth } from "../../context/AuthContext";
import { tieneModulo } from "../../modules/tieneModulo";
import { marcarNovedadVista, novedadVigente } from "../controlTv/novedad";

export type PestaniaDeImportar = "operaciones" | "excel";

/** La etiqueta «Nuevo» de la pestaña «Desde Operaciones» (24 horas desde el primer clic, ver controlTv/novedad.ts). */
const NOVEDAD_DESDE_OPERACIONES = "mantenimiento-desde-operaciones-2026-11";
const desdeOperacionesEsNuevo = () =>
  novedadVigente(Date.now(), undefined, NOVEDAD_DESDE_OPERACIONES);
const marcarDesdeOperacionesVista = () =>
  marcarNovedadVista(Date.now(), undefined, NOVEDAD_DESDE_OPERACIONES);

const control =
  "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#84cc16]";

export default function ImportarEquiposModal({
  inicial,
  areas,
  onArchivo,
  onCompletado,
  onCerrar,
}: {
  inicial: PestaniaDeImportar;
  areas: AreaMantenimiento[];
  /** Un archivo elegido o soltado: lo lee la pantalla de Equipos, que abre la vista previa. */
  onArchivo: (archivo: File) => void;
  /** Se completaron unidades: la pantalla recarga la lista y el contador. */
  onCompletado: () => void;
  onCerrar: () => void;
}) {
  const { usuario } = useAuth();
  const conOperaciones = tieneModulo(usuario, "flota");
  const [pestania, setPestania] = useState<PestaniaDeImportar>(conOperaciones ? inicial : "excel");
  const [pendientes, setPendientes] = useState<EquipoMantenimiento[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elegidas, setElegidas] = useState<Record<number, boolean>>({});
  const [propiedad, setPropiedad] = useState<"propia" | "alquilada">("propia");
  const [areaId, setAreaId] = useState<string>("");
  const [enviando, setEnviando] = useState(false);
  const [hechas, setHechas] = useState<number | null>(null);
  const [arrastrando, setArrastrando] = useState(false);
  const selector = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!conOperaciones) return;
    let vigente = true;
    listarPendientes()
      .then((l) => vigente && setPendientes(l))
      .catch((e: unknown) => {
        if (!vigente) return;
        setPendientes([]);
        setError(e instanceof Error ? e.message : "No se pudo leer Operaciones");
      });
    return () => {
      vigente = false;
    };
  }, [conOperaciones]);

  const lista = pendientes ?? [];
  const marcadas = lista.filter((u) => elegidas[u.id] !== false);

  const completar = async () => {
    if (enviando || marcadas.length === 0) return;
    setEnviando(true);
    setError(null);
    try {
      const r = await completarEquipos({
        ids: marcadas.map((u) => u.id),
        propiedad,
        area_id: areaId ? Number(areaId) : null,
      });
      setHechas(r.completados);
      onCompletado();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo completar");
    } finally {
      setEnviando(false);
    }
  };

  const soltar = (archivo: File | undefined) => {
    if (!archivo) return;
    onArchivo(archivo);
    onCerrar();
  };

  const pestaniaBoton = (
    id: PestaniaDeImportar,
    texto: string,
    Icono: typeof Truck,
    esNuevo = false
  ) => (
    <button
      role="tab"
      aria-selected={pestania === id}
      onClick={() => {
        setPestania(id);
        if (esNuevo) marcarDesdeOperacionesVista();
      }}
      className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 -mb-px ${
        pestania === id
          ? "border-[#84cc16] text-[#3f6212]"
          : "border-transparent text-slate-500 hover:text-slate-800"
      }`}
    >
      <Icono size={16} /> {texto}
      {esNuevo && desdeOperacionesEsNuevo() && (
        <span className="px-1.5 py-0.5 rounded-full bg-[#BADC1E] text-[#0A1014] text-[9px] font-extrabold">
          Nuevo
        </span>
      )}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}
    >
      <div
        role="dialog"
        aria-label="Importar equipos"
        aria-modal="true"
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-2xl shadow-2xl"
      >
        <div className="flex items-start justify-between p-6 border-b border-slate-200">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              Equipos
            </p>
            <h2 className="text-xl font-semibold text-slate-900">
              {hechas !== null ? "Importación lista" : "Importar equipos"}
            </h2>
          </div>
          <button
            onClick={onCerrar}
            aria-label="Cerrar"
            className="p-2 rounded-md text-slate-500 hover:bg-slate-100"
          >
            <X size={18} />
          </button>
        </div>

        {hechas !== null ? (
          <div className="p-10 text-center">
            <span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-[#BADC1E]/25 text-[#3f6212]">
              <Check size={28} />
            </span>
            <h3 className="text-lg font-semibold text-slate-900">
              {hechas === 1 ? "1 equipo importado" : `${hechas} equipos importados`}
            </h3>
            <p className="mt-1 mb-5 text-sm text-slate-500 max-w-md mx-auto">
              Ya tienen su área y su propiedad. Son los mismos equipos que en Operaciones: si
              cambias la placa en un lado, se ve en el otro.
            </p>
            <button
              onClick={onCerrar}
              className="h-10 px-5 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
            >
              Continuar
            </button>
          </div>
        ) : (
          <>
            <div role="tablist" className="flex px-4 border-b border-slate-200">
              {conOperaciones && pestaniaBoton("operaciones", "Desde Operaciones", Truck, true)}
              {pestaniaBoton("excel", "Desde Excel", FileSpreadsheet)}
            </div>

            {pestania === "operaciones" && (
              <div className="p-6">
                {error && (
                  <p
                    role="alert"
                    className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
                  >
                    {error}
                  </p>
                )}
                {pendientes === null ? (
                  <p className="text-sm text-slate-500">Cargando…</p>
                ) : lista.length === 0 ? (
                  <div className="py-8 text-center">
                    <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-[#BADC1E]/25 text-[#3f6212]">
                      <Check size={24} />
                    </span>
                    <h3 className="text-lg font-semibold text-slate-900">Todo al día</h3>
                    <p className="text-sm text-slate-500">
                      No hay unidades nuevas en Operaciones. Cuando se agregue una, aparece aquí.
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="mb-3 text-sm text-slate-600 border border-dashed border-slate-300 rounded-lg p-3">
                      Estas unidades están en Operaciones y todavía no tienen su área ni su
                      propiedad en Mantenimiento. Comparten los mismos datos básicos (placa, tipo,
                      marca, modelo y lectura): no se copia nada, solo se completan.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                      <label className="text-xs font-semibold text-slate-600">
                        Propiedad
                        <select
                          className={`${control} w-full mt-1`}
                          value={propiedad}
                          onChange={(e) => setPropiedad(e.target.value as "propia" | "alquilada")}
                        >
                          <option value="propia">Propia</option>
                          <option value="alquilada">Alquilada</option>
                        </select>
                      </label>
                      <label className="text-xs font-semibold text-slate-600">
                        Área
                        <select
                          className={`${control} w-full mt-1`}
                          value={areaId}
                          onChange={(e) => setAreaId(e.target.value)}
                        >
                          <option value="">Sin área</option>
                          {areas.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.nombre}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <ul className="space-y-2">
                      {lista.map((u) => (
                        <li key={u.id}>
                          <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 cursor-pointer hover:bg-slate-100">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[#84cc16]"
                              checked={elegidas[u.id] !== false}
                              onChange={(e) =>
                                setElegidas((a) => ({ ...a, [u.id]: e.target.checked }))
                              }
                            />
                            <span className="w-10 h-10 rounded-lg bg-white text-[#4d7c0f] grid place-items-center text-xs font-bold shrink-0">
                              {u.placa_codigo.slice(0, 3).toUpperCase()}
                            </span>
                            <span className="min-w-0">
                              <b className="block text-slate-900">{u.placa_codigo}</b>
                              <small className="text-slate-500">
                                {[u.tipo, [u.marca, u.modelo].filter(Boolean).join(" ")]
                                  .filter(Boolean)
                                  .join(" · ")}{" "}
                                · {u.lectura.toLocaleString("en-US", { maximumFractionDigits: 1 })}{" "}
                                {u.medidor === "horometro" ? "h" : "km"}
                              </small>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            {pestania === "excel" && (
              <div className="p-6">
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setArrastrando(true);
                  }}
                  onDragLeave={() => setArrastrando(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setArrastrando(false);
                    soltar(e.dataTransfer.files?.[0]);
                  }}
                  onClick={() => selector.current?.click()}
                  className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
                    arrastrando
                      ? "border-[#84cc16] bg-[#BADC1E]/10"
                      : "border-slate-300 hover:border-[#84cc16]"
                  }`}
                >
                  <Upload size={30} className="mx-auto mb-2 text-slate-500" />
                  <b className="block text-slate-900">Arrastra tu archivo Excel aquí</b>
                  <span className="block text-sm text-slate-500 mt-1">
                    o toca para elegirlo · columnas: {COLUMNAS_DE_LA_PLANILLA} (Placa y Tipo son
                    obligatorias)
                  </span>
                  <input
                    ref={selector}
                    type="file"
                    accept=".xlsx, .xls"
                    aria-label="Archivo de Excel"
                    className="hidden"
                    onChange={(e) => {
                      const archivo = e.target.files?.[0];
                      e.target.value = "";
                      soltar(archivo);
                    }}
                  />
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Antes de guardar verás qué se va a importar. Si el Área no existe, se crea.
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2 p-4 border-t border-slate-200">
              <button
                onClick={onCerrar}
                className="h-10 px-4 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancelar
              </button>
              {pestania === "operaciones" && lista.length > 0 && (
                <button
                  onClick={completar}
                  disabled={enviando || marcadas.length === 0}
                  className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95 disabled:opacity-50"
                >
                  <Upload size={16} /> {enviando ? "Importando…" : `Importar ${marcadas.length}`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
