// client/src/components/equipos/EquiposTable.tsx
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";
import MoverDeGrifo from "../comunes/MoverDeGrifo";
import { useSedes } from "../comunes/useSedes";

interface Equipo {
  id: number;
  placa_codigo: string;
  tipo: string;
  marca: string | null;
  modelo: string | null;
  // Fase B de combustible (migrations/0062): qué instrumento mide este
  // equipo en un despacho de compra externa -- horómetro (horas de motor)
  // u odómetro (kilometraje), nunca los dos. null = no configurado, y un
  // despacho compra_externa a este equipo se rechaza hasta que se cargue.
  tipo_medidor: "horometro" | "odometro" | null;
  // Fase D de combustible (migrations/0069): capacidad del tanque de ESTA
  // unidad, para detectar sobredespacho. null = sin configurar, y entonces
  // no se valida nada para este equipo -- que es el estado inicial de todos
  // a propósito: un dato inventado sería peor que ninguno.
  capacidad_tanque: string | null;
  capacidad_tanque_unidad: "gal" | "L" | null;
  /** Litros por hora de motor (horómetro) o por km (odómetro) que se toleran.
   *  null = sin configurar, no alerta (migración 0088). */
  consumo_maximo_l: string | null;
  conductor_nombre: string | null;
  conductor_dni: string | null;
  activo: boolean;
  creado_en: string;
  // El grifo interno al que pertenece (0097). Se cambia con "Mover de grifo".
  grifo_interno_id: number | null;
}

const TIPOS_COMUNES = [
  "Camioneta",
  "Cargador frontal",
  "Camión baranda",
  "Tracto remolcadores",
  "Excavadora",
  "Retroexcavadora",
  "Volquete",
  "Tráiler",
  "Carretas",
  "Bombona",
  "Perforadora",
  "Otro",
];

/** Punto de partida por tipo, en litros -- NO es el dato real de ninguna
 *  unidad. Son capacidades de catálogo de la industria, para que el campo
 *  no arranque vacío al dar de alta; hay que confirmarlas contra la ficha
 *  técnica de cada máquina antes de guardar.
 *
 *  Rango real que existe, para dimensionar cuánto varían: camioneta 70-80,
 *  volquete 200-400, tráiler 300-800 (a veces dos tanques), excavadora
 *  300-640, cargador 250-440, perforadora 150-800 (el más variable). */
const CAPACIDAD_SUGERIDA_L: Record<string, number> = {
  Camioneta: 80,
  "Cargador frontal": 300,
  Excavadora: 400,
  Volquete: 300,
  Tráiler: 400,
  Perforadora: 300,
};

const ETIQUETA_TIPO_MEDIDOR: Record<"" | "horometro" | "odometro", string> = {
  "": "No configurado",
  horometro: "Horómetro (horas de motor)",
  odometro: "Odómetro (kilometraje)",
};

