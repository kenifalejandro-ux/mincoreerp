// Combustible › Viajes › Lugares: el catálogo de orígenes y destinos de los viajes.
// Es una consulta (se mira la lista mientras se sigue trabajando), así que va en ventana
// flotante; agregar y editar un lugar es un formulario y bloquea la ventana con su propio modal.
import { Building2, Fuel, MapPin, Mountain, Pencil, Plus, Power, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../services/apiClient";
import VentanaFlotante from "../comunes/VentanaFlotante";

export type TipoLugar = "mina" | "ciudad" | "abastecimiento";

export interface Lugar {
  id: string;
  nombre: string;
  tipo: TipoLugar | null;
  ubicacion: string | null;
  activo: boolean;
}

const TIPOS: { valor: TipoLugar; etiqueta: string; Icono: typeof Mountain }[] = [
  { valor: "mina", etiqueta: "Mina", Icono: Mountain },
  { valor: "ciudad", etiqueta: "Ciudad", Icono: Building2 },
  { valor: "abastecimiento", etiqueta: "Abastecimiento", Icono: Fuel },
];

const INPUT =
  "w-full bg-[#0D1719] border border-[#334155] rounded-xl p-3 text-sm text-white placeholder:text-[#64748b] focus:outline-none focus:border-[#BADC1E]";
const LABEL = "text-xs font-bold text-[#cbd5e1] uppercase";

const normalizar = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function InsigniaTipo({ tipo }: { tipo: TipoLugar | null }) {
  const t = TIPOS.find((x) => x.valor === tipo);
  if (!t) return <span className="text-xs text-amber-400/80">Sin tipo</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full text-[#e2e8f0]">
      <t.Icono className="w-3.5 h-3.5 text-[#BADC1E]" aria-hidden /> {t.etiqueta}
    </span>
  );
}

/** `original` es lo que tenía el lugar al abrir el formulario: al editar solo se manda lo que cambió
 *  (si no, se pisaría en silencio lo que otra persona cambió mientras tanto). */
type Formulario = {
  id: string | null;
  nombre: string;
  tipo: TipoLugar | "";
  ubicacion: string;
  original?: { nombre: string; tipo: TipoLugar | ""; ubicacion: string };
};
const FORM_VACIO: Formulario = { id: null, nombre: "", tipo: "", ubicacion: "" };

interface Props {
  lugares: Lugar[];
  /** Ya llegó la lista al menos una vez: sin esto no se puede decir "no hay lugares". */
  listos: boolean;
  errorCarga: boolean;
  onRecargar: () => Promise<void>;
  /** Agregar, editar y activar/desactivar: lo ve quien tiene el permiso de Lugares. */
  puedeGestionar: boolean;
  onCerrar: () => void;
}

export function LugaresPanel({
  lugares,
  listos,
  errorCarga,
  onRecargar,
  puedeGestionar,
  onCerrar,
}: Props) {
  const [busqueda, setBusqueda] = useState("");
  const [form, setForm] = useState<Formulario | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mientras una fila se activa o desactiva su botón queda bloqueado (un doble clic la dejaría igual).
  const [cambiando, setCambiando] = useState<string | null>(null);

  const activos = lugares.filter((l) => l.activo).length;
  const inactivos = lugares.length - activos;
  const visibles = useMemo(() => {
    const q = normalizar(busqueda.trim());
    const filtrados = q
      ? lugares.filter((l) =>
          normalizar(
            `${l.nombre} ${l.ubicacion ?? ""} ${TIPOS.find((t) => t.valor === l.tipo)?.etiqueta ?? ""}`
          ).includes(q)
        )
      : lugares;
    // Los activos primero; el orden por nombre que trae el servidor se conserva dentro de cada grupo.
    return [...filtrados].sort((a, b) => Number(b.activo) - Number(a.activo));
  }, [lugares, busqueda]);

  useEffect(() => {
    if (!form) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !guardando) setForm(null);
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [form, guardando]);

  const abrirForm = (f: Formulario) => {
    setError(null);
    setForm(f);
  };

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || guardando) return;
    const nombre = form.nombre.trim();
    if (!nombre) return setError("Escribe el nombre del lugar.");
    // El tipo es obligatorio al agregar; al editar un lugar viejo sin tipo se puede dejar así.
    if (!form.id && !form.tipo) return setError("Elige qué tipo de lugar es.");
    setGuardando(true);
    setError(null);
    try {
      const ubicacion = form.ubicacion.trim();
      const o = form.original;
      const cuerpo: Record<string, unknown> = {};
      if (!o || nombre !== o.nombre.trim()) cuerpo.nombre = nombre;
      if (!o || ubicacion !== o.ubicacion.trim()) cuerpo.ubicacion = ubicacion;
      if (form.tipo && (!o || form.tipo !== o.tipo)) cuerpo.tipo = form.tipo;
      if (o && Object.keys(cuerpo).length === 0) {
        setForm(null); // no cambió nada: no hay nada que mandar
        return;
      }
      const res = await apiFetch(
        form.id ? `/api/erp/combustible/lugares/${form.id}` : "/api/erp/combustible/lugares",
        {
          method: form.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cuerpo),
        }
      );
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(r.error || r.message || r.errors?.[0]?.message || "No se pudo guardar.");
        return;
      }
      setForm(null);
      await onRecargar();
    } finally {
      setGuardando(false);
    }
  };

  const cambiarEstado = async (l: Lugar) => {
    if (cambiando) return;
    setCambiando(l.id);
    try {
      const res = await apiFetch(`/api/erp/combustible/lugares/${l.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activo: !l.activo }),
      });
      if (!res.ok) {
        const r = await res.json().catch(() => ({}));
        alert(r.error || r.message || "No se pudo cambiar el estado.");
        return;
      }
      await onRecargar();
    } finally {
      setCambiando(null);
    }
  };

  // Con la lista ya cargada, un fallo al refrescar no la esconde: se avisa y se siguen viendo los últimos datos.
  const hayLista = listos;

  return (
    <VentanaFlotante
      id="combustible-lugares"
      titulo="Lugares"
      subtitulo="Orígenes y destinos de los viajes"
      onCerrar={onCerrar}
      anchoInicial={820}
      altoInicial={480}
    >
      <div className="relative min-h-full p-5 space-y-4 text-[#e2e8f0]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-sm text-[#94a3b8] max-w-md">
            Un catálogo único evita que la misma ruta se cuente dos veces por estar escrita
            distinto. Un lugar desactivado no se ofrece en viajes nuevos, pero sus viajes anteriores
            lo conservan.
          </p>
          {puedeGestionar && (
            <button
              onClick={() => abrirForm(FORM_VACIO)}
              className="flex items-center gap-2 bg-[#BADC1E] text-[#0D1719] font-bold px-4 py-2 rounded-lg hover:brightness-110"
            >
              <Plus className="w-4 h-4" /> Agregar lugar
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-white">Lugares registrados</h4>
            <p className="text-xs text-[#94a3b8]" aria-live="polite">
              {hayLista ? (
                <>
                  {activos} {activos === 1 ? "activo" : "activos"}
                  {inactivos > 0 && (
                    <span className="text-red-400">
                      {" "}
                      · {inactivos} {inactivos === 1 ? "inactivo" : "inactivos"}
                    </span>
                  )}
                </>
              ) : (
                "Cargando…"
              )}
            </p>
          </div>
          <label className="relative block w-full sm:w-72">
            <span className="sr-only">Buscar lugar</span>
            <Search
              className="w-4 h-4 text-[#64748b] absolute left-3 top-1/2 -translate-y-1/2"
              aria-hidden
            />
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar lugar…"
              className={`${INPUT} pl-9`}
            />
          </label>
        </div>

        {errorCarga && (
          <div className="flex items-center justify-between gap-3 border border-red-500/40 bg-red-500/10 text-red-300 text-sm rounded-lg p-3">
            <span>
              {listos
                ? "No se pudo actualizar la lista: se muestran los últimos datos."
                : "No se pudo cargar la lista de lugares."}
            </span>
            <button
              onClick={() => void onRecargar()}
              className="border border-red-400/50 rounded-lg px-3 py-1 hover:text-white"
            >
              Reintentar
            </button>
          </div>
        )}

        {hayLista && (
          <div className="bg-[#192526] border border-[#2a2e37] rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase text-[#94a3b8]">
                  <th className="p-3">Lugar</th>
                  <th className="p-3">Tipo</th>
                  <th className="p-3">Ubicación</th>
                  <th className="p-3">Estado</th>
                  {puedeGestionar && <th className="p-3 text-right">Acciones</th>}
                </tr>
              </thead>
              <tbody>
                {visibles.map((l) => (
                  <tr key={l.id} className="border-t border-[#2a2e37]">
                    <td className="p-3">
                      <div
                        className={`flex items-center gap-2.5 font-semibold ${l.activo ? "text-white" : "text-[#94a3b8]"}`}
                      >
                        <span
                          className={`flex items-center justify-center w-8 h-8 rounded-lg ${
                            l.activo ? "text-[#BADC1E]" : "text-red-500"
                          }`}
                        >
                          <MapPin className="w-4 h-4" aria-hidden />
                        </span>
                        {l.nombre}
                      </div>
                    </td>
                    <td className="p-3">
                      <InsigniaTipo tipo={l.tipo} />
                    </td>
                    <td className="p-3 text-[#cbd5e1]">
                      {l.ubicacion || <span className="text-[#64748b]">—</span>}
                    </td>
                    <td className="p-3">
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${
                          l.activo
                            ? "border-[#BADC1E]/40 text-[#BADC1E] bg-[#BADC1E]/10"
                            : "border-red-500/40 text-red-400 bg-red-500/10"
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${l.activo ? "bg-[#BADC1E]" : "bg-red-400"}`}
                        />
                        {l.activo ? "Activo" : "Inactivo"}
                      </span>
                    </td>
                    {puedeGestionar && (
                      <td className="p-3">
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() =>
                              abrirForm({
                                id: l.id,
                                nombre: l.nombre,
                                tipo: l.tipo ?? "",
                                ubicacion: l.ubicacion ?? "",
                                original: {
                                  nombre: l.nombre,
                                  tipo: l.tipo ?? "",
                                  ubicacion: l.ubicacion ?? "",
                                },
                              })
                            }
                            aria-label={`Editar ${l.nombre}`}
                            title="Editar"
                            className="p-2 rounded-lg text-[#cbd5e1] hover:text-white"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => void cambiarEstado(l)}
                            disabled={cambiando !== null}
                            aria-label={`${l.activo ? "Desactivar" : "Activar"} ${l.nombre}`}
                            title={l.activo ? "Desactivar" : "Activar"}
                            className={`p-2 rounded-lg text-[#cbd5e1] disabled:opacity-40 ${
                              l.activo ? "hover:text-red-500" : "hover:text-[#BADC1E]"
                            }`}
                          >
                            <Power className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {visibles.length === 0 && (
                  <tr>
                    <td colSpan={puedeGestionar ? 5 : 4} className="p-6 text-center text-[#94a3b8]">
                      {lugares.length === 0
                        ? "Todavía no hay lugares. Agrega el primero."
                        : "Ningún lugar coincide con la búsqueda."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {form && (
          <div className="absolute inset-0 z-10 bg-[#0D1719]/90 backdrop-blur-sm flex justify-center items-start p-4 overflow-y-auto">
            <form
              onSubmit={guardar}
              role="dialog"
              aria-modal="true"
              aria-label={form.id ? "Editar lugar" : "Agregar lugar"}
              className="bg-[#192526] border border-[#2a2e37] w-full max-w-md rounded-2xl shadow-2xl mt-6"
            >
              <div className="p-5 border-b border-[#2a2e37] flex justify-between items-center">
                <h4 className="text-lg font-bold text-white">
                  {form.id ? "Editar lugar" : "Agregar lugar"}
                </h4>
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  disabled={guardando}
                  aria-label="Cerrar"
                  className="text-[#94a3b8] hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <div className="space-y-1">
                  <label htmlFor="lugar-nombre" className={LABEL}>
                    Nombre
                  </label>
                  <input
                    id="lugar-nombre"
                    autoFocus
                    maxLength={80}
                    placeholder="Ej. Huamachuco"
                    className={INPUT}
                    value={form.nombre}
                    onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="lugar-tipo" className={LABEL}>
                    Tipo
                  </label>
                  <select
                    id="lugar-tipo"
                    className={INPUT}
                    value={form.tipo}
                    onChange={(e) => setForm({ ...form, tipo: e.target.value as TipoLugar | "" })}
                  >
                    {/* Un lugar que ya tiene tipo no puede volver a "sin tipo": solo se ofrece a los viejos. */}
                    {(!form.id || !form.original?.tipo) && (
                      <option value="">{form.id ? "Sin tipo" : "Elegir…"}</option>
                    )}
                    {TIPOS.map((t) => (
                      <option key={t.valor} value={t.valor}>
                        {t.etiqueta}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor="lugar-ubicacion" className={LABEL}>
                    Ubicación <span className="normal-case font-normal">(opcional)</span>
                  </label>
                  <input
                    id="lugar-ubicacion"
                    maxLength={120}
                    placeholder="Ej. Hualgayoc, Cajamarca"
                    className={INPUT}
                    value={form.ubicacion}
                    onChange={(e) => setForm({ ...form, ubicacion: e.target.value })}
                  />
                </div>
                {error && (
                  <p role="alert" className="text-sm text-red-400">
                    {error}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={guardando || !form.nombre.trim()}
                  className="w-full bg-[#BADC1E] text-[#0D1719] font-bold px-4 py-3 rounded-xl hover:brightness-110 disabled:opacity-50"
                >
                  {guardando ? "Guardando…" : "Guardar"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </VentanaFlotante>
  );
}
