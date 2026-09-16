// client/src/components/combustible/HistoricoCliente.tsx
//
// La pestaña "Histórico" dentro de Combustible: NO es la herramienta del
// auditor (eso ya es el kardex y los reportes de segregación/controles,
// solo para admin) -- es la que mira el CLIENTE. Un desplegable elige entre
// seis vistas y cada una pega contra un endpoint que ya existe o que se
// agregó junto con este archivo (ver combustible.routes.ts):
//
//   - Despachos (tanque propio)  -> GET /despachos?origen=tanque_propio
//   - Recepciones                -> GET /recepciones
//   - Consumo (grifo externo)    -> GET /despachos?origen=compra_externa
//   - Ranking por conductor      -> GET /consumo-por-conductor
//   - Ranking por vehículo       -> GET /consumo-por-vehiculo
//   - Ranking por grifo          -> GET /consumo-por-grifo
//
// Los tres rankings aceptan además ?agrupar_por=dia|semana|mes|anio -- sin
// él, una fila por entidad para todo el rango elegido; con él, una fila por
// entidad Y período (el desplegable "Agrupar" solo aparece en esas tres
// vistas, ver VISTAS_CON_PERIODO).
//
// Es una PESTAÑA del módulo (CombustiblePanel la monta cuando
// pestanaCombustible === "historico"), no una ventana flotante ni un botón
// más -- eso ya lo hacen "Historial de despachos" / "Historial de
// recepciones" y es justo lo que no había que repetir. Define sus propios
// tipos locales en vez de importarlos de CombustiblePanel: mismo criterio
// que ya usa ese archivo con DespachoHistorial/RecepcionHistorial, así este
// componente no depende de las ~7000 líneas de al lado.
//
// "Despachos" y "consumo" NO son lo mismo (aclarado con Kenif 2026-09-16):
// un despacho es el vale del TANQUE PROPIO -- el que sale del grifo interno,
// resta nivel y valida contra el contómetro. Una compra en grifo externo es
// combustible de otro lado, pagado aparte, que no toca el tanque. La vista
// "Histórico de despachos" de acá filtra origen=tanque_propio a propósito,
// para no mezclarla con "Compras en grifos externos" (que ya es su propia
// vista). El consumo TOTAL de un vehículo/conductor sí suma las dos cosas
// -- ahí el origen del combustible no importa, importa cuánto gastó.

import { useCallback, useEffect, useState, type ChangeEvent } from "react";

import { apiFetch } from "../services/apiClient";

type Vista =
  "despachos" | "recepciones" | "compras_externas" | "por_conductor" | "por_vehiculo" | "por_grifo";

const VISTAS: { valor: Vista; etiqueta: string }[] = [
  { valor: "despachos", etiqueta: "Histórico de despachos (tanque propio)" },
  { valor: "recepciones", etiqueta: "Histórico de recepciones de combustible" },
  { valor: "compras_externas", etiqueta: "Histórico de consumo (grifo externo)" },
  { valor: "por_conductor", etiqueta: "Ranking de consumo por conductor" },
  { valor: "por_vehiculo", etiqueta: "Ranking de consumo por vehículo" },
  { valor: "por_grifo", etiqueta: "Ranking de consumo por grifo (interno y externos)" },
];

/** Las tres vistas de arriba son rankings agregados -- las únicas donde
 *  agrupar por período (día/semana/mes/año) tiene sentido. Las otras tres
 *  son listados fila-por-vale, donde cada fila YA es un evento puntual. */
const VISTAS_CON_PERIODO: ReadonlySet<Vista> = new Set([
  "por_conductor",
  "por_vehiculo",
  "por_grifo",
]);

type Agrupacion = "" | "dia" | "semana" | "mes" | "anio";

const OPCIONES_AGRUPACION: { valor: Agrupacion; etiqueta: string }[] = [
  { valor: "", etiqueta: "Todo el período junto" },
  { valor: "dia", etiqueta: "Por día" },
  { valor: "semana", etiqueta: "Por semana" },
  { valor: "mes", etiqueta: "Por mes" },
  { valor: "anio", etiqueta: "Por año" },
];

