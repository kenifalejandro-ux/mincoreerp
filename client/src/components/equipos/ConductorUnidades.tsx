// client/src/components/equipos/ConductorUnidades.tsx
//
// Las unidades que maneja y manejó un conductor, buscadas por su DNI. Responde
// "¿qué manejó Juan este mes?" cuando hay una incidencia. Es una CONSULTA: va en
// ventana flotante, y Lectura también la ve.
import { useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";
import VentanaFlotante from "../comunes/VentanaFlotante";

interface FilaUnidad {
  id: string;
  equipo_id: number;
  placa_codigo: string;
  tipo: string;
  conductor_nombre: string | null;
  desde: string;
  hasta: string | null;
  motivo: string;
  usuario: string | null;
  motivo_cierre: string | null;
  cerrado_por: string | null;
}

const fecha = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });

function Item({ f }: { f: FilaUnidad }) {
  const vigente = f.hasta === null;
  return (
    <li
      className={`border rounded-xl p-3 bg-[#0D1719] ${
        vigente ? "border-[#BADC1E]/50" : "border-[#334155]"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-white">
          <span className="font-mono">{f.placa_codigo}</span>{" "}
          <span className="text-[#94a3b8] font-normal">· {f.tipo}</span>
        </span>
        {vigente && (
          <span className="text-[10px] font-bold uppercase bg-[#BADC1E] text-[#0D1719] px-2 py-0.5 rounded-full">
            Vigente
          </span>
        )}
      </div>
      <div className="text-xs text-[#94a3b8]">
        {fecha(f.desde)} → {f.hasta ? fecha(f.hasta) : "hoy"}
      </div>
      <div className="text-xs text-[#cbd5e1] mt-1">
        Desde: {f.motivo}
        {f.usuario ? ` · ${f.usuario}` : ""}
      </div>
      {!vigente && f.motivo_cierre && (
        <div className="text-xs text-[#cbd5e1]">
          Hasta: {f.motivo_cierre}
          {f.cerrado_por ? ` · ${f.cerrado_por}` : ""}
        </div>
      )}
    </li>
  );
}

export default function ConductorUnidades({
  dni,
  nombre,
  onCerrar,
}: {
  dni: string;
  nombre: string;
  onCerrar: () => void;
}) {
  const [filas, setFilas] = useState<FilaUnidad[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/erp/equipos/conductor/${encodeURIComponent(dni)}`);
        if (!res.ok) throw new Error();
        const body = (await res.json()) as FilaUnidad[];
        if (vigente) setFilas(body);
      } catch {
        if (vigente) setError(true);
      }
    })();
    return () => {
      vigente = false;
    };
  }, [dni]);

  const ahora = (filas ?? []).filter((f) => f.hasta === null);
  const antes = (filas ?? []).filter((f) => f.hasta !== null);
  const titulo = "text-xs font-bold uppercase tracking-wide text-[#94a3b8] mb-2";

  return (
    <VentanaFlotante
      id={`equipo-conductor-${dni}`}
      titulo={nombre}
      subtitulo={`DNI ${dni} · unidades actuales y pasadas`}
      onCerrar={onCerrar}
      anchoInicial={560}
      altoInicial={520}
    >
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6 text-sm">
        {error ? (
          <p className="text-[#fca5a5]">No se pudieron cargar las unidades de este conductor.</p>
        ) : filas === null ? (
          <p className="text-[#94a3b8]">Cargando...</p>
        ) : (
          <>
            <section>
              <h4 className={titulo}>Maneja ahora</h4>
              {ahora.length === 0 ? (
                <p className="text-[#94a3b8]">Ninguna unidad por ahora.</p>
              ) : (
                <ul className="space-y-2">
                  {ahora.map((f) => (
                    <Item key={f.id} f={f} />
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h4 className={titulo}>Antes</h4>
              {antes.length === 0 ? (
                <p className="text-[#94a3b8]">Sin unidades anteriores registradas.</p>
              ) : (
                <ul className="space-y-2">
                  {antes.map((f) => (
                    <Item key={f.id} f={f} />
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
