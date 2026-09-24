/**client/src/components/repuestos/repuestostable.tsx */

import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";
import { ahoraParaInputLocal } from "../../utils/fechaLocal";

// 1. ESTRUCTURA DE DATOS: Define qué campos tiene un repuesto
interface Repuesto {
  id: number;
  codigo: string;
  nombre: string;
  categoria: string;
  stock: number;
  stock_minimo: number;
  stock_maximo: number;
  precio: string;
  fecha: string; // <-- Agrega esta línea para que reconozca r.fecha
}

interface OrdenTrabajoResumen {
  id: number;
  titulo: string;
}

/** Espejo de MAX_FILAS_CARGA_MASIVA en server/schemas/repuestos.schema.ts.
 *  Duplicarlo permite avisar ANTES de mandar miles de filas al servidor
 *  para que las rechace; el servidor sigue siendo el que decide (esto es
 *  comodidad, no seguridad). */
const MAX_FILAS_IMPORTACION = 5000;

/** Traduce la respuesta de error a algo accionable -- mismo criterio que
 *  DocumentosTable.tsx. El 413 es el caso que más confundía: no lo genera
 *  nuestro código sino Express, así que no trae JSON y sin este mensaje el
 *  usuario ve un error vacío. */
async function mensajeDeErrorDelServidor(res: Response, filas: number): Promise<string> {
  if (res.status === 413) {
    return `El archivo es demasiado grande para enviarlo de una vez (${filas} filas). Dividilo en varios archivos.`;
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => null);
    if (body?.error === "cuota_excedida") {
      return `Se alcanzó el límite de repuestos del plan (${body.uso} de ${body.limite}). Importar ${filas} más lo superaría.`;
    }
    return "No tenés permiso para importar repuestos.";
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => null);
    const primero = body?.errors?.[0];
    if (primero) {
      // El campo viene como "3.codigo" (índice del array). Se traduce a
      // número de fila de la planilla, +2 por el encabezado.
      const indice = Number(String(primero.field).split(".")[0]);
      const ubicacion = Number.isInteger(indice) ? `Fila ${indice + 2}: ` : "";
      return `${ubicacion}${primero.message}`;
    }
    return "El archivo tiene filas con datos inválidos.";
  }
  return "El servidor rechazó la importación. Intentalo de nuevo.";
}

