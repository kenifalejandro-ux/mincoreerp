// Tanquetas / cubetas (migración 0111): depósitos chicos (280 gal) sin varilla,
// con código propio. Se llenan con el excedente de una recepción que no cabe
// en el tanque, y salen a ruta como previsión.
//
// El saldo lo calcula el servidor (entradas menos salidas): acá solo se dibuja.
// El cilindro es el mismo lenguaje visual que "Nivel de tanque", en chico,
// uno por tanqueta. Los permisos los decide el servidor; el front solo evita
// dibujar un botón que iba a dar 403.
import { History, Pencil, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAuth } from "../../context/AuthContext";
import { apiFetch } from "../../services/apiClient";
import { useSedes } from "../comunes/useSedes";
import VentanaFlotante from "../comunes/VentanaFlotante";

interface Tanqueta {
  id: string;
  grifo_interno_id: number;
  grifo_nombre: string;
  codigo: string;
  capacidad: string;
  activa: boolean;
  motivo_baja: string | null;
  saldo: string;
  libre: string;
}

/** Un movimiento de la tanqueta (0111/0114): lo que entró (excedente de una
 *  recepción, previsión desde el tanque) y lo que salió (carga en ruta). */
interface MovimientoTanqueta {
  tipo: "excedente" | "prevision" | "carga_ruta";
  id: string;
  cantidad: string;
  fecha: string;
  anulada_en: string | null;
  tanque_codigo: string | null;
  recepcion_id: string | null;
  equipo: string | null;
  lectura_horometro: string | null;
  lectura_odometro: string | null;
  serie_talonario: string | null;
  n_vale: number | null;
  usuario: string | null;
}

const describirMovimiento = (m: MovimientoTanqueta) => {
  if (m.tipo === "excedente") {
    return `Excedente de la recepción #${m.recepcion_id} (${m.tanque_codigo})`;
  }
  if (m.tipo === "prevision") {
    return `Previsión desde ${m.tanque_codigo} · vale ${m.serie_talonario}-${m.n_vale}`;
  }
  const medidor =
    m.lectura_horometro !== null
      ? ` · horómetro ${Number(m.lectura_horometro).toLocaleString("es-PE")}`
      : m.lectura_odometro !== null
        ? ` · odómetro ${Number(m.lectura_odometro).toLocaleString("es-PE")}`
        : "";
  return `Carga en ruta a ${m.equipo ?? "una unidad"}${medidor}`;
};

const formatear = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 2 });

function CilindroTanqueta({ t }: { t: Tanqueta }) {
  const capacidad = Number(t.capacidad);
  const saldo = Number(t.saldo);
  const pct = capacidad > 0 ? Math.min(100, Math.max(0, (saldo / capacidad) * 100)) : 0;
  // Lleno = verde (ya no admite excedente), a medias = ámbar, vacía = gris.
  const [color, claro, oscuro] =
    pct >= 99.5
      ? ["#a3e635", "#ecfccb", "#3f6212"]
      : pct > 0
        ? ["#f59e0b", "#fde68a", "#78350f"]
        : ["#475569", "#94a3b8", "#1e293b"];
  return (
    <div className="relative w-24 h-36">
      <div className="absolute inset-0 rounded-t-[28px] rounded-b-2xl border-4 border-[#334155] bg-[#0f1115] shadow-[inset_0_0_14px_rgba(0,0,0,0.8)]" />
      <div className="absolute inset-1 rounded-t-[24px] rounded-b-xl overflow-hidden">
        <div
          className="absolute bottom-0 w-full transition-all duration-700 ease-out"
          style={{
            height: `${pct}%`,
            background: `linear-gradient(90deg, ${oscuro} 0%, ${color} 28%, ${claro} 42%, ${color} 58%, ${oscuro} 100%)`,
          }}
        >
          <div className="absolute top-0 left-0 w-full h-1.5 bg-white/40" />
        </div>
      </div>
      <div className="absolute inset-0 rounded-t-[28px] rounded-b-2xl bg-gradient-to-r from-white/10 via-transparent to-black/40 pointer-events-none" />
    </div>
  );
}

