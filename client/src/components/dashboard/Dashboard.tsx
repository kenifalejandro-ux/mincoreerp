/**client/src/components/dashboard/Dashboard.tsx**/

import { useState, useEffect } from "react";

import DocumentosEstado from "./charts/DocumentosEstado";
import InventarioCategoria from "./charts/InventarioCategoria";
import StockMinimoChart from "./charts/StockMinimoChart";
import ValorCategoria from "./charts/ValorCategoria";
import CountUp from "./CountUp";
import { apiFetch } from "../../services/apiClient";

interface Kpis {
  // 🔥 KPIs REPUESTOS OPERATIVOS
  total_repuestos: number;
  stock_bajo: number;
  valor_inventario: number;
  // 🔥 KPIs REPUESTOS ESTRATEGICOS
  porcentaje_riesgo: number;
  sobre_stock: number;
  valor_stock_bajo: number;

  combustible_porcentaje: number;
  docs_vencidos: number;
  docs_por_vencer: number;
}

export default function Dashboard() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [charts, setCharts] = useState<any>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await apiFetch("/api/erp/dashboard");
        if (!res.ok) throw new Error(`Error HTTP: ${res.status}`);

        const data = await res.json();

        const secureData: Kpis = {
          total_repuestos: Number(data.total_repuestos || 0),
          stock_bajo: Number(data.stock_bajo || 0),
          valor_inventario: Number(data.valor_inventario || 0),

          // 🔥 NUEVOS KPIs
          porcentaje_riesgo: Number(data.porcentaje_riesgo || 0),
          sobre_stock: Number(data.sobre_stock || 0),
          valor_stock_bajo: Number(data.valor_stock_bajo || 0),

          combustible_porcentaje: Number(data.combustible_porcentaje || 0),
          docs_vencidos: Number(data.docs_vencidos || 0),
          docs_por_vencer: Number(data.docs_por_vencer || 0),
        };

        setKpis(secureData);
        setBarWidth(Number(secureData.combustible_porcentaje));

        // 🔥 aquí ya vienen los gráficos
        setCharts({
          inventario_categoria: data.inventario_categoria,
          valor_categoria: data.valor_categoria,
          documentos_estado: data.documentos_estado,
          stock_vs_minimo: data.stock_vs_minimo,
        });

        setLoading(false);
      } catch (err) {
        console.error("Dashboard Fetch Error:", err);
        setError("No se pudo conectar con el servidor ERP.");
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col justify-center items-center h-96 space-y-4">
        <div className="w-8 h-8 border-2 border-slate-200 border-t-slate-900 rounded-full animate-spin"></div>
        <p className="text-slate-400 text-sm font-light">Cargando datos...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-lg mx-auto mt-20">
        <div className="bg-red-50 border border-red-200 rounded-xl p-8">
          <div className="text-center space-y-4">
            <div className="inline-flex items-center justify-center w-12 h-12 bg-red-100 rounded-lg">
              <div className="w-4 h-4 bg-red-500 rounded-sm"></div>
            </div>
            <div>
              <h3 className="text-lg font-light text-red-900 mb-2">Error de Conexión</h3>
              <p className="text-sm text-red-600 font-light">{error}</p>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="bg-red-600 hover:bg-red-700 text-white px-6 py-2.5 rounded-lg text-sm font-medium transition-colors duration-200"
            >
              Reintentar
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-700 slide-in-from-bottom-4">
      {/* Header Section */}
      <div className="mb-6 lg:mb-12">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="space-y-1">
            <h1 className="text-xl sm:text-2xl lg:text-3xl font-light text-slate-800 tracking-tight">
              Vista General
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 font-light">
              Indicadores clave del sistema
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></div>
            <span className="font-light">
              Actualizado{" "}
              {new Date().toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        </div>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        {/* --------------------------------REPUESTOS OPERATIVOS --------------------------------*/}
        {/* Total Inventario Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 hover:shadow-sm transition-all duration-300">
          <div className="flex items-start justify-between mb-8">
            <div className="space-y-0.5">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                Inventario
              </p>
              <p className="text-3xl font-light text-slate-900 tracking-tight">
                <CountUp end={kpis?.total_repuestos || 0} />
              </p>
            </div>
            <div className="w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center">
              <div className="w-3 h-3 bg-indigo-500 rounded-sm"></div>
            </div>
          </div>
          <p className="text-xs text-slate-400 font-light">Total de SKUs activos</p>
        </div>

        {/* Stock Crítico Card */}
        <div
          className={`border rounded-xl p-6 hover:shadow-sm transition-all duration-300 ${
            kpis && kpis.stock_bajo > 0
              ? "bg-amber-50 border-amber-200"
              : "bg-white border-slate-200"
          }`}
        >
          <div className="flex items-start justify-between mb-8">
            <div className="space-y-0.5">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                Stock Crítico
              </p>
              <p
                className={`text-3xl font-light tracking-tight ${
                  kpis && kpis.stock_bajo > 0 ? "text-amber-900" : "text-slate-900"
                }`}
              >
                <CountUp end={kpis?.stock_bajo || 0} />
              </p>
            </div>
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                kpis && kpis.stock_bajo > 0 ? "bg-amber-100" : "bg-emerald-50"
              }`}
            >
              <div
                className={`w-3 h-3 rounded-sm ${
                  kpis && kpis.stock_bajo > 0 ? "bg-amber-500" : "bg-emerald-500"
                }`}
              ></div>
            </div>
          </div>
          <p className="text-xs text-slate-400 font-light">
            {kpis && kpis.stock_bajo > 0 ? "Requieren reabastecimiento" : "Nivel óptimo"}
          </p>
        </div>

        {/* Valor Inventario Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 hover:shadow-sm transition-all duration-300">
          <div className="flex items-start justify-between mb-8">
            <div className="space-y-0.5">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                Valor Total
              </p>
              <p className="text-3xl font-light text-slate-900 tracking-tight">
                <CountUp end={kpis?.valor_inventario || 0} prefix="S/ " decimals={0} />
              </p>
            </div>
            <div className="w-8 h-8 bg-emerald-50 rounded-lg flex items-center justify-center">
              <div className="w-3 h-3 bg-emerald-500 rounded-sm"></div>
            </div>
          </div>
          <p className="text-xs text-slate-400 font-light">Patrimonio en inventario</p>
        </div>
        {/* --------------------------------REPUESTOS ESTRÁTEGICOS --------------------------------*/}

        {/* KPI — % Inventario en Riesgo */}
        <div
          className={`border rounded-xl p-6 transition-all duration-300 ${
            (kpis?.porcentaje_riesgo || 0) > 20
              ? "bg-red-50 border-red-200"
              : "bg-white border-slate-200"
          }`}
        >
          <div className="flex items-start justify-between mb-8">
            <div>
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                Inventario en Riesgo
              </p>
              <p
                className={`text-3xl font-light tracking-tight ${
                  (kpis?.porcentaje_riesgo || 0) > 20 ? "text-red-700" : "text-slate-900"
                }`}
              >
                <CountUp end={kpis?.porcentaje_riesgo || 0} />%
              </p>
            </div>
            <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center">
              <div className="w-3 h-3 bg-red-500 rounded-sm"></div>
            </div>
          </div>
          <p className="text-xs text-slate-400 font-light">Salud general del inventario</p>
        </div>

        {/* KPI — Sobre Stock */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 transition-all duration-300">
          <div className="flex items-start justify-between mb-8">
            <div>
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                Sobre Stock
              </p>
              <p className="text-3xl font-light text-slate-900 tracking-tight">
                <CountUp end={kpis?.sobre_stock || 0} />
              </p>
            </div>
            <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center">
              <div className="w-3 h-3 bg-blue-500 rounded-sm"></div>
            </div>
          </div>
          <p className="text-xs text-slate-400 font-light">Productos con exceso de inventario</p>
        </div>

        {/* KPI — Valor en Riesgo */}
        <div
          className={`border rounded-xl p-6 transition-all duration-300 ${
            (kpis?.valor_stock_bajo || 0) > 0
              ? "bg-rose-50 border-rose-200"
              : "bg-white border-slate-200"
          }`}
        >
          <div className="flex items-start justify-between mb-8">
            <div>
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                Valor en Riesgo
              </p>
              <p
                className={`text-3xl font-light tracking-tight ${
                  (kpis?.valor_stock_bajo || 0) > 0 ? "text-rose-700" : "text-slate-900"
                }`}
              >
                <CountUp end={kpis?.valor_stock_bajo || 0} prefix="S/ " decimals={0} />
              </p>
            </div>
            <div className="w-8 h-8 bg-rose-100 rounded-lg flex items-center justify-center">
              <div className="w-3 h-3 bg-rose-500 rounded-sm"></div>
            </div>
          </div>
          <p className="text-xs text-slate-400 font-light">Capital comprometido en stock crítico</p>
        </div>

        {/* Combustible Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 hover:shadow-sm transition-all duration-300">
          <div className="flex items-start justify-between mb-8">
            <div className="space-y-0.5">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                Combustible
              </p>
              <p className="text-3xl font-light text-slate-900 tracking-tight">
                <CountUp end={kpis?.combustible_porcentaje || 0} />%
              </p>
            </div>
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                Number(kpis?.combustible_porcentaje) < 30 ? "bg-red-50" : "bg-blue-50"
              }`}
            >
              <div
                className={`w-3 h-3 rounded-sm ${
                  Number(kpis?.combustible_porcentaje) < 30 ? "bg-red-500" : "bg-blue-500"
                }`}
              ></div>
            </div>
          </div>
          <div className="space-y-2">
            <div className="w-full h-1 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-1000 ease-out ${
                  Number(kpis?.combustible_porcentaje) < 30 ? "bg-red-500" : "bg-blue-500"
                }`}
                style={{ width: `${barWidth}%` }}
              ></div>
            </div>
            <p className="text-xs text-slate-400 font-light">Nivel del tanque principal</p>
          </div>
        </div>
      </div>

      {/* Charts Section */}
      {charts && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-8">
          <InventarioCategoria data={charts.inventario_categoria} />
          <ValorCategoria data={charts.valor_categoria} />
          <DocumentosEstado data={charts.documentos_estado} />
          <StockMinimoChart data={charts.stock_vs_minimo} />
        </div>
      )}

      {/* Documentos Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
            Documentación Legal
          </h2>
          <div className="w-6 h-6 bg-violet-50 rounded-md flex items-center justify-center">
            <div className="w-2 h-2 bg-violet-500 rounded-sm"></div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Vencidos */}
          <div className="space-y-1">
            <p className="text-xs text-slate-400 font-light">Documentos vencidos</p>
            <p
              className={`text-4xl font-light tracking-tight ${
                (kpis?.docs_vencidos || 0) > 0 ? "text-red-600" : "text-slate-900"
              }`}
            >
              <CountUp end={kpis?.docs_vencidos || 0} />
            </p>
          </div>

          {/* Por Vencer */}
          <div className="space-y-1">
            <p className="text-xs text-slate-400 font-light">Próximos a vencer</p>
            <p
              className={`text-4xl font-light tracking-tight ${
                (kpis?.docs_por_vencer || 0) > 0 ? "text-amber-600" : "text-slate-900"
              }`}
            >
              <CountUp end={kpis?.docs_por_vencer || 0} />
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
