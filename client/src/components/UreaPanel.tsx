// client/src/components/UreaPanel.tsx
//
// La pestaña "Urea" dentro de Combustible (migración 0092, decisión de
// Kenif 2026-09-10: pestaña propia, mismas tablas de combustible_despachos
// -- no un módulo nuevo). CombustiblePanel la monta cuando
// pestanaCombustible === "urea", mismo patrón que HistoricoCliente.tsx.
//
// Tres acciones (los tres actos que confirmó el cliente):
//   - Registrar VALE: la urea sale a una unidad (POST /despachos,
//     producto='urea'). El servidor resuelve el factor de conversión --
//     este formulario solo manda presentación + bultos.
//   - Registrar ENTRADA: llega la compra del proveedor (POST /recepciones,
//     producto='urea'). Sin tanque, sin varilla previa que exigir.
//   - Registrar CONTEO FÍSICO: el reemplazo de la varilla -- lo que queda
//     en almacén, contado a mano (POST /urea/conteos).
//
// El banner de arriba avisa si hace mucho que nadie hace el conteo
// (GET /urea/estado) -- mismo criterio que "el tanque opera ciego" de
// combustible (migración 0082), pero para la urea.
//
// Define sus propios tipos locales, no los importa de CombustiblePanel --
// mismo criterio que HistoricoCliente: este componente no debe depender de
// las ~7000 líneas de al lado.

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../services/apiClient";

const PRESENTACIONES = [
  { valor: "bolsa", etiqueta: "Bolsa (4 L)" },
  { valor: "caja", etiqueta: "Caja (16 L = 4 bolsas)" },
  { valor: "balde", etiqueta: "Balde (20 L)" },
] as const;
type Presentacion = (typeof PRESENTACIONES)[number]["valor"];

type Vista = "vales" | "entradas" | "conteos" | "por_conductor" | "por_vehiculo";

const VISTAS: { valor: Vista; etiqueta: string }[] = [
  { valor: "vales", etiqueta: "Vales (salidas a unidades)" },
  { valor: "entradas", etiqueta: "Entradas (compras)" },
  { valor: "conteos", etiqueta: "Conteos físicos de almacén" },
  { valor: "por_conductor", etiqueta: "Ranking de consumo por conductor" },
  { valor: "por_vehiculo", etiqueta: "Ranking de consumo por vehículo" },
];

/** Todas las vistas menos "Conteos" aceptan filtrar por fecha (los mismos
 *  endpoints que ya usa Histórico de combustible, con ?producto=urea) --
 *  sin fechas, cargan el período completo. "Conteos" queda afuera porque
 *  `GET /urea/conteos` todavía no acepta un rango. */
const VISTAS_SIN_PERIODO: ReadonlySet<Vista> = new Set(["conteos"]);

interface Equipo {
  id: number;
  placa_codigo: string;
  tipo: string;
  usa_urea: boolean;
}

interface Grifo {
  id: number;
  nombre: string;
  activo: boolean;
  abastece_urea: boolean;
}

interface ValeFila {
  id: number;
  serie_talonario: string;
  n_vale: number;
  equipo_id: number | null;
  presentacion: Presentacion;
  cantidad_bultos: string;
  cantidad: string;
  costo_total: string;
  conductor_nombre: string | null;
  observaciones: string | null;
  despachado_en: string;
  anulada_en: string | null;
}

interface EntradaFila {
  id: number;
  grifo_nombre: string;
  presentacion: Presentacion;
  cantidad_bultos: string;
  cantidad: string;
  costo_total: string;
  tipo_documento: string | null;
  numero_documento: string | null;
  recibido_en: string;
  anulada_en: string | null;
}

interface ConteoFila {
  id: number;
  cantidad_litros: string;
  contado_en: string;
  registrado_por_nombre: string | null;
  observaciones: string | null;
  anulada_en: string | null;
  motivo_anulacion: string | null;
}

interface ConductorFila {
  conductor_nombre: string;
  conductor_dni: string | null;
  cantidad_vales: string;
  total_cantidad: string;
  total_costo: string;
  primer_despacho: string;
  ultimo_despacho: string;
}

