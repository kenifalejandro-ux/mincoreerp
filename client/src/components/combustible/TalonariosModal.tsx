// Talonarios: el reporte de vales por serie del período. Muestra por serie el rango, cuántos vales
// se usaron, lo despachado, cuántos faltan y el último vale, y al abrir una serie, los tramos que
// faltan con el vale de antes y el de después. Solo mira: dar de baja un tramo es de otra pieza.
//
// El cuadre contra la varilla usa el kardex del tanque (solo admin y operador lo tienen); quien no
// puede leerlo ve el reporte igual, sin ese bloque.
import { Download } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";
import VentanaFlotante from "../comunes/VentanaFlotante";
import { exportarTalonariosExcel } from "./exportarTalonarios";
import {
  calcularCuadre,
  ultimaVarilla,
  type FilaDeKardex,
  type UltimaVarilla,
} from "./talonariosCuadre";
import {
  fechaCorta,
  rangoTexto,
  textoVecinos,
  totalFaltantes,
  valeTexto,
  type SerieTalonario,
} from "./valesFaltantesLogica";

export interface TanqueParaCuadre {
  id: number;
  codigo: string;
  tanque_nombre: string;
  unidad: "gal" | "L";
}

const aDia = (d: Date) => d.toISOString().slice(0, 10);
const num = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 1 });

