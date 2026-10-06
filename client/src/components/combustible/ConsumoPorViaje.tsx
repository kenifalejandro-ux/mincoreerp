// Consumo por viaje (0123): la vista del Histórico de Combustible y de Urea.
// Un solo componente con el producto como parámetro; el detalle del viaje es
// el mismo que abre el panel Viajes.
import { Download, Eye } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  desvio,
  MIN_VIAJES_PARA_COMPARAR,
  fechaHora,
  fmt,
  rendimiento,
  ruta,
  unidadDe,
  unidadLabel,
  type FilaViaje,
  type Producto,
} from "./viajesFormato";
import { apiFetch } from "../../services/apiClient";
import { exportarCsv } from "../../utils/exportarCsv";
import VentanaFlotante from "../comunes/VentanaFlotante";

interface CargaViaje {
  id: string;
  producto: Producto;
  origen: string;
  despachado_en: string;
  cantidad: string;
  unidad: string;
  serie_talonario: string | null;
  n_vale: number | null;
  conductor_nombre: string | null;
  tanque_nombre: string | null;
  grifo: string | null;
}

const UMBRAL_DESVIO_PCT = 20;

export function CeldaDesvio({ v }: { v: FilaViaje }) {
  const d = desvio(v);
  if (!d) return <span className="text-slate-400">—</span>;
  const alto = d.pct > UMBRAL_DESVIO_PCT;
  return (
    <span
      title={`Comparado con ${d.contra}`}
      className={`font-mono ${alto ? "text-red-500 font-bold" : d.pct < 0 ? "text-emerald-500" : ""}`}
    >
      {d.pct > 0 ? "+" : ""}
      {fmt(d.pct, 0)}%
    </span>
  );
}