const PAGE_SIZE = 500;

interface DespachoFila {
  id: number;
  origen: "tanque_propio" | "compra_externa";
  n_vale: number | null;
  serie_talonario: string | null;
  equipo_id: number | null;
  cantidad: string;
  costo_total: string;
  conductor_nombre: string | null;
  observaciones: string | null;
  despachado_en: string;
  anulada_en: string | null;
}

interface RecepcionFila {
  id: number;
  cantidad: string;
  costo_total: string;
  tanque_nombre: string;
  grifo_nombre: string;
  tipo_documento: "factura" | "guia_remision" | null;
  numero_documento: string | null;
  recibido_en: string;
  anulada_en: string | null;
}

interface ConductorFila {
  periodo?: string;
  conductor_nombre: string;
  conductor_dni: string | null;
  cantidad_vales: string;
  total_cantidad: string;
  total_costo: string;
  primer_despacho: string;
  ultimo_despacho: string;
}

interface VehiculoFila {
  periodo?: string;
  equipo_id: number;
  placa_codigo: string | null;
  equipo_tipo: string | null;
  cantidad_vales: string;
  total_cantidad: string;
  total_costo: string;
  primer_despacho: string;
  ultimo_despacho: string;
}

interface GrifoFila {
  periodo?: string;
  tipo_grifo: "interno" | "externo";
  grifo_nombre: string;
  cantidad_vales: string;
  total_cantidad: string;
  total_costo: string;
  primer_despacho: string;
  ultimo_despacho: string;
}