const VACIO = { grifo_interno_id: "", codigo: "", capacidad: "280", motivo: "", activa: true };

export default function TanquetasPanel() {
  const { usuario } = useAuth();
  const { grifosActivos, hayVarios, nombreDeGrifo } = useSedes();
  const [tanquetas, setTanquetas] = useState<Tanqueta[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroGrifo, setFiltroGrifo] = useState("");
  // null = cerrado; "nueva" = alta; id = edición.
  const [formAbierto, setFormAbierto] = useState<"nueva" | string | null>(null);
  const [form, setForm] = useState(VACIO);
  const [guardando, setGuardando] = useState(false);
  const [historialDe, setHistorialDe] = useState<Tanqueta | null>(null);
  const [historial, setHistorial] = useState<MovimientoTanqueta[]>([]);

  const permite = (accion: "nueva" | "editar") => {
    const override = usuario?.permisosPestanas?.[`combustible:tanquetas:${accion}`];
    if (override !== undefined) return override;
    return usuario?.rol === "admin" || usuario?.rol === "operador";
  };

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await apiFetch("/api/erp/combustible/tanquetas");
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? body?.message ?? "No se pudieron cargar las tanquetas.");
        return;
      }
      setError(null);
      setTanquetas(Array.isArray(body) ? body : []);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  const abrirNueva = () => {
    setForm({
      ...VACIO,
      grifo_interno_id: grifosActivos.length === 1 ? String(grifosActivos[0].id) : "",
    });
    setFormAbierto("nueva");
  };

  const abrirEdicion = (t: Tanqueta) => {
    setForm({
      grifo_interno_id: String(t.grifo_interno_id),
      codigo: t.codigo,
      capacidad: String(Number(t.capacidad)),
      motivo: "",
      activa: t.activa,
    });
    setFormAbierto(t.id);
  };

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guardando || formAbierto === null) return;
    setGuardando(true);
    try {
      const esNueva = formAbierto === "nueva";
      const res = await apiFetch(
        esNueva
          ? "/api/erp/combustible/tanquetas"
          : `/api/erp/combustible/tanquetas/${formAbierto}`,
        {
          method: esNueva ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            esNueva
              ? {
                  grifo_interno_id: Number(form.grifo_interno_id),
                  codigo: form.codigo.trim() || undefined,
                  capacidad: Number(form.capacidad),
                }
              : {
                  codigo: form.codigo.trim() || undefined,
                  capacidad: Number(form.capacidad),
                  activa: form.activa,
                  motivo: form.motivo.trim() || undefined,
                }
          ),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(body.error || body.errors?.[0]?.message || "No se pudo guardar la tanqueta.");
        return;
      }
      setFormAbierto(null);
      await cargar();
    } finally {
      setGuardando(false);
    }
  };

  const verHistorial = async (t: Tanqueta) => {
    setHistorialDe(t);
    setHistorial([]);
    const res = await apiFetch(`/api/erp/combustible/tanquetas/${t.id}/historial`);
    const body = await res.json().catch(() => []);
    if (res.ok && Array.isArray(body)) setHistorial(body);
  };

  const visibles = tanquetas.filter(
    (t) => filtroGrifo === "" || String(t.grifo_interno_id) === filtroGrifo
  );
  const activas = visibles.filter((t) => t.activa);
  const totalSaldo = activas.reduce((s, t) => s + Number(t.saldo), 0);
  const totalCapacidad = activas.reduce((s, t) => s + Number(t.capacidad), 0);
  const editando = formAbierto !== null && formAbierto !== "nueva";
  const original = editando ? tanquetas.find((t) => t.id === formAbierto) : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Tanquetas</h2>
          <p className="text-sm text-[#94a3b8]">
            Depósitos de 280 gal: se llenan con el excedente de una recepción o como previsión desde
            el tanque, y salen a ruta. El saldo es lo que entró menos lo que se cargó en ruta.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {hayVarios && (
            <select
              aria-label="Filtrar por sede"
              value={filtroGrifo}
              onChange={(e) => setFiltroGrifo(e.target.value)}
              className="bg-[#0D1719] border border-[#334155] rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="">Todas las sedes</option>
              {grifosActivos.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.etiqueta}
                </option>
              ))}
            </select>
          )}
          {permite("nueva") && (
            <button
              onClick={abrirNueva}
              className="flex items-center gap-2 bg-[#BADC1E] text-[#0D1719] font-bold px-4 py-2 rounded-lg hover:brightness-110"
            >
              <Plus className="w-4 h-4" /> Nueva tanqueta
            </button>
          )}
        </div>
      </div>

      {activas.length > 0 && (
        <div className="bg-[#192526] border border-[#2a2e37] rounded-lg px-5 py-4 flex flex-wrap gap-6 text-sm">
          <span className="text-[#94a3b8]">
            Activas: <strong className="text-white">{activas.length}</strong>
          </span>
          <span className="text-[#94a3b8]">
            Combustible en tanquetas:{" "}
            <strong className="text-white font-mono">
              {formatear(totalSaldo)} / {formatear(totalCapacidad)} gal
            </strong>
          </span>
          <span className="text-[#94a3b8]">
            Espacio libre:{" "}
            <strong className="text-white font-mono">
              {formatear(totalCapacidad - totalSaldo)} gal
            </strong>
          </span>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
      {cargando && tanquetas.length === 0 && <p className="text-sm text-[#94a3b8]">Cargando...</p>}
      {!cargando && !error && visibles.length === 0 && (
        <p className="text-sm text-[#94a3b8]">
          Todavía no hay tanquetas registradas.
          {permite("nueva") && " Dalas de alta con su código para poder llenarlas con excedentes."}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {visibles.map((t) => {
          const capacidad = Number(t.capacidad);
          const saldo = Number(t.saldo);
          const pct = capacidad > 0 ? (saldo / capacidad) * 100 : 0;
          return (
            <div
              key={t.id}
              className={`bg-[#192526] border border-[#2a2e37] rounded-lg p-4 flex gap-4 ${t.activa ? "" : "opacity-60"}`}
            >
              <CilindroTanqueta t={t} />
              <div className="flex-1 min-w-0 flex flex-col">
                <p className="font-mono font-bold text-white truncate">{t.codigo}</p>
                <p className="text-[11px] text-[#64748b] truncate">
                  {hayVarios ? nombreDeGrifo(t.grifo_interno_id) : t.grifo_nombre}
                </p>
                {!t.activa && (
                  <p className="text-[11px] text-red-400 mt-1">De baja: {t.motivo_baja}</p>
                )}
                <div className="mt-3 font-mono text-white">
                  <span className="text-2xl font-bold">{formatear(saldo)}</span>
                  <span className="text-xs text-[#94a3b8]"> / {formatear(capacidad)} gal</span>
                </div>
                <p className="text-xs font-mono text-[#94a3b8]">
                  {pct.toFixed(0)}% · libre {formatear(Number(t.libre))} gal
                </p>
                <div className="mt-auto pt-3 flex gap-2">
                  <button
                    onClick={() => verHistorial(t)}
                    aria-label={`Historial de ${t.codigo}`}
                    title="Historial"
                    className="p-2 rounded border border-[#334155] text-[#94a3b8] hover:text-white"
                  >
                    <History className="w-4 h-4" />
                  </button>
                  {permite("editar") && (
                    <button
                      onClick={() => abrirEdicion(t)}
                      aria-label={`Editar ${t.codigo}`}
                      title="Editar"
                      className="p-2 rounded border border-[#334155] text-[#94a3b8] hover:text-white"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {formAbierto !== null && (
        <div className="fixed inset-0 bg-[#0D1719]/90 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">
                {editando ? `Editar ${original?.codigo ?? "tanqueta"}` : "Nueva tanqueta"}
              </h3>
              <button
                onClick={() => setFormAbierto(null)}
                aria-label="Cerrar"
                className="text-slate-400 hover:text-slate-900"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={guardar} className="p-6 space-y-4">
              {!editando && (
                <div className="space-y-1">
                  <label
                    htmlFor="tanqueta-grifo"
                    className="text-xs font-bold text-slate-700 uppercase"
                  >
                    Sede donde se llena
                  </label>
                  <select
                    id="tanqueta-grifo"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm"
                    value={form.grifo_interno_id}
                    onChange={(e) => setForm({ ...form, grifo_interno_id: e.target.value })}
                  >
                    <option value="">Elegir...</option>
                    {grifosActivos.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.etiqueta}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-600">
                    Solo recibe excedente de los tanques de esta sede.
                  </p>
                </div>
              )}
              <div className="space-y-1">
                <label
                  htmlFor="tanqueta-codigo"
                  className="text-xs font-bold text-slate-700 uppercase"
                >
                  Código {editando ? "" : "(opcional)"}
                </label>
                <input
                  id="tanqueta-codigo"
                  maxLength={30}
                  placeholder={editando ? "" : "Si la dejás vacía: TQT-001, TQT-002..."}
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm"
                  value={form.codigo}
                  onChange={(e) => setForm({ ...form, codigo: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="tanqueta-capacidad"
                  className="text-xs font-bold text-slate-700 uppercase"
                >
                  Capacidad (gal)
                </label>
                <input
                  id="tanqueta-capacidad"
                  type="number"
                  min={1}
                  step="0.01"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm"
                  value={form.capacidad}
                  onChange={(e) => setForm({ ...form, capacidad: e.target.value })}
                />
              </div>
              {editando && (
                <>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={form.activa}
                      onChange={(e) => setForm({ ...form, activa: e.target.checked })}
                    />
                    Activa
                  </label>
                  {original?.activa && !form.activa && (
                    <div className="space-y-1">
                      <label
                        htmlFor="tanqueta-motivo"
                        className="text-xs font-bold text-slate-700 uppercase"
                      >
                        Motivo de la baja
                      </label>
                      <input
                        id="tanqueta-motivo"
                        required
                        maxLength={500}
                        className="w-full border border-slate-200 rounded-xl p-3 text-sm"
                        value={form.motivo}
                        onChange={(e) => setForm({ ...form, motivo: e.target.value })}
                      />
                      <p className="text-xs text-slate-600">
                        Solo se puede dar de baja vacía (saldo 0).
                      </p>
                    </div>
                  )}
                </>
              )}
              <button
                type="submit"
                disabled={guardando}
                className="w-full bg-sky-600 text-white font-bold py-3 rounded-2xl hover:bg-sky-700 disabled:opacity-50"
              >
                {guardando ? "Guardando..." : "Guardar"}
              </button>
            </form>
          </div>
        </div>
      )}

      {historialDe && (
        <VentanaFlotante
          id="combustible-tanqueta-historial"
          titulo={`Historial de ${historialDe.codigo}`}
          subtitulo="Lo que entró (excedente o previsión desde el tanque) y lo que se cargó en ruta"
          onCerrar={() => setHistorialDe(null)}
          anchoInicial={640}
          altoInicial={460}
        >
          {historial.length === 0 ? (
            <p className="p-4 text-sm text-[#94a3b8]">Sin movimientos todavía.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase text-[#94a3b8]">
                  <th className="p-2">Fecha</th>
                  <th className="p-2">Movimiento</th>
                  <th className="p-2">Quién</th>
                  <th className="p-2 text-right">Entrada</th>
                  <th className="p-2 text-right">Salida</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((h) => (
                  <tr
                    key={`${h.tipo}-${h.id}`}
                    className={`border-t border-[#2a2e37] ${h.anulada_en ? "line-through opacity-60" : ""}`}
                  >
                    <td className="p-2 whitespace-nowrap">
                      {new Date(h.fecha).toLocaleString("es-PE")}
                    </td>
                    <td className="p-2">
                      {describirMovimiento(h)}
                      {h.anulada_en && " · anulado"}
                    </td>
                    <td className="p-2">{h.usuario ?? "—"}</td>
                    <td className="p-2 text-right font-mono text-emerald-400">
                      {h.tipo === "carga_ruta" ? "" : formatear(Number(h.cantidad))}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {h.tipo === "carga_ruta" ? formatear(Number(h.cantidad)) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </VentanaFlotante>
      )}
    </div>
  );
}