export function DetalleViajeVentana({
  viajeId,
  onCerrar,
}: {
  viajeId: string;
  onCerrar: () => void;
}) {
  const [datos, setDatos] = useState<{ viaje: FilaViaje; cargas: CargaViaje[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await apiFetch(`/api/erp/combustible/viajes/${viajeId}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) setError(body?.error ?? "No se pudo cargar el viaje.");
      else setDatos(body);
    })();
  }, [viajeId]);

  const v = datos?.viaje;
  const total = (p: Producto) =>
    (datos?.cargas ?? [])
      .filter((c) => c.producto === p)
      .reduce(
        (s, c) =>
          s + Number(c.cantidad) * (p === "combustible" && c.unidad === "L" ? 1 / 3.785411784 : 1),
        0
      );

  return (
    <VentanaFlotante
      id={`combustible-viaje-${viajeId}`}
      titulo={v ? `Viaje V-${v.numero} · ${ruta(v)}` : "Viaje"}
      subtitulo={
        v
          ? `${unidadLabel(v)} · ${v.conductor_nombre ?? "sin conductor"} · ${
              v.inicio_en
                ? `${fechaHora(v.inicio_en)} → ${fechaHora(v.fin_en)}`
                : "programado, aún no sale"
            }`
          : undefined
      }
      onCerrar={onCerrar}
      anchoInicial={720}
      altoInicial={480}
    >
      {error && <p className="p-4 text-sm text-red-400">{error}</p>}
      {datos && (
        <div className="p-3 space-y-3">
          <div className="flex flex-wrap gap-5 text-sm text-[#94a3b8]">
            <span>
              Combustible:{" "}
              <strong className="text-white font-mono">{fmt(total("combustible"))} gal</strong>
            </span>
            <span>
              Urea: <strong className="text-white font-mono">{fmt(total("urea"))} L</strong>
            </span>
            {v?.recorrido && (
              <span>
                Recorrido:{" "}
                <strong className="text-white font-mono">
                  {fmt(Number(v.recorrido), 1)} {v.tipo_medidor === "horometro" ? "h" : "km"}
                </strong>
              </span>
            )}
            {v?.recorrido_sin_viaje != null && (
              <span title="Lo que anduvo la unidad desde su última lectura hasta que salió">
                Fuera de viaje:{" "}
                <strong className="text-white font-mono">
                  {fmt(Number(v.recorrido_sin_viaje), 1)}{" "}
                  {v.tipo_medidor === "horometro" ? "h" : "km"}
                </strong>
              </span>
            )}
            {v?.ruta_por_confirmar && (
              <span className="text-amber-400">
                Ruta por confirmar{v.nota_ruta ? `: ${v.nota_ruta}` : ""}
              </span>
            )}
            {v?.estado === "anulado" && (
              <span className="text-red-400">Anulado: {v.motivo_anulacion}</span>
            )}
          </div>
          {datos.cargas.length === 0 ? (
            <p className="text-sm text-[#94a3b8]">
              Sin cargas de esta unidad entre la salida (con su margen previo) y la llegada.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase text-[#94a3b8]">
                  <th className="p-2">Fecha</th>
                  <th className="p-2">Producto</th>
                  <th className="p-2">De dónde</th>
                  <th className="p-2">Vale</th>
                  <th className="p-2 text-right">Cantidad</th>
                </tr>
              </thead>
              <tbody>
                {datos.cargas.map((c) => (
                  <tr key={c.id} className="border-t border-[#2a2e37]">
                    <td className="p-2 whitespace-nowrap">{fechaHora(c.despachado_en)}</td>
                    <td className="p-2">{c.producto === "urea" ? "Urea" : "Combustible"}</td>
                    <td className="p-2">
                      {c.grifo ??
                        c.tanque_nombre ??
                        (c.origen === "tanqueta" ? "Tanqueta" : c.origen)}
                    </td>
                    <td className="p-2 font-mono">
                      {c.serie_talonario ? `${c.serie_talonario}-${c.n_vale}` : "—"}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {fmt(Number(c.cantidad))} {c.unidad}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </VentanaFlotante>
  );
}

type Agrupacion = "viaje" | "unidad" | "conductor";

interface FilaRanking {
  clave: string;
  ruta: string;
  quien: string;
  viajes: number;
  total: number;
  promedio: number;
}

/** Histórico › Por viaje. `desde`/`hasta` llegan del filtro de período del
 *  Histórico que la contiene (ISO o vacío). */
export default function ConsumoPorViaje({
  producto,
  desde,
  hasta,
  recargar,
  puedeExportar = true,
}: {
  producto: Producto;
  desde: string;
  hasta: string;
  recargar: number;
  puedeExportar?: boolean;
}) {
  const [filas, setFilas] = useState<FilaViaje[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [agrupar, setAgrupar] = useState<Agrupacion>("viaje");
  const [verId, setVerId] = useState<string | null>(null);
  const u = unidadDe(producto);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const q = new URLSearchParams({ producto });
      if (desde) q.set("desde", desde);
      if (hasta) q.set("hasta", hasta);
      const res = await apiFetch(`/api/erp/combustible/viajes/consumo?${q}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? body?.message ?? "No se pudo cargar el consumo por viaje.");
        return;
      }
      setError(null);
      setFilas(Array.isArray(body?.data) ? body.data : []);
    } finally {
      setCargando(false);
    }
  }, [producto, desde, hasta]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar, recargar]);

  const ranking = useMemo<FilaRanking[]>(() => {
    if (agrupar === "viaje") return [];
    const m = new Map<string, FilaRanking>();
    for (const v of filas) {
      if (v.estado !== "cerrado" || v.ruta_por_confirmar) continue;
      const quien = agrupar === "unidad" ? unidadLabel(v) : (v.conductor_nombre ?? "Sin conductor");
      const clave = `${v.origen_id}-${v.destino_id}-${quien}`;
      const f = m.get(clave) ?? { clave, ruta: ruta(v), quien, viajes: 0, total: 0, promedio: 0 };
      f.viajes += Number(v.cuenta_como);
      f.total += Number(v.cantidad);
      m.set(clave, f);
    }
    return [...m.values()]
      .map((f) => ({ ...f, promedio: f.viajes ? f.total / f.viajes : 0 }))
      .sort((a, b) => a.ruta.localeCompare(b.ruta) || b.promedio - a.promedio);
  }, [filas, agrupar]);

  const exportar = () => {
    const datos =
      agrupar === "viaje"
        ? filas.map((v) => ({
            viaje: `V-${v.numero}`,
            ruta: ruta(v),
            unidad: unidadLabel(v),
            conductor: v.conductor_nombre ?? "",
            salida: fechaHora(v.inicio_en),
            llegada: fechaHora(v.fin_en),
            estado: v.estado,
            cuenta_como: Number(v.cuenta_como),
            cargas: Number(v.cargas),
            [`cantidad_${u}`]: Number(Number(v.cantidad).toFixed(2)),
            rendimiento: rendimiento(v, producto),
            desvio_pct: desvio(v) ? Math.round(desvio(v)!.pct) : "",
          }))
        : ranking.map((f) => ({
            ruta: f.ruta,
            [agrupar]: f.quien,
            viajes: f.viajes,
            [`total_${u}`]: Number(f.total.toFixed(2)),
            [`promedio_${u}_por_viaje`]: Number(f.promedio.toFixed(2)),
          }));
    exportarCsv(datos, `Consumo por viaje ${producto} ${desde.slice(0, 10) || "todo"}.csv`);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-500" htmlFor={`viaje-agrupar-${producto}`}>
          Ver
        </label>
        <select
          id={`viaje-agrupar-${producto}`}
          value={agrupar}
          onChange={(e) => setAgrupar(e.target.value as Agrupacion)}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        >
          <option value="viaje">Cada viaje</option>
          <option value="unidad">Ranking por ruta y unidad</option>
          <option value="conductor">Ranking por ruta y conductor</option>
        </select>
        {puedeExportar && (
          <button
            onClick={exportar}
            disabled={filas.length === 0}
            className="flex items-center gap-2 border border-slate-200 text-slate-600 px-3 py-1.5 rounded-xl text-sm hover:bg-slate-50 disabled:opacity-40"
          >
            <Download className="w-4 h-4" /> Exportar
          </button>
        )}
        {cargando && <span className="text-sm text-slate-500">Cargando...</span>}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && filas.length === 0 && !cargando && (
        <p className="text-sm text-slate-500">
          No hay viajes en el período. Los viajes se registran en Combustible › Viajes.
        </p>
      )}

      {agrupar === "viaje" && filas.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-slate-700">
            <thead>
              <tr className="text-left text-[11px] uppercase text-slate-500">
                <th className="p-2">Viaje</th>
                <th className="p-2">Ruta</th>
                <th className="p-2">Unidad</th>
                <th className="p-2">Conductor</th>
                <th className="p-2">Salida</th>
                <th className="p-2 text-right">Cargas</th>
                <th className="p-2 text-right">Total ({u})</th>
                <th className="p-2 text-right">Rendimiento</th>
                <th
                  className="p-2 text-right"
                  title={`Contra el promedio de la ruta (desde ${MIN_VIAJES_PARA_COMPARAR} viajes cerrados). Más de +${UMBRAL_DESVIO_PCT}% se marca en rojo`}
                >
                  vs. ruta
                </th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {filas.map((v) => (
                <tr key={v.id} className="border-t border-slate-100">
                  <td className="p-2 font-mono whitespace-nowrap">
                    V-{v.numero}
                    {v.estado === "en_curso" && (
                      <span className="ml-2 text-[10px] uppercase text-amber-600">en curso</span>
                    )}
                  </td>
                  <td className="p-2">{ruta(v)}</td>
                  <td className="p-2">{unidadLabel(v)}</td>
                  <td className="p-2">{v.conductor_nombre ?? "—"}</td>
                  <td className="p-2 whitespace-nowrap">{fechaHora(v.inicio_en)}</td>
                  <td className="p-2 text-right font-mono">{v.cargas}</td>
                  <td className="p-2 text-right font-mono">{fmt(Number(v.cantidad))}</td>
                  <td className="p-2 text-right font-mono">{rendimiento(v, producto)}</td>
                  <td className="p-2 text-right">
                    <CeldaDesvio v={v} />
                  </td>
                  <td className="p-2 text-right">
                    <button
                      onClick={() => setVerId(v.id)}
                      aria-label={`Ver viaje V-${v.numero}`}
                      title="Ver cargas del viaje"
                      className="p-1.5 rounded border border-slate-200 text-slate-500 hover:text-slate-900"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {agrupar !== "viaje" && ranking.length > 0 && (
        <table className="w-full text-sm text-slate-700">
          <thead>
            <tr className="text-left text-[11px] uppercase text-slate-500">
              <th className="p-2">Ruta</th>
              <th className="p-2">{agrupar === "unidad" ? "Unidad" : "Conductor"}</th>
              <th className="p-2 text-right">Viajes</th>
              <th className="p-2 text-right">Total ({u})</th>
              <th className="p-2 text-right">Promedio por viaje ({u})</th>
            </tr>
          </thead>
          <tbody>
            {ranking.map((f) => (
              <tr key={f.clave} className="border-t border-slate-100">
                <td className="p-2">{f.ruta}</td>
                <td className="p-2">{f.quien}</td>
                <td className="p-2 text-right font-mono">{fmt(f.viajes)}</td>
                <td className="p-2 text-right font-mono">{fmt(f.total)}</td>
                <td className="p-2 text-right font-mono font-bold">{fmt(f.promedio)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {verId && <DetalleViajeVentana viajeId={verId} onCerrar={() => setVerId(null)} />}
    </div>
  );
}