export default function TalonariosModal({
  tanques,
  puedeCuadre,
  onCerrar,
}: {
  tanques: TanqueParaCuadre[];
  puedeCuadre: boolean;
  onCerrar: () => void;
}) {
  const [desde, setDesde] = useState(() => aDia(new Date(Date.now() - 30 * 24 * 3600 * 1000)));
  const [hasta, setHasta] = useState(() => aDia(new Date()));
  const [series, setSeries] = useState<SerieTalonario[] | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [exportando, setExportando] = useState(false);
  const [tanqueId, setTanqueId] = useState<number | null>(tanques[0]?.id ?? null);
  const [varilla, setVarilla] = useState<UltimaVarilla | null | "error">(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    setVarilla(null);
    try {
      const d = new Date(`${desde}T00:00:00`).toISOString();
      const h = new Date(`${hasta}T23:59:59`).toISOString();
      const periodo = `desde=${encodeURIComponent(d)}&hasta=${encodeURIComponent(h)}`;
      const res = await apiFetch(`/api/erp/combustible/despachos/talonarios?${periodo}`);
      if (!res.ok) {
        setError("No se pudo armar el reporte de talonarios.");
        setSeries(null);
        return;
      }
      setSeries(((await res.json()) as { series: SerieTalonario[] }).series);
      // El cuadre es un extra: si el kardex no sale, el reporte queda como está.
      if (puedeCuadre && tanqueId !== null) {
        try {
          const k = await apiFetch(`/api/erp/combustible/${tanqueId}/kardex?${periodo}`);
          setVarilla(
            k.ok ? ultimaVarilla(((await k.json()) as { filas: FilaDeKardex[] }).filas) : "error"
          );
        } catch {
          setVarilla("error");
        }
      }
    } catch {
      setError("No se pudo armar el reporte de talonarios.");
      setSeries(null);
    } finally {
      setCargando(false);
    }
  }, [desde, hasta, puedeCuadre, tanqueId]);

  useEffect(() => {
    // Solo al abrir y al cambiar de tanque: el período se aplica con «Ver período».
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tanqueId]);

  const tanque = tanques.find((t) => t.id === tanqueId) ?? null;
  const faltan = series ? totalFaltantes(series) : 0;
  const cuadre =
    series && tanque && varilla && varilla !== "error"
      ? calcularCuadre(series, varilla, tanque.unidad)
      : null;

  const exportar = async () => {
    if (!series || exportando) return;
    setExportando(true);
    try {
      await exportarTalonariosExcel(series, `talonarios-${desde}-a-${hasta}.xlsx`);
    } finally {
      setExportando(false);
    }
  };

  return (
    <VentanaFlotante
      id="combustible-talonarios"
      titulo="Talonarios de vales"
      subtitulo="Por serie, en todo el grifo: despachos, excedentes y asignaciones de tanqueta."
      onCerrar={onCerrar}
      anchoInicial={1040}
      altoInicial={640}
    >
      <div className="px-6 py-4 bg-slate-50 border-b flex flex-wrap items-end gap-3 shrink-0">
        <div>
          <label
            htmlFor="talonarios-desde"
            className="block text-xs font-bold text-slate-700 uppercase mb-1"
          >
            Desde
          </label>
          <input
            id="talonarios-desde"
            type="date"
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs sm:text-sm"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
          />
        </div>
        <div>
          <label
            htmlFor="talonarios-hasta"
            className="block text-xs font-bold text-slate-700 uppercase mb-1"
          >
            Hasta
          </label>
          <input
            id="talonarios-hasta"
            type="date"
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs sm:text-sm"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
          />
        </div>
        <button
          onClick={cargar}
          disabled={cargando}
          className="px-4 py-2 bg-slate-900 text-white text-sm font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50"
        >
          {cargando ? "Armando..." : "Ver período"}
        </button>
        <button
          onClick={exportar}
          disabled={exportando || !series || series.length === 0}
          className="flex items-center gap-2 px-4 py-2 border border-slate-300 text-slate-700 text-sm font-medium rounded-lg hover:bg-white disabled:opacity-40"
          title="Planilla con dos hojas: las series y los vales que faltan"
        >
          <Download className="w-4 h-4 shrink-0" />
          {exportando ? "Exportando..." : "Excel (.xlsx)"}
        </button>
        {series && (
          <span
            className={`ml-auto text-sm font-semibold ${faltan > 0 ? "text-red-600" : "text-emerald-700"}`}
          >
            {faltan > 0 ? `Vales que faltan: ${faltan}` : "✔ Vales completos"}
          </span>
        )}
      </div>

      <div className="px-6 py-4 space-y-4 overflow-auto">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!error && series && series.length === 0 && (
          <p className="text-sm text-slate-500">No hay vales de talonario en este período.</p>
        )}
        {series && series.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-slate-500">
                  <th className="py-2 pr-3">Serie</th>
                  <th className="py-2 pr-3">Rango</th>
                  <th className="py-2 pr-3">Usados</th>
                  <th className="py-2 pr-3 text-right">Litros</th>
                  <th className="py-2 pr-3 text-right">Galones</th>
                  <th className="py-2 pr-3">Faltan</th>
                  <th className="py-2 pr-3">Último vale</th>
                  <th className="py-2 pr-3">Fecha</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {series.map((s) => (
                  <FilaSerie
                    key={s.serie}
                    s={s}
                    abierta={abierta === s.serie}
                    onAlternar={() => setAbierta(abierta === s.serie ? null : s.serie)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {puedeCuadre && series && series.length > 0 && tanques.length > 0 && (
          <section className="rounded-lg border border-slate-200 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-slate-700">Cuadre contra el tanque</h3>
              <label className="flex items-center gap-2 text-xs text-slate-500">
                Tanque
                <select
                  className="border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-700"
                  value={tanqueId ?? ""}
                  onChange={(e) => setTanqueId(Number(e.target.value))}
                >
                  {tanques.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.codigo} · {t.tanque_nombre}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {varilla === "error" && (
              <p className="text-sm text-slate-500">No se pudo leer el kardex de este tanque.</p>
            )}
            {varilla === null && !cargando && (
              <p className="text-sm text-slate-500">Este tanque no tiene varillas en el período.</p>
            )}
            {cuadre && varilla && varilla !== "error" && tanque && (
              <>
                <p className="text-xs text-slate-500">
                  Hasta la última varilla ({fechaCorta(varilla.ocurrido_en)}). Cifras en{" "}
                  {tanque.unidad === "gal" ? "galones" : "litros"}.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
                  <Dato
                    titulo="Despachado con vale"
                    valor={num(cuadre.despachado)}
                    nota={`${cuadre.usados} vales · unos ${num(cuadre.promedioPorVale)} por vale`}
                  />
                  <Dato
                    titulo="Vales que faltan"
                    valor={String(cuadre.faltan)}
                    nota={`≈ ${num(cuadre.estimadoFaltantes)} estimados`}
                  />
                  <Dato
                    titulo="Faltante del tanque"
                    valor={num(cuadre.faltanteTanque)}
                    nota={`medido ${num(varilla.medido)} · teórico ${num(varilla.teorico)}`}
                    rojo={cuadre.faltanteTanque > 0}
                  />
                  <Dato
                    titulo="Sin explicar por vales"
                    valor={num(cuadre.sinExplicar)}
                    nota={
                      cuadre.valesSinExplicar !== null && cuadre.sinExplicar > 0
                        ? `equivale a unos ${Math.round(cuadre.valesSinExplicar)} vales más`
                        : "los vales que faltan alcanzan a explicarlo"
                    }
                    rojo={cuadre.sinExplicar > 0}
                  />
                </div>
                <p className="text-xs text-slate-500">
                  Estimado: los vales que faltan se calculan con el promedio por vale; no son datos
                  registrados. Los vales son de todo el grifo y el faltante es de este tanque.
                </p>
              </>
            )}
          </section>
        )}
      </div>
    </VentanaFlotante>
  );
}

function Dato({
  titulo,
  valor,
  nota,
  rojo,
}: {
  titulo: string;
  valor: string;
  nota: string;
  rojo?: boolean;
}) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-xs font-semibold uppercase text-slate-500">{titulo}</div>
      <div className={`text-lg font-bold ${rojo ? "text-red-600" : "text-slate-800"}`}>{valor}</div>
      <div className="text-xs text-slate-500">{nota}</div>
    </div>
  );
}

function FilaSerie({
  s,
  abierta,
  onAlternar,
}: {
  s: SerieTalonario;
  abierta: boolean;
  onAlternar: () => void;
}) {
  return (
    <>
      <tr className="border-t border-slate-100">
        <td className="py-2 pr-3 font-mono font-semibold">{s.serie}</td>
        <td className="py-2 pr-3 font-mono">
          {String(s.minimo).padStart(5, "0")} – {String(s.maximo).padStart(5, "0")}
        </td>
        <td className="py-2 pr-3">
          {s.usados} de {s.usados + s.faltan}
        </td>
        <td className="py-2 pr-3 text-right font-mono">{num(s.litros)}</td>
        <td className="py-2 pr-3 text-right font-mono">{num(s.galones)}</td>
        <td
          className={`py-2 pr-3 font-semibold ${s.faltan > 0 ? "text-red-600" : "text-slate-500"}`}
        >
          {s.faltan}
        </td>
        <td className="py-2 pr-3 font-mono">{valeTexto(s.serie, s.ultimo_vale)}</td>
        <td className="py-2 pr-3">{fechaCorta(s.ultima_fecha)}</td>
        <td className="py-2 text-right">
          {s.faltan > 0 && (
            <button
              onClick={onAlternar}
              aria-expanded={abierta}
              className="text-xs font-semibold text-slate-700 underline hover:text-slate-900"
            >
              {abierta ? "Ocultar tramos" : "Ver tramos"}
            </button>
          )}
        </td>
      </tr>
      {abierta && (
        <tr>
          <td colSpan={9} className="pb-3">
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {s.tramos.map((t) => (
                <li key={t.desde} className="px-3 py-2">
                  <span className="font-mono font-semibold text-slate-800">{rangoTexto(t)}</span>{" "}
                  <span className="text-slate-500">
                    ({t.cantidad === 1 ? "1 vale" : `${t.cantidad} vales`})
                  </span>
                  <p className="text-xs text-slate-500">{textoVecinos(s.serie, t, fechaCorta)}</p>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-slate-500">
              «Registrado por» es quien guardó el vale de al lado. No prueba quién tenía el que
              falta.
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
