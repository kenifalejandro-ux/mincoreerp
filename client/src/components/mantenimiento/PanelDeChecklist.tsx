// client/src/components/mantenimiento/PanelDeChecklist.tsx
//
// El panel de un checklist, como la maqueta: qué significa para la unidad, lo que respondió, el resumen y la
// orden que generó. Quien tiene el permiso decide aquí la salida de una unidad con fallas menores.
import { ArrowRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cuandoFue } from "./actividadDelTurno";
import { TONOS } from "./centroDeMantenimiento";
import {
  consecuencia,
  RESULTADO_EN_OFICINA,
  unidadDelRegistro,
  type DetalleDeChecklist,
  type PreguntaRespondida,
} from "./checklistsMantenimiento";
import { leerRegistro } from "./mantenimientoApi";
import { useAuth } from "../../context/AuthContext";
import { tieneModulo } from "../../modules/tieneModulo";
import DecidirSalida from "../checklists/DecidirSalida";
import { puedeAutorizarSalida } from "../checklists/registro";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";
import PanelDeDetalle from "../proveedores/PanelDeDetalle";

const RESPUESTA: Record<PreguntaRespondida["estado"], { texto: string; clase: string }> = {
  bien: { texto: "Bien", clase: "bg-emerald-100 text-emerald-600" },
  malo: { texto: "Falla", clase: "bg-amber-100 text-amber-700" },
  na: { texto: "N/A", clase: "bg-slate-100 text-slate-500" },
};
const chip = "rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap";
const caja = "rounded-xl border border-slate-200 bg-white shadow-sm";

export default function PanelDeChecklist({
  id,
  onCerrar,
  onDecidida,
}: {
  id: number;
  onCerrar: () => void;
  onDecidida: () => void;
}) {
  const { usuario } = useAuth();
  const puedeEscribir = usePuedeEscribir("checklists");
  const conOrdenes = tieneModulo(usuario, "ordenes_trabajo");
  const [c, setC] = useState<DetalleDeChecklist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decidiendo, setDecidiendo] = useState(false);

  const cargar = useCallback(() => {
    setError(null);
    leerRegistro(id)
      .then(setC)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Error"));
  }, [id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  const franja = c && consecuencia(c);
  const decide =
    !!c && c.salida === "por_autorizar" && puedeEscribir && puedeAutorizarSalida(usuario);
  const fallas = c?.items.filter((i) => i.estado === "malo").length ?? 0;
  const bien = c?.items.filter((i) => i.estado === "bien").length ?? 0;

  return (
    <PanelDeDetalle etiqueta="Detalle del checklist" titulo="Checklist pre-uso" onCerrar={onCerrar}>
      {error ? (
        <div role="alert" className="py-8 text-center text-sm text-red-700">
          No se pudo abrir el checklist. {error}
          <button
            type="button"
            onClick={cargar}
            className="mx-auto mt-2 block min-h-[44px] sm:min-h-9 px-4 rounded-lg border border-slate-300 bg-white font-semibold text-slate-700"
          >
            Reintentar
          </button>
        </div>
      ) : !c || !franja ? (
        <p className="py-8 text-center text-sm text-slate-500">Cargando…</p>
      ) : (
        <div className="space-y-4">
          <header className={`${caja} p-5`}>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-semibold text-slate-900">#{c.id}</h2>
              <span className={`${chip} ${RESULTADO_EN_OFICINA[c.resultado].clase}`}>
                {RESULTADO_EN_OFICINA[c.resultado].texto}
              </span>
            </div>
            <p className="mt-1 break-words text-sm text-slate-600">
              {unidadDelRegistro(c)} · {c.usuario_nombre} · {cuandoFue(c.creado_en)}
            </p>
          </header>

          <section
            aria-label="Consecuencia"
            className={`flex flex-wrap items-center justify-between gap-3 rounded-xl p-4 ${TONOS[franja.tono]}`}
          >
            <div className="min-w-0">
              <b className="block text-sm">{franja.titulo}</b>
              <span className="block break-words text-xs text-slate-600">{franja.detalle}</span>
              {decide && c.usuario_id === usuario?.id && (
                <span className="block text-xs text-slate-600">
                  Lo llenaste tú: lo decide otra persona.
                </span>
              )}
            </div>
            {decide && c.usuario_id !== usuario?.id && (
              <button
                type="button"
                onClick={() => setDecidiendo(true)}
                className="min-h-[44px] sm:min-h-10 rounded-lg bg-[#BADC1E] px-4 text-sm font-semibold text-[#0A1014]"
              >
                Decidir salida
              </button>
            )}
          </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <section className={caja}>
              <h3 className="border-b border-slate-200 px-5 py-3 font-semibold text-slate-900">
                Lo que respondió
              </h3>
              <ul>
                {c.items.map((i) => (
                  <li
                    key={i.id}
                    className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-5 py-3 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <b className="block break-words text-sm text-slate-900">{i.descripcion}</b>
                      {i.observacion && (
                        <span className="block break-words text-xs text-slate-500">
                          {i.observacion}
                        </span>
                      )}
                    </div>
                    <span className="flex gap-1.5">
                      {i.critica && (
                        <span className={`${chip} bg-slate-100 text-slate-600`}>Crítica</span>
                      )}
                      <span
                        className={`${chip} ${
                          i.critica && i.estado === "malo"
                            ? "bg-red-100 text-red-700"
                            : RESPUESTA[i.estado].clase
                        }`}
                      >
                        {RESPUESTA[i.estado].texto}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <aside className="space-y-4">
              <section className={`${caja} p-5`}>
                <h3 className="mb-3 font-semibold text-slate-900">Resumen</h3>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  {[
                    ["Preguntas", c.items.length],
                    ["Bien", bien],
                    ["Fallas", fallas],
                    ["Lectura al enviar", c.lectura_valor?.toLocaleString("en-US") ?? "—"],
                  ].map(([nombre, valor]) => (
                    <div key={nombre}>
                      <dt className="text-xs text-slate-500">{nombre}</dt>
                      <dd className="font-bold text-slate-900">{valor}</dd>
                    </div>
                  ))}
                </dl>
                {[c.observaciones_generales, c.aviso_registro].filter(Boolean).map((t) => (
                  <p key={t} className="mt-3 break-words text-xs text-slate-600">
                    {t}
                  </p>
                ))}
              </section>
              {conOrdenes && (
                <section className={`${caja} p-5`}>
                  <h3 className="mb-2 font-semibold text-slate-900">Orden generada</h3>
                  {c.ordenes_trabajo.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      Este checklist no generó ninguna orden.
                    </p>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-slate-900">
                        {c.ordenes_trabajo.map((o) => `OT #${o}`).join(", ")}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent("mincore:ir-a-pestana", { detail: "ordenes_trabajo" })
                          )
                        }
                        className="mt-2 flex min-h-[44px] sm:min-h-9 items-center gap-1.5 text-sm font-semibold text-[#4d7c0f] hover:underline"
                      >
                        Ver órdenes de trabajo <ArrowRight size={15} />
                      </button>
                    </>
                  )}
                </section>
              )}
            </aside>
          </div>
        </div>
      )}

      {decidiendo && c && (
        <DecidirSalida
          id={c.id}
          unidad={unidadDelRegistro(c)}
          conOrdenes={conOrdenes}
          onDecidida={() => {
            setDecidiendo(false);
            cargar();
            onDecidida();
          }}
          onCerrar={() => setDecidiendo(false)}
        />
      )}
    </PanelDeDetalle>
  );
}
