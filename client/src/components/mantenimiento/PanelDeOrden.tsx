// client/src/components/mantenimiento/PanelDeOrden.tsx
//
// El panel de una orden de trabajo, como la maqueta: qué falta, su resumen, el recorrido, los repuestos y el
// cierre. Aquí se asigna el mecánico, se anotan horas y tareas, se inicia, completa o cancela y se da la
// conformidad. Eliminar sigue en el módulo Órdenes de trabajo.
import { Check, ClipboardList, Users, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cuandoFue } from "./actividadDelTurno";
import AsignarMecanico from "./AsignarMecanico";
import CambiarEstadoDeOrden from "./CambiarEstadoDeOrden";
import { tieneCasillaDeConformidad } from "./conformidad";
import {
  cambiarEstadoDeOrden,
  darConformidad,
  estadoDelIperc,
  leerConfig,
  leerOrden,
} from "./mantenimientoApi";
import {
  estaAbierta,
  ESTADO_DE_ORDEN,
  faltaConformidad,
  fechaProgramada,
  origenDeLaOrden,
  pasosDeLaOrden,
  PRIORIDAD,
  TIPO,
  unidadDeLaOrden,
  type DetalleDeOrdenEnOficina,
} from "./ordenesMantenimiento";
import { useAuth } from "../../context/AuthContext";
import { tieneModulo } from "../../modules/tieneModulo";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";
import DetalleDeOrden from "../ordenes_trabajo/DetalleDeOrden";
import { textoDeDuracion } from "../ordenes_trabajo/horasYTareas";
import PanelDeDetalle from "../proveedores/PanelDeDetalle";

const caja = "rounded-xl border border-slate-200 bg-white shadow-sm";
const boton =
  "min-h-[44px] sm:min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50";
const chip = "rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap";

