// client/src/components/equipos/HistorialEquipo.tsx
//
// Quién manejó la unidad y con qué rutas, y entre qué fechas (migración 0126).
// Es una CONSULTA: va en una ventana flotante, no en un modal, para poder
// mirarla con la tabla de atrás. Lectura también la ve.
import { useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";
import VentanaFlotante from "../comunes/VentanaFlotante";

interface FilaConductor {
  id: string;
  conductor_nombre: string | null;
  conductor_dni: string | null;
  desde: string;
  hasta: string | null;
  motivo: string;
  usuario: string | null;
  motivo_cierre: string | null;
  cerrado_por: string | null;
}

interface FilaRuta {
  id: string;
  origen: string;
  destino: string;
  desde: string;
  hasta: string | null;
  motivo: string;
  usuario: string | null;
  motivo_cierre: string | null;
  cerrado_por: string | null;
}

interface Historial {
  conductores: FilaConductor[];
  rutas: FilaRuta[];
}

const fecha = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });

function Vigencia({ desde, hasta }: { desde: string; hasta: string | null }) {
  return (
    <span className="text-xs text-[#94a3b8]">
      {fecha(desde)} → {hasta ? fecha(hasta) : "hoy"}
    </span>
  );
}

function Fila({
  titulo,
  desde,
  hasta,
  motivo,
  usuario,
  motivoCierre,
  cerradoPor,
}: {
  titulo: string;
  desde: string;
  hasta: string | null;
  motivo: string;
  usuario: string | null;
  motivoCierre: string | null;
  cerradoPor: string | null;
}) {
  return (
    <li className="border border-[#334155] rounded-xl p-3 bg-[#0D1719]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-white">{titulo}</span>
        {hasta === null ? (
          <span className="text-[10px] font-bold uppercase bg-[#BADC1E] text-[#0D1719] px-2 py-0.5 rounded-full">
            Vigente
          </span>
        ) : null}
      </div>
      <Vigencia desde={desde} hasta={hasta} />
      <div className="text-xs text-[#cbd5e1] mt-1">
        Desde: {motivo}
        {usuario ? ` · ${usuario}` : ""}
      </div>
      {hasta !== null && motivoCierre && (
        <div className="text-xs text-[#cbd5e1]">
          Hasta: {motivoCierre}
          {cerradoPor ? ` · ${cerradoPor}` : ""}
        </div>
      )}
    </li>
  );
}

export default function HistorialEquipo({
  equipoId,
  placa,
  onCerrar,
}: {
  equipoId: number;
  placa: string;
  onCerrar: () => void;
}) {
  const [datos, setDatos] = useState<Historial | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/erp/equipos/${equipoId}/historial`);
        if (!res.ok) throw new Error();
        const body = (await res.json()) as Historial;
        if (vigente) setDatos(body);
      } catch {
        if (vigente) setError(true);
      }
    })();
    return () => {
      vigente = false;
    };
  }, [equipoId]);

  return (
    <VentanaFlotante
      id={`equipo-historial-${equipoId}`}
      titulo={`Historial — ${placa}`}
      subtitulo="Conductores y rutas de la unidad, del más reciente al más antiguo"
      onCerrar={onCerrar}
      anchoInicial={640}
      altoInicial={560}
    >
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6 text-sm">
        {error ? (
          <p className="text-[#fca5a5]">No se pudo cargar el historial.</p>
        ) : datos === null ? (
          <p className="text-[#94a3b8]">Cargando...</p>
        ) : (
          <>
            <section>
              <h4 className="text-xs font-bold uppercase tracking-wide text-[#94a3b8] mb-2">
                Conductores
              </h4>
              {datos.conductores.length === 0 ? (
                <p className="text-[#94a3b8]">Esta unidad nunca tuvo un conductor asignado.</p>
              ) : (
                <ul className="space-y-2">
                  {datos.conductores.map((c) => (
                    <Fila
                      key={c.id}
                      titulo={`${c.conductor_nombre ?? "Sin nombre"}${
                        c.conductor_dni ? ` · DNI ${c.conductor_dni}` : ""
                      }`}
                      desde={c.desde}
                      hasta={c.hasta}
                      motivo={c.motivo}
                      usuario={c.usuario}
                      motivoCierre={c.motivo_cierre}
                      cerradoPor={c.cerrado_por}
                    />
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h4 className="text-xs font-bold uppercase tracking-wide text-[#94a3b8] mb-2">
                Rutas
              </h4>
              {datos.rutas.length === 0 ? (
                <p className="text-[#94a3b8]">Esta unidad nunca tuvo una ruta habitual asignada.</p>
              ) : (
                <ul className="space-y-2">
                  {datos.rutas.map((r) => (
                    <Fila
                      key={r.id}
                      titulo={`${r.origen} → ${r.destino}`}
                      desde={r.desde}
                      hasta={r.hasta}
                      motivo={r.motivo}
                      usuario={r.usuario}
                      motivoCierre={r.motivo_cierre}
                      cerradoPor={r.cerrado_por}
                    />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </VentanaFlotante>
  );
}