interface VehiculoFila {
  equipo_id: number;
  placa_codigo: string | null;
  equipo_tipo: string | null;
  cantidad_vales: string;
  total_cantidad: string;
  total_costo: string;
  primer_despacho: string;
  ultimo_despacho: string;
}

interface EstadoUrea {
  sinConteo: { diasSinConteo: number | null; limiteDias: number } | null;
}

function ahoraParaInputLocal(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function formatearFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatearNumero(valor: string, decimales = 1): string {
  const n = Number(valor);
  return Number.isFinite(n)
    ? n.toLocaleString("es-PE", { maximumFractionDigits: decimales })
    : valor;
}

/** Exporta la vista actual a CSV -- mismo mecanismo que HistoricoCliente.tsx
 *  y CombustiblePanel.tsx, duplicado y no importado (no se comparte código
 *  entre hermanos, ver el comentario de VentanaFlotante). NO hay
 *  "Importar Excel" para urea, a diferencia de la carga masiva de tanques:
 *  un vale/entrada/conteo necesita validación del servidor fila por fila
 *  (talonario, factor de conversión, rol del grifo) que un bulk insert no
 *  puede replicar sin reescribir esa lógica del lado del cliente -- mismo
 *  motivo por el que combustible tampoco tiene "importar despachos". */
function exportarCsvUrea(filas: Record<string, unknown>[], nombreArchivo: string) {
  if (filas.length === 0) return;
  const columnas = Object.keys(filas[0]);
  const escapar = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [
    columnas.join(","),
    ...filas.map((f) => columnas.map((c) => escapar(f[c])).join(",")),
  ];
  const blob = new Blob([lineas.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombreArchivo;
  a.click();
  URL.revokeObjectURL(url);
}

export default function UreaPanel() {
  const [vista, setVista] = useState<Vista>("vales");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [grifos, setGrifos] = useState<Grifo[]>([]);
  const [estado, setEstado] = useState<EstadoUrea | null>(null);

  const [vales, setVales] = useState<ValeFila[]>([]);
  const [entradas, setEntradas] = useState<EntradaFila[]>([]);
  const [conteos, setConteos] = useState<ConteoFila[]>([]);
  const [porConductor, setPorConductor] = useState<ConductorFila[]>([]);
  const [porVehiculo, setPorVehiculo] = useState<VehiculoFila[]>([]);

  const [modalVale, setModalVale] = useState(false);
  const [modalEntrada, setModalEntrada] = useState(false);
  const [modalConteo, setModalConteo] = useState(false);

  const cargarEquipos = useCallback(async () => {
    const res = await apiFetch("/api/erp/equipos?pageSize=200");
    const body = await res.json().catch(() => null);
    setEquipos(Array.isArray(body?.data) ? body.data : []);
  }, []);

  // Solo los grifos marcados abastece_urea -- el proveedor "aparte" que
  // confirmó el cliente (pregunta 9). El servidor igual lo vuelve a
  // validar (validarRolGrifo, rol "urea"): esto es comodidad de UI, no el
  // control real.
  const cargarGrifos = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible/grifos");
    const data = await res.json().catch(() => null);
    setGrifos(Array.isArray(data) ? data.filter((g: Grifo) => g.abastece_urea && g.activo) : []);
  }, []);

  const cargarEstado = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible/urea/estado");
    const body = await res.json().catch(() => null);
    setEstado(body ?? null);
  }, []);

  /** Arma el query string con el período, mismo criterio que
   *  HistoricoCliente.tsx: sin fecha puesta, no manda el parámetro (el
   *  backend interpreta "todo el rango"). */
  const paramsDePeriodo = useCallback(
    (extra: Record<string, string>) => {
      const params = new URLSearchParams(extra);
      if (desde) params.set("desde", new Date(`${desde}T00:00:00`).toISOString());
      if (hasta) params.set("hasta", new Date(`${hasta}T23:59:59.999`).toISOString());
      return params;
    },
    [desde, hasta]
  );

  const cargarVista = useCallback(
    async (v: Vista) => {
      setCargando(true);
      setError(null);
      try {
        if (v === "vales") {
          const q = paramsDePeriodo({ producto: "urea", pageSize: "200" });
          const res = await apiFetch(`/api/erp/combustible/despachos?${q}`);
          const body = await res.json().catch(() => null);
          setVales(Array.isArray(body?.data) ? body.data : []);
        } else if (v === "entradas") {
          const q = paramsDePeriodo({ producto: "urea", pageSize: "200" });
          const res = await apiFetch(`/api/erp/combustible/recepciones?${q}`);
          const body = await res.json().catch(() => null);
          setEntradas(Array.isArray(body?.data) ? body.data : []);
        } else if (v === "por_conductor") {
          const q = paramsDePeriodo({ producto: "urea" });
          const res = await apiFetch(`/api/erp/combustible/consumo-por-conductor?${q}`);
          const body = await res.json().catch(() => null);
          setPorConductor(Array.isArray(body?.data) ? body.data : []);
        } else if (v === "por_vehiculo") {
          const q = paramsDePeriodo({ producto: "urea" });
          const res = await apiFetch(`/api/erp/combustible/consumo-por-vehiculo?${q}`);
          const body = await res.json().catch(() => null);
          setPorVehiculo(Array.isArray(body?.data) ? body.data : []);
        } else {
          const res = await apiFetch("/api/erp/combustible/urea/conteos?pageSize=200");
          const body = await res.json().catch(() => null);
          setConteos(Array.isArray(body?.data) ? body.data : []);
        }
      } catch {
        setError("No se pudo cargar la información.");
      } finally {
        setCargando(false);
      }
    },
    [paramsDePeriodo]
  );

  useEffect(() => {
    // Patrón estándar de carga al montar -- ver IpercView.tsx /
    // CombustiblePanel.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarEquipos();
    cargarGrifos();
    cargarEstado();
  }, [cargarEquipos, cargarGrifos, cargarEstado]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarVista(vista);
    // Solo al cambiar de VISTA, no en cada tecla de las fechas -- esas se
    // aplican con el botón "Consultar" (mismo criterio que
    // HistoricoCliente.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vista]);

  const recargarTodo = useCallback(() => {
    cargarVista(vista);
    cargarEstado();
  }, [vista, cargarVista, cargarEstado]);

  return (
    <div className="flex flex-col gap-4">
      {estado?.sinConteo && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {estado.sinConteo.diasSinConteo === null ? (
            <>
              <strong>Todavía no se hizo ningún conteo físico de urea.</strong> Es el reemplazo de
              la varilla del tanque: sin él, el stock de urea nunca se puede contrastar contra la
              realidad del almacén.
            </>
          ) : (
            <>
              <strong>Hace {estado.sinConteo.diasSinConteo} días</strong> que nadie cuenta la urea
              en almacén (el límite configurado es {estado.sinConteo.limiteDias} días).
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setModalVale(true)}
          className="px-4 py-2 bg-[#0A1014] text-white font-semibold rounded-xl hover:opacity-90 transition-all text-sm"
        >
          🧴 Registrar vale
        </button>
        <button
          type="button"
          onClick={() => setModalEntrada(true)}
          className="px-4 py-2 border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium rounded-xl transition-all text-sm"
        >
          📦 Registrar entrada
        </button>
        <button
          type="button"
          onClick={() => setModalConteo(true)}
          className="px-4 py-2 border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium rounded-xl transition-all text-sm"
        >
          🧮 Registrar conteo físico
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-4">
          <label className="flex flex-col text-sm">
            <span className="text-gray-600">Vista</span>
            <select
              value={vista}
              onChange={(e) => setVista(e.target.value as Vista)}
              className="rounded border border-gray-300 px-2 py-1"
            >
              {VISTAS.map((v) => (
                <option key={v.valor} value={v.valor}>
                  {v.etiqueta}
                </option>
              ))}
            </select>
          </label>
          {!VISTAS_SIN_PERIODO.has(vista) && (
            <>
              <label className="flex flex-col text-sm">
                <span className="text-gray-600">Desde</span>
                <input
                  type="date"
                  value={desde}
                  onChange={(e) => setDesde(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1"
                />
              </label>
              <label className="flex flex-col text-sm">
                <span className="text-gray-600">Hasta</span>
                <input
                  type="date"
                  value={hasta}
                  onChange={(e) => setHasta(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1"
                />
              </label>
              <button
                type="button"
                onClick={() => cargarVista(vista)}
                disabled={cargando}
                className="px-4 py-2 bg-slate-900 text-white text-sm font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50"
              >
                {cargando ? "Cargando…" : "Consultar"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() =>
              exportarCsvUrea(
                (vista === "vales"
                  ? vales
                  : vista === "entradas"
                    ? entradas
                    : vista === "por_conductor"
                      ? porConductor
                      : vista === "por_vehiculo"
                        ? porVehiculo
                        : conteos) as unknown as Record<string, unknown>[],
                `urea-${vista}-${new Date().toISOString().slice(0, 10)}.csv`
              )
            }
            disabled={
              (vista === "vales" && vales.length === 0) ||
              (vista === "entradas" && entradas.length === 0) ||
              (vista === "conteos" && conteos.length === 0) ||
              (vista === "por_conductor" && porConductor.length === 0) ||
              (vista === "por_vehiculo" && porVehiculo.length === 0)
            }
            className="ml-auto px-4 py-2 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            title="Exportar la vista actual a CSV"
          >
            ⬇️ Exportar
          </button>
        </div>

        {error && <div className="p-4 text-sm text-red-600">{error}</div>}
        {cargando && <div className="p-4 text-sm text-slate-500">Cargando…</div>}

        {!cargando && vista === "vales" && (
          <TablaVales filas={vales} equipos={equipos} onAnulado={recargarTodo} />
        )}
        {!cargando && vista === "entradas" && <TablaEntradas filas={entradas} />}
        {!cargando && vista === "conteos" && (
          <TablaConteos filas={conteos} onAnulado={recargarTodo} />
        )}
        {!cargando && vista === "por_conductor" && <TablaPorConductor filas={porConductor} />}
        {!cargando && vista === "por_vehiculo" && <TablaPorVehiculo filas={porVehiculo} />}
      </div>

      {modalVale && (
        <ModalVale
          equipos={equipos}
          grifos={grifos}
          onCerrar={() => setModalVale(false)}
          onCreado={() => {
            setModalVale(false);
            setVista("vales");
            recargarTodo();
          }}
        />
      )}
      {modalEntrada && (
        <ModalEntrada
          grifos={grifos}
          onCerrar={() => setModalEntrada(false)}
          onCreado={() => {
            setModalEntrada(false);
            setVista("entradas");
            recargarTodo();
          }}
        />
      )}
      {modalConteo && (
        <ModalConteo
          onCerrar={() => setModalConteo(false)}
          onCreado={() => {
            setModalConteo(false);
            setVista("conteos");
            recargarTodo();
          }}
        />
      )}
    </div>
  );
}

// ── Tablas ──────────────────────────────────────────────────────────────

function TablaVales({
  filas,
  equipos,
  onAnulado,
}: {
  filas: ValeFila[];
  equipos: Equipo[];
  onAnulado: () => void;
}) {
  const [anulando, setAnulando] = useState<ValeFila | null>(null);
  if (filas.length === 0) {
    return <div className="p-6 text-sm text-slate-500">Todavía no hay vales de urea cargados.</div>;
  }
  const placaDe = (equipoId: number | null) =>
    equipos.find((e) => e.id === equipoId)?.placa_codigo ?? "—";
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-2">Vale</th>
            <th className="text-left px-4 py-2">Fecha</th>
            <th className="text-left px-4 py-2">Unidad</th>
            <th className="text-left px-4 py-2">Presentación</th>
            <th className="text-right px-4 py-2">Litros</th>
            <th className="text-right px-4 py-2">Costo</th>
            <th className="text-left px-4 py-2">Conductor</th>
            <th className="text-left px-4 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas.map((f) => (
            <tr key={f.id} className={f.anulada_en ? "opacity-50" : ""}>
              <td className="px-4 py-2 font-mono text-xs">
                {f.serie_talonario}-{String(f.n_vale).padStart(5, "0")}
              </td>
              <td className="px-4 py-2">{formatearFecha(f.despachado_en)}</td>
              <td className="px-4 py-2">{placaDe(f.equipo_id)}</td>
              <td className="px-4 py-2">
                {formatearNumero(f.cantidad_bultos, 0)}×{" "}
                {PRESENTACIONES.find((p) => p.valor === f.presentacion)?.etiqueta ?? f.presentacion}
              </td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.cantidad)} L</td>
              <td className="px-4 py-2 text-right">S/ {formatearNumero(f.costo_total, 2)}</td>
              <td className="px-4 py-2">{f.conductor_nombre ?? "—"}</td>
              <td className="px-4 py-2">
                {f.anulada_en ? (
                  <span className="text-xs text-red-500">anulado</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAnulando(f)}
                    className="text-xs text-slate-400 hover:text-red-600"
                  >
                    Anular
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {anulando && (
        <ModalAnular
          titulo={`Anular el vale ${anulando.serie_talonario}-${anulando.n_vale}`}
          onCerrar={() => setAnulando(null)}
          onConfirmar={async (motivo) => {
            await apiFetch(`/api/erp/combustible/despachos/${anulando.id}/anular`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ motivo }),
            });
            setAnulando(null);
            onAnulado();
          }}
        />
      )}
    </div>
  );
}

function TablaEntradas({ filas }: { filas: EntradaFila[] }) {
  if (filas.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500">Todavía no hay entradas de urea cargadas.</div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-2">Fecha</th>
            <th className="text-left px-4 py-2">Proveedor</th>
            <th className="text-left px-4 py-2">Presentación</th>
            <th className="text-right px-4 py-2">Litros</th>
            <th className="text-right px-4 py-2">Costo</th>
            <th className="text-left px-4 py-2">Documento</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas.map((f) => (
            <tr key={f.id} className={f.anulada_en ? "opacity-50" : ""}>
              <td className="px-4 py-2">{formatearFecha(f.recibido_en)}</td>
              <td className="px-4 py-2">{f.grifo_nombre}</td>
              <td className="px-4 py-2">
                {formatearNumero(f.cantidad_bultos, 0)}×{" "}
                {PRESENTACIONES.find((p) => p.valor === f.presentacion)?.etiqueta ?? f.presentacion}
              </td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.cantidad)} L</td>
              <td className="px-4 py-2 text-right">S/ {formatearNumero(f.costo_total, 2)}</td>
              <td className="px-4 py-2">
                {f.tipo_documento ? `${f.tipo_documento} ${f.numero_documento ?? ""}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Los dos rankings -- mismo endpoint que Histórico de combustible
 *  (GET /consumo-por-conductor, GET /consumo-por-vehiculo), filtrado con
 *  ?producto=urea. Sin paginar, mismo criterio que el original: es un
 *  ranking chico (un conductor/equipo por fila), no un listado que crezca
 *  sin límite. */
function TablaPorConductor({ filas }: { filas: ConductorFila[] }) {
  if (filas.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500">
        Sin vales de urea con conductor en el período elegido.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-2">Conductor</th>
            <th className="text-left px-4 py-2">DNI</th>
            <th className="text-right px-4 py-2">Vales</th>
            <th className="text-right px-4 py-2">Litros</th>
            <th className="text-right px-4 py-2">Costo</th>
            <th className="text-left px-4 py-2">Primer vale</th>
            <th className="text-left px-4 py-2">Último vale</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas.map((f, i) => (
            <tr key={i}>
              <td className="px-4 py-2">{f.conductor_nombre}</td>
              <td className="px-4 py-2">{f.conductor_dni ?? "—"}</td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.cantidad_vales, 0)}</td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.total_cantidad)} L</td>
              <td className="px-4 py-2 text-right">S/ {formatearNumero(f.total_costo, 2)}</td>
              <td className="px-4 py-2">{formatearFecha(f.primer_despacho)}</td>
              <td className="px-4 py-2">{formatearFecha(f.ultimo_despacho)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TablaPorVehiculo({ filas }: { filas: VehiculoFila[] }) {
  if (filas.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500">Sin vales de urea en el período elegido.</div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-2">Unidad</th>
            <th className="text-left px-4 py-2">Tipo</th>
            <th className="text-right px-4 py-2">Vales</th>
            <th className="text-right px-4 py-2">Litros</th>
            <th className="text-right px-4 py-2">Costo</th>
            <th className="text-left px-4 py-2">Primer vale</th>
            <th className="text-left px-4 py-2">Último vale</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas.map((f) => (
            <tr key={f.equipo_id}>
              <td className="px-4 py-2">{f.placa_codigo ?? "—"}</td>
              <td className="px-4 py-2">{f.equipo_tipo ?? "—"}</td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.cantidad_vales, 0)}</td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.total_cantidad)} L</td>
              <td className="px-4 py-2 text-right">S/ {formatearNumero(f.total_costo, 2)}</td>
              <td className="px-4 py-2">{formatearFecha(f.primer_despacho)}</td>
              <td className="px-4 py-2">{formatearFecha(f.ultimo_despacho)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TablaConteos({ filas, onAnulado }: { filas: ConteoFila[]; onAnulado: () => void }) {
  const [anulando, setAnulando] = useState<ConteoFila | null>(null);
  if (filas.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500">Todavía no se registró ningún conteo físico.</div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-2">Fecha</th>
            <th className="text-right px-4 py-2">Litros contados</th>
            <th className="text-left px-4 py-2">Registrado por</th>
            <th className="text-left px-4 py-2">Observaciones</th>
            <th className="text-left px-4 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas.map((f) => (
            <tr key={f.id} className={f.anulada_en ? "opacity-50" : ""}>
              <td className="px-4 py-2">{formatearFecha(f.contado_en)}</td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.cantidad_litros)} L</td>
              <td className="px-4 py-2">{f.registrado_por_nombre ?? "—"}</td>
              <td className="px-4 py-2">{f.observaciones ?? "—"}</td>
              <td className="px-4 py-2">
                {f.anulada_en ? (
                  <span className="text-xs text-red-500" title={f.motivo_anulacion ?? ""}>
                    anulado
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAnulando(f)}
                    className="text-xs text-slate-400 hover:text-red-600"
                  >
                    Anular
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {anulando && (
        <ModalAnular
          titulo="Anular este conteo"
          onCerrar={() => setAnulando(null)}
          onConfirmar={async (motivo) => {
            await apiFetch(`/api/erp/combustible/urea/conteos/${anulando.id}/anular`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ motivo }),
            });
            setAnulando(null);
            onAnulado();
          }}
        />
      )}
    </div>
  );
}

// ── Modales (formularios -- backdrop, a diferencia de las ventanas
// flotantes de consulta: acá hay algo a medio cargar que se puede perder) ──

function Backdrop({ children, onCerrar }: { children: React.ReactNode; onCerrar: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onCerrar}
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function ModalAnular({
  titulo,
  onCerrar,
  onConfirmar,
}: {
  titulo: string;
  onCerrar: () => void;
  onConfirmar: (motivo: string) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">{titulo}</h3>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Motivo (obligatorio)</span>
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            className="rounded border border-gray-300 px-3 py-2"
            placeholder="Ej: se contó dos veces la misma caja"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!motivo.trim() || enviando}
            onClick={async () => {
              setEnviando(true);
              try {
                await onConfirmar(motivo.trim());
              } finally {
                setEnviando(false);
              }
            }}
            className="px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50"
          >
            {enviando ? "Anulando…" : "Confirmar anulación"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function ModalVale({
  equipos,
  grifos,
  onCerrar,
  onCreado,
}: {
  equipos: Equipo[];
  grifos: Grifo[];
  onCerrar: () => void;
  onCreado: () => void;
}) {
  const [clienteUuid] = useState(() => crypto.randomUUID());
  const [serie, setSerie] = useState("");
  const [nVale, setNVale] = useState("");
  const [equipoId, setEquipoId] = useState("");
  const [grifoId, setGrifoId] = useState("");
  const [presentacion, setPresentacion] = useState<Presentacion>("bolsa");
  const [cantidadBultos, setCantidadBultos] = useState("");
  const [despachadoEn, setDespachadoEn] = useState(ahoraParaInputLocal());
  const [observaciones, setObservaciones] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const equipoElegido = equipos.find((e) => String(e.id) === equipoId);

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/despachos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuid,
          producto: "urea",
          origen: "compra_externa",
          grifo_id: Number(grifoId),
          tipo_destino: "equipo",
          equipo_id: Number(equipoId),
          serie_talonario: serie.trim(),
          n_vale: Number(nVale),
          presentacion,
          cantidad_bultos: Number(cantidadBultos),
          despachado_en: new Date(despachadoEn).toISOString(),
          observaciones: observaciones.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo registrar el vale.");
        return;
      }
      onCreado();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">Registrar vale de urea</h3>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Serie del talonario</span>
            <input
              value={serie}
              onChange={(e) => setSerie(e.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
              placeholder="UREA-2026-01"
            />
          </label>
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">N° de vale</span>
            <input
              type="number"
              value={nVale}
              onChange={(e) => setNVale(e.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>
        </div>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Unidad</span>
          <select
            value={equipoId}
            onChange={(e) => setEquipoId(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          >
            <option value="">Elegir unidad…</option>
            {equipos.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.placa_codigo} ({eq.tipo}){eq.usa_urea ? "" : " -- NO usa urea"}
              </option>
            ))}
          </select>
          {equipoElegido && !equipoElegido.usa_urea && (
            <span className="text-xs text-amber-600">
              Esta unidad está marcada como que no usa urea. Igual se puede registrar, pero va a
              quedar como alerta para revisión.
            </span>
          )}
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Proveedor</span>
          <select
            value={grifoId}
            onChange={(e) => setGrifoId(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          >
            <option value="">Elegir proveedor…</option>
            {grifos.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nombre}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Presentación</span>
            <select
              value={presentacion}
              onChange={(e) => setPresentacion(e.target.value as Presentacion)}
              className="rounded border border-gray-300 px-3 py-2"
            >
              {PRESENTACIONES.map((p) => (
                <option key={p.valor} value={p.valor}>
                  {p.etiqueta}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Cantidad</span>
            <input
              type="number"
              min={1}
              value={cantidadBultos}
              onChange={(e) => setCantidadBultos(e.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>
        </div>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Fecha y hora del vale</span>
          <input
            type="datetime-local"
            value={despachadoEn}
            onChange={(e) => setDespachadoEn(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Observaciones</span>
          <input
            value={observaciones}
            onChange={(e) => setObservaciones(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={
              !serie.trim() || !nVale || !equipoId || !grifoId || !cantidadBultos || enviando
            }
            onClick={enviar}
            className="px-4 py-2 bg-[#0A1014] text-white rounded-xl text-sm font-semibold disabled:opacity-50"
          >
            {enviando ? "Guardando…" : "Registrar vale"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function ModalEntrada({
  grifos,
  onCerrar,
  onCreado,
}: {
  grifos: Grifo[];
  onCerrar: () => void;
  onCreado: () => void;
}) {
  const [clienteUuid] = useState(() => crypto.randomUUID());
  const [grifoId, setGrifoId] = useState("");
  const [presentacion, setPresentacion] = useState<Presentacion>("caja");
  const [cantidadBultos, setCantidadBultos] = useState("");
  const [costoUnitario, setCostoUnitario] = useState("");
  const [tipoDocumento, setTipoDocumento] = useState<"" | "factura" | "guia_remision">("");
  const [numeroDocumento, setNumeroDocumento] = useState("");
  const [recibidoEn, setRecibidoEn] = useState(ahoraParaInputLocal());
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/recepciones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuid,
          producto: "urea",
          grifo_id: Number(grifoId),
          presentacion,
          cantidad_bultos: Number(cantidadBultos),
          costo_unitario: Number(costoUnitario),
          tipo_documento: tipoDocumento || undefined,
          numero_documento: numeroDocumento.trim() || undefined,
          recibido_en: new Date(recibidoEn).toISOString(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo registrar la entrada.");
        return;
      }
      onCreado();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">Registrar entrada de urea</h3>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Proveedor</span>
          <select
            value={grifoId}
            onChange={(e) => setGrifoId(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          >
            <option value="">Elegir proveedor…</option>
            {grifos.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nombre}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Presentación</span>
            <select
              value={presentacion}
              onChange={(e) => setPresentacion(e.target.value as Presentacion)}
              className="rounded border border-gray-300 px-3 py-2"
            >
              {PRESENTACIONES.map((p) => (
                <option key={p.valor} value={p.valor}>
                  {p.etiqueta}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Cantidad recibida</span>
            <input
              type="number"
              min={1}
              value={cantidadBultos}
              onChange={(e) => setCantidadBultos(e.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>
        </div>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">
            Costo por {PRESENTACIONES.find((p) => p.valor === presentacion)?.etiqueta.split(" ")[0]}{" "}
            (S/.)
          </span>
          <input
            type="number"
            step="0.01"
            value={costoUnitario}
            onChange={(e) => setCostoUnitario(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Documento</span>
            <select
              value={tipoDocumento}
              onChange={(e) => setTipoDocumento(e.target.value as typeof tipoDocumento)}
              className="rounded border border-gray-300 px-3 py-2"
            >
              <option value="">Sin documento</option>
              <option value="factura">Factura</option>
              <option value="guia_remision">Guía de remisión</option>
            </select>
          </label>
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">N° de documento</span>
            <input
              value={numeroDocumento}
              onChange={(e) => setNumeroDocumento(e.target.value)}
              disabled={!tipoDocumento}
              className="rounded border border-gray-300 px-3 py-2 disabled:bg-slate-50"
            />
          </label>
        </div>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Fecha y hora de la entrega</span>
          <input
            type="datetime-local"
            value={recibidoEn}
            onChange={(e) => setRecibidoEn(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={
              !grifoId ||
              !cantidadBultos ||
              !costoUnitario ||
              (!!tipoDocumento && !numeroDocumento.trim()) ||
              enviando
            }
            onClick={enviar}
            className="px-4 py-2 bg-[#0A1014] text-white rounded-xl text-sm font-semibold disabled:opacity-50"
          >
            {enviando ? "Guardando…" : "Registrar entrada"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function ModalConteo({ onCerrar, onCreado }: { onCerrar: () => void; onCreado: () => void }) {
  const [clienteUuid] = useState(() => crypto.randomUUID());
  const [presentacion, setPresentacion] = useState<Presentacion>("caja");
  const [cantidadBultos, setCantidadBultos] = useState("");
  const [contadoEn, setContadoEn] = useState(ahoraParaInputLocal());
  const [observaciones, setObservaciones] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/urea/conteos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuid,
          presentacion,
          cantidad_bultos: Number(cantidadBultos),
          contado_en: new Date(contadoEn).toISOString(),
          observaciones: observaciones.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo registrar el conteo.");
        return;
      }
      onCreado();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">Registrar conteo físico de urea</h3>
        <p className="text-sm text-slate-500">
          Contá lo que queda en almacén AHORA MISMO, en la presentación que sea más fácil de contar.
          Es el reemplazo de la varilla del tanque: si no cuadra con lo que el sistema espera, va a
          quedar una alerta para revisar.
        </p>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Presentación contada</span>
            <select
              value={presentacion}
              onChange={(e) => setPresentacion(e.target.value as Presentacion)}
              className="rounded border border-gray-300 px-3 py-2"
            >
              {PRESENTACIONES.map((p) => (
                <option key={p.valor} value={p.valor}>
                  {p.etiqueta}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Cantidad contada</span>
            <input
              type="number"
              min={0}
              value={cantidadBultos}
              onChange={(e) => setCantidadBultos(e.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>
        </div>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Fecha y hora del conteo</span>
          <input
            type="datetime-local"
            value={contadoEn}
            onChange={(e) => setContadoEn(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Observaciones</span>
          <input
            value={observaciones}
            onChange={(e) => setObservaciones(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={cantidadBultos === "" || enviando}
            onClick={enviar}
            className="px-4 py-2 bg-[#0A1014] text-white rounded-xl text-sm font-semibold disabled:opacity-50"
          >
            {enviando ? "Guardando…" : "Registrar conteo"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