export default function EquiposTable() {
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [enviando, setEnviando] = useState(false);

  // El cliente_uuid se fija al ABRIR el modal para CREAR (no al apretar el
  // botón): un doble tap en la tablet antes del re-render mandaría DOS
  // claves distintas si se generara en el submit, y el servidor no tendría
  // forma de distinguir eso de dos equipos legítimos. Editar no usa
  // idempotencia (sobreescribe campos existentes), así que abrir el modal
  // para editar no toca este valor -- ver el mismo comentario en
  // CombustiblePanel.tsx.
  const [clienteUuid, setClienteUuid] = useState("");

  // El texto de la sugerencia de consumo (5ª auditoría). Se muestra, NUNCA
  // se aplica solo: la muestra puede incluir el robo que se quiere detectar.
  const [sugerenciaConsumo, setSugerenciaConsumo] = useState<string | null>(null);

  // Sedes y grifos internos (0097): con uno solo, nada de esto se ve. El grifo
  // del alta va APARTE del formulario: el PUT manda el formulario entero y el
  // servidor rechaza un grifo ahí (cambiarlo es "Mover de grifo").
  const grifosInternos = useSedes();
  const [grifoAlta, setGrifoAlta] = useState("");
  const [filtroGrifo, setFiltroGrifo] = useState("");
  const [equipoAMover, setEquipoAMover] = useState<Equipo | null>(null);
  const [formData, setFormData] = useState({
    placa_codigo: "",
    tipo: TIPOS_COMUNES[0],
    marca: "",
    modelo: "",
    tipo_medidor: "" as "" | "horometro" | "odometro",
    capacidad_tanque: "",
    capacidad_tanque_unidad: "L" as "gal" | "L",
    consumo_maximo_l: "",
    conductor_nombre: "",
    conductor_dni: "",
  });

  const fetchEquipos = useCallback(async (paginaAConsultar: number) => {
    try {
      const res = await apiFetch(`/api/erp/equipos?page=${paginaAConsultar}&pageSize=50`);
      const body = await res.json();
      setEquipos(Array.isArray(body.data) ? body.data : []);
      setTotalPages(body.pagination?.totalPages ?? 1);
      setLoading(false);
    } catch (err) {
      console.error("Error al obtener equipos:", err);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar/cambiar de página (setLoading(true)
    // -> fetch -> setLoading(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchEquipos(page);
  }, [page, fetchEquipos]);

  // Cuando la cola offline termina de drenar, los equipos que se dieron de
  // alta sin señal ya existen del lado del servidor -- recargar es lo que
  // hace que aparezcan en el listado sin que el operario tenga que
  // refrescar a mano.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) fetchEquipos(page);
    });
  }, [page, fetchEquipos]);

  /** Pide al servidor el consumo sugerido para ESTE equipo, con su muestra.
   *  Igual que el asistente de umbrales del tanque: propone, no aplica. */
  const sugerirConsumo = async (equipoId: number) => {
    setSugerenciaConsumo("Calculando...");
    try {
      const res = await apiFetch(`/api/erp/combustible/equipos/${equipoId}/sugerencia-consumo`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        setSugerenciaConsumo("No se pudo calcular la sugerencia.");
        return;
      }
      if (!body.muestraSuficiente) {
        setSugerenciaConsumo(
          `Todavía no alcanza: hay ${body.tamanioMuestra} carga(s) con medidor y hacen falta ` +
            `${body.minimoRequerido}. Con menos, cualquier número sería inventado.`
        );
        return;
      }
      setSugerenciaConsumo(
        `Sugerencia: ${body.sugerido} L/${body.unidadMedida} — calculada con ${body.tamanioMuestra} ` +
          `cargas de esta unidad (consume ${body.promedio} L/${body.unidadMedida} en promedio). ` +
          `Si la unidad venía perdiendo combustible, ese consumo ya está adentro del promedio.`
      );
      setFormData((previo) => ({ ...previo, consumo_maximo_l: String(body.sugerido) }));
    } catch {
      setSugerenciaConsumo("No se pudo calcular la sugerencia.");
    }
  };

  const openEditModal = (e: Equipo) => {
    setEditingId(e.id);
    setSugerenciaConsumo(null);
    setFormData({
      placa_codigo: e.placa_codigo,
      tipo: e.tipo,
      marca: e.marca ?? "",
      modelo: e.modelo ?? "",
      tipo_medidor: e.tipo_medidor ?? "",
      capacidad_tanque: e.capacidad_tanque ?? "",
      consumo_maximo_l: e.consumo_maximo_l ?? "",
      conductor_nombre: e.conductor_nombre ?? "",
      conductor_dni: e.conductor_dni ?? "",
      capacidad_tanque_unidad: e.capacidad_tanque_unidad ?? "L",
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm("¿Estás seguro de que deseas eliminar este equipo?")) return;
    try {
      const res = await apiFetch(`/api/erp/equipos/${id}`, { method: "DELETE" });
      if (res.ok) {
        fetchEquipos(page);
      } else {
        alert("Error: el servidor no permitió eliminar el equipo.");
      }
    } catch {
      alert("Error de conexión con el backend.");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    const url = editingId ? `/api/erp/equipos/${editingId}` : "/api/erp/equipos";
    const method = editingId ? "PUT" : "POST";
    // "" no es un valor válido del enum -- Zod lo rechazaría (esperaba
    // "horometro"/"odometro"/undefined, ver equipos.schema.ts). undefined
    // sí es "no configurado" para el servidor.
    // Capacidad vacía = "sin configurar": los DOS campos tienen que irse
    // como undefined, no solo el número -- el schema los exige de a pares
    // (espejo del CHECK de migrations/0069).
    const capacidadCargada = formData.capacidad_tanque.trim() !== "";
    const datosFormulario = {
      ...formData,
      tipo_medidor: formData.tipo_medidor === "" ? undefined : formData.tipo_medidor,
      capacidad_tanque: capacidadCargada ? Number(formData.capacidad_tanque) : undefined,
      // Vacío = sin configurar = no alerta. Se manda null explícito (y no
      // undefined) para poder QUITARLO: el PUT reemplaza la fila entera.
      consumo_maximo_l:
        formData.consumo_maximo_l.trim() === "" ? null : Number(formData.consumo_maximo_l),
      capacidad_tanque_unidad: capacidadCargada ? formData.capacidad_tanque_unidad : undefined,
      // Vacío = sin cargar, no se manda: el schema los tiene opcionales y un
      // string vacío fallaría el min(1).
      conductor_nombre: formData.conductor_nombre.trim() || undefined,
      conductor_dni: formData.conductor_dni.trim() || undefined,
    };
    // cliente_uuid solo viaja al crear -- editar no pasa por
    // idempotentInsert() del lado del servidor.
    const body = editingId
      ? datosFormulario
      : {
          ...datosFormulario,
          cliente_uuid: clienteUuid,
          // Con un solo grifo lo asigna el servidor (0097).
          grifo_interno_id:
            grifosInternos.hayVarios && grifoAlta !== "" ? Number(grifoAlta) : undefined,
        };
    setEnviando(true);
    try {
      const res = await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        alert(error.error || error.message || "Error: revisa los datos del equipo.");
        return;
      }

      setIsModalOpen(false);
      setEditingId(null);
      setFormData({
        placa_codigo: "",
        tipo: TIPOS_COMUNES[0],
        marca: "",
        modelo: "",
        tipo_medidor: "",
        capacidad_tanque: "",
        capacidad_tanque_unidad: "L",
        consumo_maximo_l: "",
        conductor_nombre: "",
        conductor_dni: "",
      });

      // 202 = no había red y quedó en la cola del dispositivo (ver
      // apiFetch). No se recarga: sin señal el GET también falla, y el
      // equipo todavía no existe del lado del servidor.
      if (res.status === 202) {
        // "en este dispositivo" y no "en este equipo" -- acá "equipo" es el
        // propio recurso que se está creando, "guardado en este equipo"
        // sería ambiguo. Mismo mensaje que el resto de los módulos, solo
        // con ese sustituto.
        alert(
          "Sin conexión: el equipo quedó guardado en este dispositivo y se enviará solo cuando vuelva la señal."
        );
        return;
      }

      fetchEquipos(page);
    } catch {
      alert("Error de conexión con el backend.");
    } finally {
      setEnviando(false);
    }
  };

  const filteredEquipos = equipos.filter(
    (e) =>
      (e.placa_codigo.toLowerCase().includes(searchTerm.toLowerCase()) ||
        e.tipo.toLowerCase().includes(searchTerm.toLowerCase())) &&
      // El filtro por grifo (0097) solo existe con más de un grifo.
      (!grifosInternos.hayVarios ||
        filtroGrifo === "" ||
        e.grifo_interno_id === Number(filtroGrifo))
  );

  if (loading) return <div className="p-20 text-center text-slate-500">Cargando...</div>;

  return (
    <div className="p-2 sm:p-4 lg:p-8 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 lg:gap-6 mb-6 lg:mb-10">
        <div>
          <h1 className="text-lg sm:text-xl lg:text-2xl font-bold text-slate-800 tracking-tight">
            Equipos
          </h1>
          <p className="text-xs sm:text-sm text-slate-500">Vehículos y maquinaria de la flota</p>
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setFormData({
              placa_codigo: "",
              tipo: TIPOS_COMUNES[0],
              marca: "",
              modelo: "",
              tipo_medidor: "",
              capacidad_tanque: "",
              capacidad_tanque_unidad: "L",
              consumo_maximo_l: "",
              conductor_nombre: "",
              conductor_dni: "",
            });
            setGrifoAlta("");
            // Se regenera en cada apertura: si no, el segundo equipo
            // legítimo que se registre reusaría la clave del primero y el
            // servidor devolvería aquel en silencio -- se perdería un
            // registro, que es peor que el duplicado que esto evita.
            setClienteUuid(crypto.randomUUID());
            setIsModalOpen(true);
          }}
          className="flex items-center gap-2 px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
        >
          <Plus className="w-4 h-4 shrink-0" />
          Nuevo Equipo
        </button>
      </div>

      <div className="mb-8">
        <input
          type="text"
          placeholder="Buscar por placa/código o tipo..."
          className="w-full bg-white border border-slate-200 rounded-2xl px-4 sm:px-5 py-3 sm:py-4 text-sm outline-none focus:ring-2 focus:ring-slate-900 transition-all shadow-sm"
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        {grifosInternos.hayVarios && (
          <div className="mt-3 flex items-center gap-2">
            <label htmlFor="filtro-grifo-equipos" className="text-xs font-bold uppercase">
              Grifo
            </label>
            <select
              id="filtro-grifo-equipos"
              className="border border-slate-200 rounded-lg p-2 text-sm bg-white"
              value={filtroGrifo}
              onChange={(e) => setFiltroGrifo(e.target.value)}
            >
              <option value="">Todos</option>
              {grifosInternos.grifosActivos.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.etiqueta}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left border-collapse">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  placa/código
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  tipo
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  marca
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  modelo
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  medidor
                </th>
                {grifosInternos.hayVarios && (
                  <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                    grifo
                  </th>
                )}
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  estado
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                  editar-eliminar
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredEquipos.map((e) => (
                <tr key={e.id} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 font-mono text-xs sm:text-sm font-semibold text-slate-800">
                    {e.placa_codigo}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-600">
                    {e.tipo}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-500">
                    {e.marca || "---"}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-500">
                    {e.modelo || "---"}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-500">
                    {e.tipo_medidor === "horometro"
                      ? "Horómetro"
                      : e.tipo_medidor === "odometro"
                        ? "Odómetro"
                        : "---"}
                  </td>
                  {grifosInternos.hayVarios && (
                    <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-500">
                      {grifosInternos.nombreDeGrifo(e.grifo_interno_id)}
                    </td>
                  )}
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm">
                    <span
                      className={`font-bold ${e.activo ? "text-emerald-600" : "text-slate-400"}`}
                    >
                      {e.activo ? "Activo" : "Inactivo"}
                    </span>
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-right space-x-2">
                    <button
                      onClick={() => openEditModal(e)}
                      className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                      title="Editar"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(e.id)}
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

      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white overflow-x-auto h-full w-full max-w-lg shadow-2xl animate-in zoom-in duration-200">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">{editingId ? "Editar Equipo" : "Nuevo Equipo"}</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                aria-label="Cerrar"
                className="text-slate-400 hover:text-slate-900"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="space-y-1">
                <label
                  htmlFor="equipo-placa-codigo"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Placa / Código
                </label>
                <input
                  id="equipo-placa-codigo"
                  type="text"
                  placeholder="Ej: V-014"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.placa_codigo}
                  onChange={(e) => setFormData({ ...formData, placa_codigo: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="equipo-tipo" className="text-xs font-bold text-slate-500 uppercase">
                  Tipo
                </label>
                <select
                  id="equipo-tipo"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={formData.tipo}
                  onChange={(e) => {
                    const tipo = e.target.value;
                    const sugerida = CAPACIDAD_SUGERIDA_L[tipo];
                    // La sugerencia solo precarga un campo VACÍO: si el
                    // usuario ya escribió una capacidad (o está editando un
                    // equipo que la tenía), cambiar el tipo no se la pisa.
                    const debeSugerir = formData.capacidad_tanque.trim() === "" && sugerida;
                    setFormData({
                      ...formData,
                      tipo,
                      ...(debeSugerir
                        ? {
                            capacidad_tanque: String(sugerida),
                            capacidad_tanque_unidad: "L" as const,
                          }
                        : {}),
                    });
                  }}
                >
                  {TIPOS_COMUNES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              {/* Fase D de combustible (migrations/0069). Vacío = sin
                  configurar, y entonces no se valida sobredespacho para esta
                  unidad -- que es mejor que un número inventado. */}
              <div className="space-y-1">
                <label
                  htmlFor="equipo-capacidad-tanque"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Capacidad de tanque
                </label>
                <div className="flex gap-2">
                  <input
                    id="equipo-capacidad-tanque"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Dejar vacío si no se conoce"
                    className="flex-1 border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.capacidad_tanque}
                    onChange={(e) => setFormData({ ...formData, capacidad_tanque: e.target.value })}
                  />
                  <select
                    aria-label="Unidad de la capacidad de tanque"
                    className="border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formData.capacidad_tanque_unidad}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        capacidad_tanque_unidad: e.target.value as "gal" | "L",
                      })
                    }
                  >
                    <option value="L">L</option>
                    <option value="gal">gal</option>
                  </select>
                </div>
                <p className="text-[11px] text-slate-400">
                  Sirve para avisar cuando un vale despacha más de lo que entra en el tanque. El
                  número sugerido es de catálogo:{" "}
                  <strong>confirmalo contra la ficha técnica de la unidad</strong>. Si no se conoce,
                  mejor dejarlo vacío que poner uno aproximado.
                </p>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="equipo-consumo-maximo"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Consumo máximo
                </label>
                <div className="flex gap-2 items-center">
                  <input
                    id="equipo-consumo-maximo"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Dejar vacío si todavía no se sabe"
                    className="flex-1 border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.consumo_maximo_l}
                    onChange={(e) => setFormData({ ...formData, consumo_maximo_l: e.target.value })}
                  />
                  <span className="text-sm text-slate-500">
                    L / {formData.tipo_medidor === "odometro" ? "km" : "hora"}
                  </span>
                  {editingId !== null && (
                    <button
                      type="button"
                      onClick={() => sugerirConsumo(editingId)}
                      className="text-xs font-semibold text-slate-700 underline"
                      title="Calculado con las cargas anteriores de ESTA unidad"
                    >
                      Sugerir
                    </button>
                  )}
                </div>
                {sugerenciaConsumo && (
                  <p className="text-[11px] text-slate-600">{sugerenciaConsumo}</p>
                )}
                <p className="text-[11px] text-slate-600">
                  Compara los litros cargados contra el trabajo que hizo la unidad. Es el único
                  control que ve el combustible que sale <strong>con vale</strong> y no llega a la
                  máquina: el tanque cuadra igual. Sin dato no alerta; el número se puede sugerir
                  desde el historial, pero <strong>mirá la muestra antes de aceptarlo</strong>: si
                  ya venían robando, el promedio incluye ese robo.
                </p>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="equipo-tipo-medidor"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Tipo de medidor
                </label>
                <select
                  id="equipo-tipo-medidor"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={formData.tipo_medidor}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      tipo_medidor: e.target.value as "" | "horometro" | "odometro",
                    })
                  }
                >
                  {Object.entries(ETIQUETA_TIPO_MEDIDOR).map(([valor, etiqueta]) => (
                    <option key={valor} value={valor}>
                      {etiqueta}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-400">
                  Solo hace falta para despachar combustible de compra externa a este equipo (ruta
                  Bambamarca). Un volquete se mide por horómetro, un tráiler por odómetro.
                </p>
              </div>
              {/* El conductor asignado (0083). Se copia al vale en el momento
                  del despacho, así el consumo por conductor no se reescribe
                  cuando la unidad cambia de chofer. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="equipo-conductor"
                    className="text-xs font-bold text-slate-700 uppercase"
                  >
                    Conductor
                  </label>
                  <input
                    id="equipo-conductor"
                    type="text"
                    placeholder="Nombre y apellidos"
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.conductor_nombre}
                    onChange={(e) => setFormData({ ...formData, conductor_nombre: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="equipo-dni"
                    className="text-xs font-bold text-slate-700 uppercase"
                  >
                    DNI
                  </label>
                  <input
                    id="equipo-dni"
                    type="text"
                    placeholder="Ej: 12345678"
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.conductor_dni}
                    onChange={(e) => setFormData({ ...formData, conductor_dni: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-xs text-slate-600 -mt-2">
                Queda copiado en cada vale que se despache a esta unidad, así el consumo por
                conductor sigue siendo correcto aunque después cambie de chofer.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="equipo-marca"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Marca
                  </label>
                  <input
                    id="equipo-marca"
                    type="text"
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.marca}
                    onChange={(e) => setFormData({ ...formData, marca: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="equipo-modelo"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Modelo
                  </label>
                  <input
                    id="equipo-modelo"
                    type="text"
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.modelo}
                    onChange={(e) => setFormData({ ...formData, modelo: e.target.value })}
                  />
                </div>
              </div>
              {/* Grifo interno (0097): solo con más de uno. En el alta se
                  elige; después se cambia con "Mover de grifo", con motivo. */}
              {grifosInternos.hayVarios &&
                (editingId === null ? (
                  <div className="space-y-1">
                    <label
                      htmlFor="equipo-grifo-interno"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Grifo interno
                    </label>
                    <select
                      id="equipo-grifo-interno"
                      required
                      className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                      value={grifoAlta}
                      onChange={(e) => setGrifoAlta(e.target.value)}
                    >
                      <option value="">Elegir grifo</option>
                      {grifosInternos.grifosActivos.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.etiqueta}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2 text-sm bg-slate-50 border border-slate-200 rounded-xl p-3">
                    <span>
                      <span className="text-xs font-bold text-slate-500 uppercase block">
                        Grifo interno
                      </span>
                      {grifosInternos.nombreDeGrifo(
                        equipos.find((x) => x.id === editingId)?.grifo_interno_id
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setEquipoAMover(equipos.find((x) => x.id === editingId) ?? null)
                      }
                      className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg hover:bg-white"
                    >
                      Mover de grifo
                    </button>
                  </div>
                ))}
              <button
                type="submit"
                disabled={enviando}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-50"
              >
                {editingId ? "Guardar Cambios" : "Registrar Equipo"}
              </button>
            </form>
          </div>
        </div>
      )}
      {equipoAMover && (
        <MoverDeGrifo
          que="equipo"
          id={equipoAMover.id}
          nombre={equipoAMover.placa_codigo}
          grifoActualId={equipoAMover.grifo_interno_id}
          grifos={grifosInternos.grifosActivos}
          onCerrar={() => setEquipoAMover(null)}
          onMovido={() => {
            setEquipoAMover(null);
            grifosInternos.recargar();
            void fetchEquipos(page);
          }}
        />
      )}
    </div>
  );
}