function Banda({
  tono,
  icono,
  titulo,
  texto,
  children,
}: {
  tono: "green" | "amber" | "red" | "blue" | "gray";
  icono: ReactNode;
  titulo: string;
  texto: string;
  children?: ReactNode;
}) {
  const clase = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-800",
    blue: "border-blue-200 bg-blue-50 text-blue-800",
    gray: "border-slate-200 bg-slate-100 text-slate-700",
  }[tono];
  return (
    <section
      aria-label="Qué sigue"
      className={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${clase}`}
    >
      {icono}
      <div className="min-w-0 flex-1">
        <b className="block text-sm">{titulo}</b>
        <span className="block break-words text-xs">{texto}</span>
      </div>
      {children}
    </section>
  );
}

export default function PanelDeOrden({
  id,
  onCerrar,
  onCambio,
}: {
  id: number;
  onCerrar: () => void;
  /** Cambió la orden: la lista y las cifras se releen. */
  onCambio: () => void;
}) {
  const { usuario } = useAuth();
  const puedeEscribir = usePuedeEscribir("ordenes_trabajo");
  const conIperc = tieneModulo(usuario, "iperc");
  const conRepuestos = tieneModulo(usuario, "repuestos");
  const [datos, setDatos] = useState<{
    orden: DetalleDeOrdenEnOficina;
    iperc: string | null;
    exigeConformidad: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ventana, setVentana] = useState<"asignar" | "trabajo" | "completada" | "cancelada" | null>(
    null
  );
  const [errorDeAccion, setErrorDeAccion] = useState<string | null>(null);
  const [actuando, setActuando] = useState(false);

  // Solo vale la última lectura pedida.
  const ultima = useRef(0);
  const cargar = useCallback(() => {
    const esta = ++ultima.current;
    setError(null);
    leerOrden(id)
      .then(async (orden) => {
        const iperc = conIperc && orden.iperc_id ? await estadoDelIperc(orden.iperc_id) : null;
        // Con la regla apagada la unidad ya está libre. Si no se puede leer, manda lo que dice la orden.
        const exigeConformidad = orden.requiere_conformidad
          ? await leerConfig()
              .then((c) => c.exige_conformidad)
              .catch(() => true)
          : false;
        if (esta === ultima.current) setDatos({ orden, iperc, exigeConformidad });
      })
      .catch((e: unknown) => {
        if (esta === ultima.current) setError(e instanceof Error ? e.message : "Error");
      });
  }, [id, conIperc]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  const cambiado = () => {
    cargar();
    onCambio();
  };
  const cerrarVentana = useCallback(() => setVentana(null), []);
  /** Algo salió bien desde una ventana: el aviso de un intento anterior ya no vale. */
  const salioBien = () => {
    setErrorDeAccion(null);
    cambiado();
  };
  /** Iniciar o dar la conformidad: una acción a la vez; si el servidor rechaza, se relee. */
  const actuar = (accion: () => Promise<unknown>) => {
    if (actuando) return;
    setActuando(true);
    setErrorDeAccion(null);
    accion()
      .then(cambiado)
      .catch((e: unknown) => {
        setErrorDeAccion(e instanceof Error ? e.message : "Error");
        if (navigator.onLine) cambiado();
      })
      .finally(() => setActuando(false));
  };

  const o = datos?.orden;
  // Con la regla apagada, una conformidad que nunca se dio ya no es un paso pendiente.
  const pasos = o
    ? pasosDeLaOrden(
        {
          ...o,
          requiere_conformidad:
            o.requiere_conformidad && (datos.exigeConformidad || !!o.conformidad_en),
        },
        conIperc ? { estado: datos.iperc } : null
      )
    : [];
  const falta = pasos.find((p) => p.actual)?.clave;
  const abierta = !!o && estaAbierta(o.estado);
  const hechas = o?.tareas.filter((t) => t.hecha).length ?? 0;
  const porConformar = !!o && faltaConformidad(o, datos.exigeConformidad);
  const puedeConformar =
    puedeEscribir && tieneCasillaDeConformidad(usuario) && o?.asignado_a !== usuario?.id;
  const principal =
    "min-h-[44px] sm:min-h-10 rounded-lg bg-[#BADC1E] px-4 text-sm font-semibold text-[#0A1014] hover:brightness-95 disabled:opacity-50";

  return (
    <PanelDeDetalle etiqueta="Detalle de la orden" titulo="Orden de trabajo" onCerrar={onCerrar}>
      {error && (
        <div role="alert" className="mb-4 rounded-xl bg-red-50 p-4 text-sm text-red-700">
          No se pudo leer la orden. {error}
          <button type="button" onClick={cargar} className={`${boton} mt-2 block`}>
            Volver a leer
          </button>
        </div>
      )}
      {!o ? (
        !error && <p className="py-8 text-center text-sm text-slate-500">Cargando…</p>
      ) : (
        <div className="space-y-4">
          <header className={`${caja} p-5`}>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-semibold text-slate-900">OT #{o.id}</h2>
              <span className={`${chip} ${ESTADO_DE_ORDEN[o.estado].clase}`}>
                {ESTADO_DE_ORDEN[o.estado].texto}
              </span>
              <span className={`${chip} ${PRIORIDAD[o.prioridad].clase}`}>
                {PRIORIDAD[o.prioridad].texto}
              </span>
            </div>
            <p className="mt-1 break-words text-sm text-slate-600">
              {o.titulo} · {TIPO[o.tipo]} · {origenDeLaOrden(o)}
            </p>
            {puedeEscribir && abierta && (
              <div className="mt-3 flex flex-wrap gap-2">
                {o.estado === "abierta" ? (
                  <button
                    type="button"
                    disabled={actuando}
                    onClick={() => actuar(() => cambiarEstadoDeOrden(id, "en_progreso"))}
                    className={principal}
                  >
                    Iniciar
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setVentana("completada")}
                    className={principal}
                  >
                    Completar
                  </button>
                )}
                <button type="button" onClick={() => setVentana("cancelada")} className={boton}>
                  Cancelar orden
                </button>
              </div>
            )}
          </header>

          {errorDeAccion && (
            <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">
              {errorDeAccion}
            </p>
          )}
          {porConformar && (
            <Banda
              tono="blue"
              icono={<Check size={22} />}
              titulo="Pendiente de conformidad"
              texto={
                puedeConformar
                  ? "El trabajo terminó. Prueba el equipo y da la conformidad para liberarlo."
                  : "El trabajo terminó. Falta que la dé quien tiene esa casilla (no el mecánico de la orden)."
              }
            >
              {puedeConformar && (
                <button
                  type="button"
                  disabled={actuando}
                  onClick={() => actuar(() => darConformidad(id))}
                  className={principal}
                >
                  Dar conformidad
                </button>
              )}
            </Banda>
          )}
          {o.estado === "completada" && !porConformar && (
            <Banda
              tono="green"
              icono={<Check size={22} />}
              titulo="Orden completada"
              texto={o.fecha_cierre ? `Cerrada ${cuandoFue(o.fecha_cierre)}` : "Trabajo terminado."}
            />
          )}
          {o.estado === "cancelada" && (
            <Banda
              tono="gray"
              icono={<ClipboardList size={22} />}
              titulo="Orden cancelada"
              texto={o.fecha_cierre ? `Cancelada ${cuandoFue(o.fecha_cierre)}` : "No se hizo."}
            />
          )}
          {falta === "mecanico" && (
            <Banda
              tono={o.prioridad === "urgente" ? "red" : "amber"}
              icono={<Users size={22} />}
              titulo="Falta asignar un mecánico"
              texto="Elige quién la hará."
            >
              {puedeEscribir && (
                <button
                  type="button"
                  onClick={() => setVentana("asignar")}
                  className="min-h-[44px] sm:min-h-10 rounded-lg bg-[#BADC1E] px-4 text-sm font-semibold text-[#0A1014] hover:brightness-95"
                >
                  Asignar mecánico
                </button>
              )}
            </Banda>
          )}
          {falta === "trabajo" && (
            <Banda
              tono="blue"
              icono={<Wrench size={22} />}
              titulo="Lista para iniciar"
              texto="Se inicia cuando empieza el trabajo."
            />
          )}
          {falta === "cierre" && (
            <Banda
              tono="blue"
              icono={<Wrench size={22} />}
              titulo="Trabajo en curso"
              texto="Se completa cuando termina."
            />
          )}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <div className="space-y-4">
              <section aria-label="Resumen" className={`${caja} p-5`}>
                <h3 className="mb-3 font-semibold text-slate-900">Resumen</h3>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  {[
                    ["Unidad", unidadDeLaOrden(o)],
                    ["Creada", `${cuandoFue(o.creado_en)} · ${o.creado_por_nombre}`],
                    ["Prioridad", PRIORIDAD[o.prioridad].texto],
                    ["Programada", fechaProgramada(o.fecha_programada) ?? "—"],
                  ].map(([etiqueta, valor]) => (
                    <div key={etiqueta} className="min-w-0">
                      <dt className="text-xs text-slate-500">{etiqueta}</dt>
                      <dd className="break-words font-semibold text-slate-900">{valor}</dd>
                    </div>
                  ))}
                </dl>
                {o.descripcion && (
                  <p className="mt-3 whitespace-pre-line break-words text-sm text-slate-700">
                    {o.descripcion}
                  </p>
                )}
                {o.unidad_no_opera && abierta && (
                  <p className="mt-3 text-sm font-bold text-red-700">La unidad no puede operar</p>
                )}
                <div className="mt-4">
                  <span className="block text-xs text-slate-500">Mecánico</span>
                  {abierta && puedeEscribir && o.asignado_a ? (
                    <button
                      type="button"
                      onClick={() => setVentana("asignar")}
                      className={`${boton} flex max-w-full items-center gap-2`}
                    >
                      <span className="min-w-0 break-words text-left [overflow-wrap:anywhere]">
                        {o.asignado_a_nombre}
                      </span>
                      <small className="text-[#4d7c0f]">Cambiar</small>
                    </button>
                  ) : (
                    <b className="block break-words text-sm text-slate-900">
                      {o.asignado_a_nombre ?? "Sin asignar"}
                    </b>
                  )}
                </div>
              </section>

              <section aria-label="Horas y tareas" className={`${caja} p-5`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-slate-900">Horas y tareas</h3>
                  <button type="button" onClick={() => setVentana("trabajo")} className={boton}>
                    Horas y tareas
                  </button>
                </div>
                <p className="mt-2 text-sm text-slate-600">
                  Duración: {textoDeDuracion(o.duracion_minutos) ?? "sin datos"} · Tareas:{" "}
                  {o.tareas.length === 0 ? "ninguna" : `${hechas} de ${o.tareas.length}`}
                </p>
              </section>

              {conRepuestos && (
                <section aria-label="Repuestos" className={`${caja} p-5`}>
                  <h3 className="font-semibold text-slate-900">
                    Repuestos{" "}
                    <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                      Pronto
                    </span>
                  </h3>
                </section>
              )}

              {o.observaciones_cierre && (
                <section aria-label="Cierre" className={`${caja} p-5`}>
                  <h3 className="mb-2 font-semibold text-slate-900">Observaciones de cierre</h3>
                  <p className="whitespace-pre-line break-words text-sm text-slate-700">
                    {o.observaciones_cierre}
                  </p>
                </section>
              )}
            </div>

            <section aria-label="Cómo avanza" className={`${caja} h-fit p-5`}>
              <h3 className="mb-3 font-semibold text-slate-900">Cómo avanza</h3>
              <ol className="space-y-4">
                {pasos.map((p) => (
                  <li
                    key={p.clave}
                    aria-current={p.actual ? "step" : undefined}
                    className="flex items-start gap-3 text-sm"
                  >
                    <span
                      aria-hidden
                      className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
                        p.estado === "hecho"
                          ? "border-emerald-500 bg-emerald-500 text-white"
                          : p.actual
                            ? "border-amber-500 bg-amber-100"
                            : "border-slate-300"
                      }`}
                    >
                      {p.estado === "hecho" && <Check size={12} />}
                    </span>
                    <div className="min-w-0">
                      <b className="block text-slate-900">{p.titulo}</b>
                      <small className="break-words text-slate-500">{p.detalle}</small>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </div>
      )}

      {ventana === "asignar" && o && (
        <AsignarMecanico
          orden={o}
          onCerrar={cerrarVentana}
          onRechazo={cambiado}
          onAsignado={() => {
            setVentana(null);
            salioBien();
          }}
        />
      )}
      {(ventana === "completada" || ventana === "cancelada") && (
        <CambiarEstadoDeOrden
          id={id}
          estado={ventana}
          onCerrar={cerrarVentana}
          onRechazo={cambiado}
          onCambiado={() => {
            setVentana(null);
            salioBien();
          }}
        />
      )}
      {ventana === "trabajo" && (
        <DetalleDeOrden
          id={id}
          puedeEscribir={puedeEscribir}
          onCambio={salioBien}
          onCerrar={() => setVentana(null)}
        />
      )}
    </PanelDeDetalle>
  );
}