function paramsDePeriodo(desde: string, hasta: string, extra?: Record<string, string>) {
  const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
  if (desde) params.set("desde", new Date(`${desde}T00:00:00`).toISOString());
  if (hasta) params.set("hasta", new Date(`${hasta}T23:59:59.999`).toISOString());
  if (extra) {
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
  }
  return params;
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

function formatearPeriodo(iso: string, agrupacion: Agrupacion): string {
  const fecha = new Date(iso);
  if (agrupacion === "anio") return fecha.toLocaleDateString("es-PE", { year: "numeric" });
  if (agrupacion === "mes")
    return fecha.toLocaleDateString("es-PE", { month: "long", year: "numeric" });
  return fecha.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatearNumero(valor: string): string {
  const n = Number(valor);
  return Number.isFinite(n) ? n.toLocaleString("es-PE", { maximumFractionDigits: 2 }) : valor;
}

function mensajeDeFallo(status: number): string {
  return status === 400
    ? "Revisá las fechas: la de inicio tiene que ser anterior a la de fin."
    : "No se pudo cargar el histórico.";
}

/** Exporta lo que está en pantalla, no todo el histórico del tenant --
 *  mismo criterio que el kardex/reportes, que exportan solo el período
 *  elegido. Un valor con coma o comilla se escapa citándolo entero y
 *  duplicando las comillas internas (RFC 4180), para no romper el CSV con
 *  un nombre de conductor o de grifo que traiga una coma. */
function exportarCsv(filas: Record<string, unknown>[], nombreArchivo: string) {
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

export default function HistoricoCliente() {
  const [vista, setVista] = useState<Vista>("despachos");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [agrupacion, setAgrupacion] = useState<Agrupacion>("");
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [despachosInternos, setDespachosInternos] = useState<DespachoFila[]>([]);
  const [recepciones, setRecepciones] = useState<RecepcionFila[]>([]);
  const [comprasExternas, setComprasExternas] = useState<DespachoFila[]>([]);
  const [porConductor, setPorConductor] = useState<ConductorFila[]>([]);
  const [porVehiculo, setPorVehiculo] = useState<VehiculoFila[]>([]);
  const [porGrifo, setPorGrifo] = useState<GrifoFila[]>([]);

  const cargar = useCallback(async (v: Vista, d: string, h: string, agr: Agrupacion) => {
    setCargando(true);
    setError(null);
    try {
      const conAgrupacion = agr ? { agrupar_por: agr } : undefined;
      let url = "";
      switch (v) {
        case "despachos":
          url = `/api/erp/combustible/despachos?${paramsDePeriodo(d, h, { origen: "tanque_propio" })}`;
          break;
        case "compras_externas":
          url = `/api/erp/combustible/despachos?${paramsDePeriodo(d, h, { origen: "compra_externa" })}`;
          break;
        case "recepciones":
          url = `/api/erp/combustible/recepciones?${paramsDePeriodo(d, h)}`;
          break;
        case "por_conductor":
          url = `/api/erp/combustible/consumo-por-conductor?${paramsDePeriodo(d, h, conAgrupacion)}`;
          break;
        case "por_vehiculo":
          url = `/api/erp/combustible/consumo-por-vehiculo?${paramsDePeriodo(d, h, conAgrupacion)}`;
          break;
        case "por_grifo":
          url = `/api/erp/combustible/consumo-por-grifo?${paramsDePeriodo(d, h, conAgrupacion)}`;
          break;
      }
      const res = await apiFetch(url);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(mensajeDeFallo(res.status));
        return;
      }
      const filas = Array.isArray(body?.data) ? body.data : [];
      if (v === "despachos") setDespachosInternos(filas);
      else if (v === "compras_externas") setComprasExternas(filas);
      else if (v === "recepciones") setRecepciones(filas);
      else if (v === "por_conductor") setPorConductor(filas);
      else if (v === "por_vehiculo") setPorVehiculo(filas);
      else if (v === "por_grifo") setPorGrifo(filas);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar(vista, desde, hasta, agrupacion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vista]);

  const handleVerPeriodo = () => cargar(vista, desde, hasta, agrupacion);

  /** Cuál array mostrar en pantalla ahora -- un solo lugar para no repetir
   *  el switch (vista) en el export y en el render. */
  const filasDeLaVista = (): Record<string, unknown>[] => {
    switch (vista) {
      case "despachos":
        return despachosInternos as unknown as Record<string, unknown>[];
      case "compras_externas":
        return comprasExternas as unknown as Record<string, unknown>[];
      case "recepciones":
        return recepciones as unknown as Record<string, unknown>[];
      case "por_conductor":
        return porConductor as unknown as Record<string, unknown>[];
      case "por_vehiculo":
        return porVehiculo as unknown as Record<string, unknown>[];
      case "por_grifo":
        return porGrifo as unknown as Record<string, unknown>[];
    }
  };

  const handleExportar = () => {
    const etiqueta = VISTAS.find((v) => v.valor === vista)?.etiqueta ?? vista;
    exportarCsv(filasDeLaVista(), `${etiqueta} ${desde || "todo"} a ${hasta || "hoy"}.csv`);
  };

  /** El total de la vista actual -- las tres vistas fila-por-vale suman
   *  `cantidad`/`costo_total` y cada fila YA es un vale; los tres rankings
   *  suman `total_cantidad`/`total_costo` y "vales" es la suma de
   *  `cantidad_vales` de cada entidad, no la cantidad de filas (agrupado
   *  por período, una entidad ocupa varias filas). */
  const totalesDeLaVista = () => {
    const esRanking =
      vista === "por_conductor" || vista === "por_vehiculo" || vista === "por_grifo";
    const filas = filasDeLaVista();
    const campoCantidad = esRanking ? "total_cantidad" : "cantidad";
    const campoCosto = esRanking ? "total_costo" : "costo_total";
    const totalCantidad = filas.reduce((acc, f) => acc + Number(f[campoCantidad] ?? 0), 0);
    const totalCosto = filas.reduce((acc, f) => acc + Number(f[campoCosto] ?? 0), 0);
    const totalVales = esRanking
      ? filas.reduce((acc, f) => acc + Number(f.cantidad_vales ?? 0), 0)
      : filas.length;
    return { totalVales, totalCantidad, totalCosto };
  };

  // La importación todavía no tiene lógica -- ver Fase 1 del histórico
  // (cargar 2025-a-hoy con datos reales): antes de parsear nada hay que
  // verificar el Excel real del cliente a mano, no a ciegas. Este botón
  // por ahora solo deja elegir el archivo; el próximo paso es mostrar acá
  // una vista previa de las primeras filas para confirmarlas ANTES de
  // mandar nada a la base (mismo criterio que la simulación de junio).
  const [archivoAImportar, setArchivoAImportar] = useState<File | null>(null);
  const handleSeleccionArchivo = (e: ChangeEvent<HTMLInputElement>) => {
    setArchivoAImportar(e.target.files?.[0] ?? null);
  };

  return (
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
        {VISTAS_CON_PERIODO.has(vista) && (
          <label className="flex flex-col text-sm">
            <span className="text-gray-600">Agrupar</span>
            <select
              value={agrupacion}
              onChange={(e) => setAgrupacion(e.target.value as Agrupacion)}
              className="rounded border border-gray-300 px-2 py-1"
            >
              {OPCIONES_AGRUPACION.map((o) => (
                <option key={o.valor} value={o.valor}>
                  {o.etiqueta}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={handleVerPeriodo}
          disabled={cargando}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {cargando ? "Cargando…" : "Consultar"}
        </button>
        <div className="ml-auto flex items-end gap-3">
          <label
            className="px-4 py-2 border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-medium rounded-xl transition-all cursor-pointer text-sm flex items-center gap-2"
            title="Elegir el Excel con el histórico real del cliente (2025 a hoy)"
          >
            <span>📊 Importar Excel</span>
            <input
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={handleSeleccionArchivo}
            />
          </label>
          <button
            type="button"
            onClick={handleExportar}
            disabled={filasDeLaVista().length === 0}
            className="px-4 py-2 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            title="Exportar la vista actual a CSV"
          >
            ⬇️ Exportar
          </button>
        </div>
      </div>
      {archivoAImportar && (
        <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Elegiste <strong>{archivoAImportar.name}</strong>. Todavía no se procesa: antes hay que
          revisar el Excel a mano (placas contra equipos, fechas contra vales vecinos) para no
          repetir lo del vale mal tipeado que generó 116 alertas falsas. Ese paso viene después.
        </div>
      )}

      {!cargando && filasDeLaVista().length > 0 && (
        <div className="mx-4 mt-4 grid grid-cols-3 gap-3 rounded-xl bg-slate-50 border border-slate-200 p-4">
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Vales</p>
            <p className="text-xl font-bold text-slate-800">
              {totalesDeLaVista().totalVales.toLocaleString("es-PE")}
            </p>
          </div>
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">
              Cantidad total
            </p>
            <p className="text-xl font-bold text-slate-800">
              {totalesDeLaVista().totalCantidad.toLocaleString("es-PE", {
                maximumFractionDigits: 2,
              })}
            </p>
          </div>
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">
              Costo total
            </p>
            <p className="text-xl font-bold text-slate-800">
              S/{" "}
              {totalesDeLaVista().totalCosto.toLocaleString("es-PE", {
                maximumFractionDigits: 2,
              })}
            </p>
          </div>
        </div>
      )}

      <div className="p-4 overflow-x-auto">
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

        {vista === "despachos" && <TablaDespachos filas={despachosInternos} cargando={cargando} />}
        {vista === "compras_externas" && (
          <TablaDespachos filas={comprasExternas} cargando={cargando} />
        )}
        {vista === "recepciones" && <TablaRecepciones filas={recepciones} cargando={cargando} />}
        {vista === "por_conductor" && (
          <TablaConductor filas={porConductor} cargando={cargando} agrupacion={agrupacion} />
        )}
        {vista === "por_vehiculo" && (
          <TablaVehiculo filas={porVehiculo} cargando={cargando} agrupacion={agrupacion} />
        )}
        {vista === "por_grifo" && (
          <TablaGrifo filas={porGrifo} cargando={cargando} agrupacion={agrupacion} />
        )}
      </div>
    </div>
  );
}

function EstadoVacio({ cargando }: { cargando: boolean }) {
  return (
    <p className="py-8 text-center text-sm text-gray-500">
      {cargando ? "Cargando…" : "No hay datos para el período elegido."}
    </p>
  );
}

function TablaDespachos({ filas, cargando }: { filas: DespachoFila[]; cargando: boolean }) {
  if (filas.length === 0) return <EstadoVacio cargando={cargando} />;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-gray-600">
          <th className="py-1 pr-2">Fecha</th>
          <th className="py-1 pr-2">Vale</th>
          <th className="py-1 pr-2">Conductor</th>
          <th className="py-1 pr-2 text-right">Cantidad</th>
          <th className="py-1 pr-2 text-right">Costo total</th>
        </tr>
      </thead>
      <tbody>
        {filas.map((d) => (
          <tr key={d.id} className={`border-b ${d.anulada_en ? "text-gray-400 line-through" : ""}`}>
            <td className="py-1 pr-2">{formatearFecha(d.despachado_en)}</td>
            <td className="py-1 pr-2">
              {d.serie_talonario && d.n_vale ? `${d.serie_talonario}-${d.n_vale}` : "—"}
            </td>
            <td className="py-1 pr-2">{d.conductor_nombre ?? "—"}</td>
            <td className="py-1 pr-2 text-right">{formatearNumero(d.cantidad)}</td>
            <td className="py-1 pr-2 text-right">{formatearNumero(d.costo_total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TablaRecepciones({ filas, cargando }: { filas: RecepcionFila[]; cargando: boolean }) {
  if (filas.length === 0) return <EstadoVacio cargando={cargando} />;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-gray-600">
          <th className="py-1 pr-2">Fecha</th>
          <th className="py-1 pr-2">Tanque</th>
          <th className="py-1 pr-2">Proveedor</th>
          <th className="py-1 pr-2">Documento</th>
          <th className="py-1 pr-2 text-right">Cantidad</th>
          <th className="py-1 pr-2 text-right">Costo total</th>
        </tr>
      </thead>
      <tbody>
        {filas.map((r) => (
          <tr key={r.id} className={`border-b ${r.anulada_en ? "text-gray-400 line-through" : ""}`}>
            <td className="py-1 pr-2">{formatearFecha(r.recibido_en)}</td>
            <td className="py-1 pr-2">{r.tanque_nombre}</td>
            <td className="py-1 pr-2">{r.grifo_nombre}</td>
            <td className="py-1 pr-2">
              {r.numero_documento
                ? `${r.tipo_documento === "factura" ? "Factura" : "Guía"} ${r.numero_documento}`
                : "—"}
            </td>
            <td className="py-1 pr-2 text-right">{formatearNumero(r.cantidad)}</td>
            <td className="py-1 pr-2 text-right">{formatearNumero(r.costo_total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TablaConductor({
  filas,
  cargando,
  agrupacion,
}: {
  filas: ConductorFila[];
  cargando: boolean;
  agrupacion: Agrupacion;
}) {
  if (filas.length === 0) return <EstadoVacio cargando={cargando} />;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-gray-600">
          {agrupacion && <th className="py-1 pr-2">Período</th>}
          <th className="py-1 pr-2">Conductor</th>
          <th className="py-1 pr-2">DNI</th>
          <th className="py-1 pr-2 text-right">Vales</th>
          <th className="py-1 pr-2 text-right">Total cantidad</th>
          <th className="py-1 pr-2 text-right">Total costo</th>
          <th className="py-1 pr-2">Último despacho</th>
        </tr>
      </thead>
      <tbody>
        {filas.map((c, i) => (
          <tr
            key={`${c.periodo ?? ""}-${c.conductor_nombre}-${c.conductor_dni ?? ""}-${i}`}
            className="border-b"
          >
            {agrupacion && (
              <td className="py-1 pr-2">{c.periodo && formatearPeriodo(c.periodo, agrupacion)}</td>
            )}
            <td className="py-1 pr-2">{c.conductor_nombre}</td>
            <td className="py-1 pr-2">{c.conductor_dni ?? "—"}</td>
            <td className="py-1 pr-2 text-right">{c.cantidad_vales}</td>
            <td className="py-1 pr-2 text-right">{formatearNumero(c.total_cantidad)}</td>
            <td className="py-1 pr-2 text-right">{formatearNumero(c.total_costo)}</td>
            <td className="py-1 pr-2">{formatearFecha(c.ultimo_despacho)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TablaVehiculo({
  filas,
  cargando,
  agrupacion,
}: {
  filas: VehiculoFila[];
  cargando: boolean;
  agrupacion: Agrupacion;
}) {
  if (filas.length === 0) return <EstadoVacio cargando={cargando} />;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-gray-600">
          <th className="py-1 pr-2">#</th>
          {agrupacion && <th className="py-1 pr-2">Período</th>}
          <th className="py-1 pr-2">Placa</th>
          <th className="py-1 pr-2">Tipo</th>
          <th className="py-1 pr-2 text-right">Vales</th>
          <th className="py-1 pr-2 text-right">Total cantidad</th>
          <th className="py-1 pr-2 text-right">Total costo</th>
          <th className="py-1 pr-2">Último despacho</th>
        </tr>
      </thead>
      <tbody>
        {filas.map((v, i) => (
          <tr key={`${v.periodo ?? ""}-${v.equipo_id}-${i}`} className="border-b">
            <td className="py-1 pr-2">{i + 1}</td>
            {agrupacion && (
              <td className="py-1 pr-2">{v.periodo && formatearPeriodo(v.periodo, agrupacion)}</td>
            )}
            <td className="py-1 pr-2">{v.placa_codigo ?? `Equipo #${v.equipo_id}`}</td>
            <td className="py-1 pr-2">{v.equipo_tipo ?? "—"}</td>
            <td className="py-1 pr-2 text-right">{v.cantidad_vales}</td>
            <td className="py-1 pr-2 text-right">{formatearNumero(v.total_cantidad)}</td>
            <td className="py-1 pr-2 text-right">{formatearNumero(v.total_costo)}</td>
            <td className="py-1 pr-2">{formatearFecha(v.ultimo_despacho)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TablaGrifo({
  filas,
  cargando,
  agrupacion,
}: {
  filas: GrifoFila[];
  cargando: boolean;
  agrupacion: Agrupacion;
}) {
  if (filas.length === 0) return <EstadoVacio cargando={cargando} />;
  const totalInterno = filas
    .filter((f) => f.tipo_grifo === "interno")
    .reduce((acc, f) => acc + Number(f.total_cantidad), 0);
  const totalExterno = filas
    .filter((f) => f.tipo_grifo === "externo")
    .reduce((acc, f) => acc + Number(f.total_cantidad), 0);
  return (
    <div>
      <p className="mb-3 text-sm text-gray-700">
        Interno: <span className="font-semibold">{totalInterno.toLocaleString("es-PE")}</span> ·
        Externo: <span className="font-semibold">{totalExterno.toLocaleString("es-PE")}</span>
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-gray-600">
            {agrupacion && <th className="py-1 pr-2">Período</th>}
            <th className="py-1 pr-2">Tipo</th>
            <th className="py-1 pr-2">Grifo</th>
            <th className="py-1 pr-2 text-right">Vales</th>
            <th className="py-1 pr-2 text-right">Total cantidad</th>
            <th className="py-1 pr-2 text-right">Total costo</th>
            <th className="py-1 pr-2">Último despacho</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f, i) => (
            <tr
              key={`${f.periodo ?? ""}-${f.tipo_grifo}-${f.grifo_nombre}-${i}`}
              className="border-b"
            >
              {agrupacion && (
                <td className="py-1 pr-2">
                  {f.periodo && formatearPeriodo(f.periodo, agrupacion)}
                </td>
              )}
              <td className="py-1 pr-2">{f.tipo_grifo === "interno" ? "Interno" : "Externo"}</td>
              <td className="py-1 pr-2">{f.grifo_nombre}</td>
              <td className="py-1 pr-2 text-right">{f.cantidad_vales}</td>
              <td className="py-1 pr-2 text-right">{formatearNumero(f.total_cantidad)}</td>
              <td className="py-1 pr-2 text-right">{formatearNumero(f.total_costo)}</td>
              <td className="py-1 pr-2">{formatearFecha(f.ultimo_despacho)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