export default function RepuestosTable() {
  // --- ESTADOS (CAMPOS DE MEMORIA) ---
  const [repuestos, setRepuestos] = useState<Repuesto[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // 📦 IMPORTACIÓN MASIVA
  const [importando, setImportando] = useState(false);
  const [errorImportacion, setErrorImportacion] = useState<string | null>(null);
  const [resultadoImportacion, setResultadoImportacion] = useState<string | null>(null);

  //  Crea la función para abrir el modo edición:
  const openEditModal = (r: Repuesto) => {
    setEditingId(r.id); // Guardamos el ID que vamos a editar
    setFormData({
      codigo: r.codigo,
      nombre: r.nombre,
      categoria: r.categoria,
      stock: r.stock,
      stock_minimo: r.stock_minimo,
      stock_maximo: r.stock_maximo,
      precio: Number(r.precio),
    });
    setIsModalOpen(true);
  };

  // Estado para el formulario (se usa tanto para crear como para editar)
  const [formData, setFormData] = useState({
    codigo: "",
    nombre: "",
    categoria: "General",
    stock: 0,
    stock_minimo: 5,
    stock_maximo: 30,
    precio: 0,
  });

  // --- MOVIMIENTO DE STOCK (entrada/salida, offline-capaz) ---
  const [movimientoRepuesto, setMovimientoRepuesto] = useState<Repuesto | null>(null);
  const [movTipo, setMovTipo] = useState<"entrada" | "salida">("salida");
  const [movCantidad, setMovCantidad] = useState("");
  const [movMotivo, setMovMotivo] = useState("");
  const [movRegistradoEn, setMovRegistradoEn] = useState(ahoraParaInputLocal());
  // Vínculo opcional a la Orden de Trabajo que motivó el movimiento (ver
  // migrations/0050) -- solo trazabilidad, sin exigir ningún estado de la
  // OT en este PR.
  const [movOrdenTrabajoId, setMovOrdenTrabajoId] = useState("");
  const [ordenesDeTrabajo, setOrdenesDeTrabajo] = useState<OrdenTrabajoResumen[]>([]);
  const [movEnviando, setMovEnviando] = useState(false);
  // El cliente_uuid se fija al ABRIR el modal, no al apretar el botón --
  // mismo motivo que en CombustiblePanel/ChecklistsView: si los dos taps
  // entran antes del re-render, generarlo en el submit mandaría dos claves
  // distintas y el servidor crearía dos movimientos.
  const [movClienteUuid, setMovClienteUuid] = useState("");

  const fetchRepuestos = useCallback(
    async (paginaAConsultar: number = page) => {
      try {
        const res = await apiFetch(`/api/erp/repuestos?page=${paginaAConsultar}&pageSize=50`);
        const body = await res.json();
        setRepuestos(Array.isArray(body.data) ? body.data : []);
        setTotalPages(body.pagination?.totalPages ?? 1);
        setLoading(false);
      } catch (err) {
        console.error("Error al obtener repuestos:", err);
        setLoading(false);
      }
    },
    [page]
  );

  // 2. CARGA: Trae los datos de la base de datos (paginado) al montar y al cambiar de página
  useEffect(() => {
    // Patrón estándar de carga (setLoading(true) -> fetch -> setLoading(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchRepuestos(page);
  }, [page, fetchRepuestos]);

  // Catálogo para el selector opcional de Orden de Trabajo -- best-effort:
  // si el módulo OT no está habilitado para este tenant, el select queda
  // vacío sin romper el resto del formulario.
  useEffect(() => {
    apiFetch("/api/erp/ordenes_trabajo?page=1&pageSize=200")
      .then((r) => r.json())
      .then((body) => setOrdenesDeTrabajo(Array.isArray(body.data) ? body.data : []))
      .catch(() => setOrdenesDeTrabajo([]));
  }, []);

  // Cuando la cola offline termina de drenar, recargar pone el stock al
  // día sin que el operario tenga que refrescar a mano -- tanto si el
  // movimiento se aplicó (mismo hook que usa CombustiblePanel.tsx) como si
  // el servidor lo RECHAZÓ (stock insuficiente, ver
  // repuestos.repository.ts): en ese caso corrige el optimistic update que
  // se aplicó al encolarlo. El aviso al operario de qué se perdió y por
  // qué ya lo da EstadoOffline.tsx (banner global, lee `descartadas`) --
  // acá no hace falta duplicarlo, solo refrescar los números.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas, descartadas }) => {
      const propias = descartadas.some((d) => d.moduloId === "repuestos");
      if (sincronizadas > 0 || propias) fetchRepuestos(page);
    });
  }, [page, fetchRepuestos]);

  // --- MOVIMIENTO DE STOCK: abrir modal y registrar ---
  const abrirModalMovimiento = (r: Repuesto) => {
    setMovimientoRepuesto(r);
    setMovTipo("salida");
    setMovCantidad("");
    setMovMotivo("");
    setMovRegistradoEn(ahoraParaInputLocal());
    setMovOrdenTrabajoId("");
    // Se regenera en cada apertura: si no, el segundo movimiento legítimo
    // del turno reusaría la clave del primero y el servidor devolvería
    // aquel en silencio -- se perdería un movimiento, que es peor que el
    // duplicado que estamos evitando.
    setMovClienteUuid(crypto.randomUUID());
  };

  const cerrarModalMovimiento = () => setMovimientoRepuesto(null);

  const handleRegistrarMovimiento = async (e: React.FormEvent) => {
    e.preventDefault();
    if (movEnviando || !movimientoRepuesto) return;
    setMovEnviando(true);
    try {
      const res = await apiFetch("/api/erp/repuestos/movimientos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Viene del estado (se fijó al abrir el modal), NO de un
          // crypto.randomUUID() acá adentro -- ver el comentario donde se
          // declara movClienteUuid.
          cliente_uuid: movClienteUuid,
          repuesto_id: movimientoRepuesto.id,
          tipo: movTipo,
          cantidad: Number(movCantidad),
          motivo: movMotivo || undefined,
          registrado_en: new Date(movRegistradoEn).toISOString(),
          orden_trabajo_id: movOrdenTrabajoId ? Number(movOrdenTrabajoId) : undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.message || "Error al registrar el movimiento.");
        return;
      }

      cerrarModalMovimiento();

      // 202 = no había red y quedó en la cola del dispositivo (ver
      // apiFetch). No se recarga: sin señal el GET también falla, y el
      // movimiento todavía no existe del lado del servidor -- pero SÍ se
      // aplica optimistamente en la fila para que el operario vea el
      // cambio ya mismo (físicamente ya pasó). Si el servidor lo rechaza
      // al sincronizar (stock insuficiente), el efecto de arriba
      // (suscribirseASincronizacion) refresca y corrige este número solo.
      if (res.status === 202) {
        const delta = movTipo === "entrada" ? Number(movCantidad) : -Number(movCantidad);
        setRepuestos((prev) =>
          prev.map((r) => (r.id === movimientoRepuesto.id ? { ...r, stock: r.stock + delta } : r))
        );
        alert(
          "Sin conexión: el movimiento quedó guardado en este equipo y se enviará solo cuando vuelva la señal."
        );
        return;
      }

      fetchRepuestos(page);
    } finally {
      setMovEnviando(false);
    }
  };

  // 3. LÓGICA DE ELIMINACIÓN: Borra un registro por ID
  const handleDelete = async (id: number) => {
    // 1. Pedir confirmación al usuario
    if (!window.confirm("¿Estás seguro de que deseas eliminar este repuesto?")) return;

    try {
      // 2. Llamada a la API
      const res = await apiFetch(`/api/erp/repuestos/${id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        // 3. Recargar la página actual (no solo filtrar en memoria, para que
        // el total y las páginas restantes sigan siendo correctos)
        fetchRepuestos(page);
        alert("Eliminado con éxito");
      } else {
        alert("Error: El servidor no permitió eliminar el registro.");
      }
    } catch {
      alert("Error de conexión con el backend.");
    }
  };

  // 4. CARGA MASIVA EXCEL: Procesa archivos .xlsx
  // xlsx se carga on-demand (import dinámico) para que su chunk no viaje
  // en el bundle inicial: solo hace falta cuando se usa esta importación.
  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Sin esto, elegir el MISMO archivo dos veces seguidas no dispara
    // onChange (el value no cambió) -- justo lo que querría hacer alguien
    // que corrigió su planilla y la vuelve a subir con el mismo nombre.
    e.target.value = "";
    if (!file) return;

    setErrorImportacion(null);
    setResultadoImportacion(null);
    setImportando(true);

    const reader = new FileReader();
    reader.onerror = () => {
      setImportando(false);
      setErrorImportacion("No se pudo leer el archivo.");
    };
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const XLSX = await import("xlsx");
        const wb = XLSX.read(bstr, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (!ws) throw new Error("El archivo no tiene ninguna hoja de cálculo.");
        const data = XLSX.utils.sheet_to_json(ws);

        if (data.length === 0) throw new Error("La primera hoja está vacía.");
        if (data.length > MAX_FILAS_IMPORTACION) {
          throw new Error(
            `El archivo tiene ${data.length} filas y el máximo es ${MAX_FILAS_IMPORTACION}. Dividilo en varios archivos.`
          );
        }

        const res = await apiFetch("/api/erp/repuestos/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });

        if (!res.ok) {
          setErrorImportacion(await mensajeDeErrorDelServidor(res, data.length));
          return;
        }

        const body = await res.json().catch(() => ({}));
        setResultadoImportacion(
          `Se importaron ${body.insertados ?? data.length} repuestos correctamente.`
        );
        fetchRepuestos();
      } catch (err) {
        setErrorImportacion(err instanceof Error ? err.message : "Error al procesar el archivo.");
      } finally {
        setImportando(false);
      }
    };
    reader.readAsBinaryString(file);
  };

  // 5. REGISTRO MANUAL: Envía el formulario a la base de datos
  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Si hay editingId es PUT (editar), si no es POST (crear)
    const url = editingId ? `/api/erp/repuestos/${editingId}` : "/api/erp/repuestos";

    const method = editingId ? "PUT" : "POST";

    try {
      const res = await apiFetch(url, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (res.ok) {
        setIsModalOpen(false);
        setEditingId(null);
        fetchRepuestos();
        setFormData({
          codigo: "",
          nombre: "",
          categoria: "General",
          stock: 0,
          stock_minimo: 5,
          stock_maximo: 30,
          precio: 0,
        });
      }
    } catch {
      alert("Error al procesar la solicitud en PHP.");
    }
  };

  // 6. BUSCADOR: filtra solo dentro de la página actual (50 filas) — como
  // el listado ahora pagina en el servidor, buscar en todo el inventario
  // requeriría mandar el término al backend (pendiente, no en este cambio).
  const filteredRepuestos = repuestos.filter(
    (r) =>
      r.nombre.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.codigo.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) return <div className="p-20 text-center text-slate-500">Cargando...</div>;

  return (
    <div className="p-2 sm:p-4 lg:p-8 animate-in fade-in duration-500">
      {/* CABECERA: Título y Botones de acción */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 lg:gap-6 mb-6 lg:mb-10">
        <div>
          <h1 className="text-lg sm:text-xl lg:text-2xl font-bold text-slate-800 tracking-tight">
            Inventario de Repuestos
          </h1>
          <p className="text-xs sm:text-sm text-slate-500">Control de existencias y carga masiva</p>
        </div>

        <div className="flex items-center gap-3">
          <label
            className={`px-4 py-2.5 border rounded-xl flex items-center gap-2 transition-all ${
              importando
                ? "bg-emerald-100 text-emerald-400 border-emerald-200 cursor-wait"
                : "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 cursor-pointer"
            }`}
          >
            <FileSpreadsheet className="w-4 h-4 shrink-0" />
            <span>{importando ? "Importando..." : "Importar Excel"}</span>
            <input
              type="file"
              accept=".xlsx, .xls"
              className="hidden"
              disabled={importando}
              onChange={handleExcelUpload}
            />
          </label>
          <button
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2 px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
          >
            <Plus className="w-4 h-4 shrink-0" />
            Nuevo Repuesto
          </button>
        </div>
      </div>

      {/* RESULTADO DE LA IMPORTACIÓN */}
      {errorImportacion && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <p className="text-sm text-red-900 font-light flex-1">{errorImportacion}</p>
          <button
            className="text-red-400 hover:text-red-600 shrink-0"
            onClick={() => setErrorImportacion(null)}
            aria-label="Cerrar aviso de error"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {resultadoImportacion && (
        <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
          <p className="text-sm text-green-900 font-light flex-1">{resultadoImportacion}</p>
          <button
            className="text-green-500 hover:text-green-700 shrink-0"
            onClick={() => setResultadoImportacion(null)}
            aria-label="Cerrar aviso de importación"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* BARRA DE BÚSQUEDA */}
      <div className="mb-8">
        <input
          type="text"
          placeholder="Buscar repuesto por nombre o código..."
          className="w-full bg-white border border-slate-200 rounded-2xl px-4 sm:px-5 py-3 sm:py-4 text-sm outline-none focus:ring-2 focus:ring-slate-900 transition-all shadow-sm"
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* TABLA DE DATOS */}
      <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left border-collapse">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  id
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  codigo
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  nombre
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  categoria
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  stock
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  stock_minimo
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  stock_maximo
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  precio
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                  fecha-creación
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                  editar-eliminar
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRepuestos.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-400">
                    #{r.id}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 font-mono text-xs sm:text-sm text-slate-500">
                    {r.codigo}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm font-semibold text-slate-800">
                    {r.nombre}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-600">
                    {r.categoria}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm">
                    <span
                      className={`font-bold ${
                        Number(r.stock) <= Number(r.stock_minimo)
                          ? "text-red-500" // Alerta: Stock bajo
                          : Number(r.stock) >= Number(r.stock_maximo)
                            ? "text-orange-500" // Alerta: Sobre-stock
                            : "text-emerald-600" // Todo bien
                      }`}
                    >
                      {r.stock}
                    </span>
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-400 font-medium">
                    {r.stock_minimo}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-400 font-medium">
                    {r.stock_maximo}
                  </td>

                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm font-medium text-slate-900">
                    S/ {Number(r.precio).toFixed(2)}
                  </td>

                  {/* FECHA DE CREACIÓN (Mapeada desde el backend) */}
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-500 text-right">
                    {r.fecha || "---"}
                  </td>

                  {/* ACCIONES (MOVIMIENTO - EDITAR - ELIMINAR) */}
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-right space-x-2">
                    <button
                      onClick={() => abrirModalMovimiento(r)}
                      className="p-2 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all"
                      title="Registrar movimiento de stock"
                    >
                      <ArrowLeftRight className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => openEditModal(r)}
                      className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                      title="Editar"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(r.id)}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                      title="Eliminar"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* PAGINACIÓN */}
      <div className="flex items-center justify-between mt-4 px-1">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
        >
          <ChevronLeft className="w-4 h-4" />
          Anterior
        </button>
        <span className="text-sm text-slate-400">
          Página {page} de {totalPages}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
        >
          Siguiente
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* MODAL PARA NUEVO REGISTRO */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl animate-in zoom-in duration-200">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Nuevo Repuesto</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                aria-label="Cerrar"
                className="text-slate-400 hover:text-slate-900"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* FORMULARIO PARA NUEVO REGISTRO */}

            <form onSubmit={handleManualSubmit} className="p-6 space-y-4">
              {/* Fila 1: Código */}
              <div className="space-y-1">
                <label
                  htmlFor="repuesto-codigo"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Código del Repuesto
                </label>
                <input
                  id="repuesto-codigo"
                  type="text"
                  placeholder="Ej: FIL-001"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.codigo}
                  onChange={(e) => setFormData({ ...formData, codigo: e.target.value })}
                />
              </div>

              {/* Fila 2: Nombre */}
              <div className="space-y-1">
                <label
                  htmlFor="repuesto-nombre"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Nombre del Producto
                </label>
                <input
                  id="repuesto-nombre"
                  type="text"
                  placeholder="Nombre completo"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.nombre}
                  onChange={(e) => setFormData({ ...formData, nombre: e.target.value })}
                />
              </div>

              {/* Fila 3: Categoría (Selección) */}
              <div className="space-y-1">
                <label
                  htmlFor="repuesto-categoria"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Categoría
                </label>
                <select
                  id="repuesto-categoria"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={formData.categoria}
                  onChange={(e) => setFormData({ ...formData, categoria: e.target.value })}
                >
                  <option value="Motor">Motor</option>
                  <option value="Frenos">Frenos</option>
                  <option value="Eléctrico">Eléctrico</option>
                  <option value="Refrigeración">Refrigeración</option>
                  <option value="Suspensión">Suspensión</option>
                  <option value="Alimentación">Alimentación</option>
                </select>
              </div>

              {/* Fila 4: Stocks (Dos columnas) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="repuesto-stock-actual"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Stock Actual
                  </label>
                  <input
                    id="repuesto-stock-actual"
                    type="number"
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.stock}
                    onChange={(e) => setFormData({ ...formData, stock: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label
                      htmlFor="repuesto-stock-minimo"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Stock Mínimo
                    </label>
                    <input
                      id="repuesto-stock-minimo"
                      type="number"
                      className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                      value={formData.stock_minimo}
                      onChange={(e) =>
                        setFormData({ ...formData, stock_minimo: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="repuesto-stock-maximo"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Stock Máximo
                    </label>
                    <input
                      id="repuesto-stock-maximo"
                      type="number"
                      className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                      value={formData.stock_maximo}
                      onChange={(e) =>
                        setFormData({ ...formData, stock_maximo: Number(e.target.value) })
                      }
                    />
                  </div>
                </div>
              </div>

              {/* Fila 5: Precio */}
              <div className="space-y-1">
                <label
                  htmlFor="repuesto-precio"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Precio Unitario (S/)
                </label>
                <input
                  id="repuesto-precio"
                  type="number"
                  step="0.01"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.precio}
                  onChange={(e) => setFormData({ ...formData, precio: Number(e.target.value) })}
                />
              </div>

              <button
                type="submit"
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4"
              >
                {editingId ? "Guardar Cambios" : "Registrar en Inventario"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: registrar movimiento de stock */}
      {movimientoRepuesto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl animate-in zoom-in duration-200">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Movimiento — {movimientoRepuesto.codigo}</h3>
              <button
                onClick={cerrarModalMovimiento}
                aria-label="Cerrar"
                className="text-slate-400 hover:text-slate-900"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleRegistrarMovimiento} className="p-6 space-y-4">
              <p className="text-sm text-slate-500">
                Stock actual: <span className="font-bold">{movimientoRepuesto.stock}</span>
              </p>

              <div className="space-y-1">
                <label
                  htmlFor="movimiento-tipo"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Tipo de movimiento
                </label>
                <select
                  id="movimiento-tipo"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={movTipo}
                  onChange={(e) => setMovTipo(e.target.value as "entrada" | "salida")}
                >
                  <option value="salida">Salida (se usó / se retiró)</option>
                  <option value="entrada">Entrada (ingreso / devolución)</option>
                </select>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="movimiento-cantidad"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Cantidad
                </label>
                <input
                  id="movimiento-cantidad"
                  type="number"
                  min={1}
                  step="1"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={movCantidad}
                  onChange={(e) => setMovCantidad(e.target.value)}
                />
                {/* Advertencia NO bloqueante: el stock visible puede estar
                    desactualizado offline (otra salida ya se lo llevó, o
                    todavía no sincronizó) -- quien decide de verdad es el
                    servidor al sincronizar, esto solo evita una sorpresa. */}
                {movTipo === "salida" &&
                  Number(movCantidad) > 0 &&
                  Number(movCantidad) > movimientoRepuesto.stock && (
                    <p className="text-xs text-amber-600">
                      El stock visible es {movimientoRepuesto.stock}. Si al sincronizar no alcanza,
                      el servidor rechaza este movimiento.
                    </p>
                  )}
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="movimiento-motivo"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Motivo (opcional)
                </label>
                <input
                  id="movimiento-motivo"
                  type="text"
                  placeholder="Ej: usado en mantenimiento del equipo EQ-01"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={movMotivo}
                  onChange={(e) => setMovMotivo(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="movimiento-orden-trabajo"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Orden de Trabajo (opcional)
                </label>
                <select
                  id="movimiento-orden-trabajo"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={movOrdenTrabajoId}
                  onChange={(e) => setMovOrdenTrabajoId(e.target.value)}
                >
                  <option value="">Sin vincular</option>
                  {ordenesDeTrabajo.map((ot) => (
                    <option key={ot.id} value={ot.id}>
                      #{ot.id} — {ot.titulo}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="movimiento-registrado-en"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Fecha y hora del movimiento
                </label>
                <input
                  id="movimiento-registrado-en"
                  type="datetime-local"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={movRegistradoEn}
                  onChange={(e) => setMovRegistradoEn(e.target.value)}
                />
              </div>

              <button
                type="submit"
                disabled={movEnviando}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-50"
              >
                {movEnviando ? "Registrando..." : "Registrar movimiento"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
