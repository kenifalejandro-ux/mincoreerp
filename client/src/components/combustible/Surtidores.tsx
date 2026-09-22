// Surtidores (migración 0098): el aparato del grifo interno por el que sale el
// combustible, con su propio totalizador.
//
// Un tanque puede tener varios surtidores, y un surtidor puede alimentar a más
// de un tanque del mismo grifo. La conexión tiene historia: se conecta y se
// desconecta con motivo, desde ahora, y lo que ya pasó queda en el surtidor
// donde pasó.
//
// Los permisos los decide el servidor (todo esto es del admin): acá se
// muestra el error que devuelva.
import { useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";
import { useSedes } from "../comunes/useSedes";
import VentanaFlotante from "../comunes/VentanaFlotante";

interface Surtidor {
  id: number;
  grifo_interno_id: number;
  nombre: string;
  activo: boolean;
  motivo_baja: string | null;
  usa_totalizador: boolean;
  totalizador_tolerancia: string;
  totalizador_actual: string;
  tanques: { conexion_id: number; combustible_id: number; codigo: string; tanque_nombre: string }[];
}

interface Conexion {
  id: number;
  codigo: string;
  tanque_nombre: string;
  conectado_en: string;
  desconectado_en: string | null;
  motivo_conexion: string | null;
  motivo_desconexion: string | null;
  conectado_por: string | null;
  desconectado_por: string | null;
}

export interface TanqueParaSurtidor {
  id: number;
  codigo: string;
  tanque_nombre: string;
  grifo_interno_id: number;
  activo: boolean;
}

const fecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" }) : "—";

/** La conexión inicial de cada tanque es "desde siempre" (1900-01-01). */
const desde = (iso: string) => (new Date(iso).getFullYear() <= 1900 ? "desde siempre" : fecha(iso));

async function enviar(url: string, metodo: "POST" | "PUT" | "PATCH", cuerpo: object) {
  const res = await apiFetch(url, {
    method: metodo,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.errors?.[0]?.message || b.error || b.message || `HTTP ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

export default function VentanaSurtidores({
  tanques,
  onCerrar,
  onCambio,
}: {
  tanques: TanqueParaSurtidor[];
  onCerrar: () => void;
  /** Los tanques traen sus surtidores: el panel los recarga. */
  onCambio: () => void;
}) {
  const grifos = useSedes();
  const [surtidores, setSurtidores] = useState<Surtidor[] | null>(null);
  const [vuelta, setVuelta] = useState(0);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nuevo, setNuevo] = useState({ grifo: "", nombre: "", usa: false, tolerancia: "1" });
  const [aConectar, setAConectar] = useState<Record<number, string>>({});
  const [historial, setHistorial] = useState<{ id: number; filas: Conexion[] } | null>(null);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const res = await apiFetch("/api/erp/combustible/surtidores");
      const filas = res.ok ? ((await res.json()) as Surtidor[]) : [];
      if (vigente) setSurtidores(filas);
    })();
    return () => {
      vigente = false;
    };
  }, [vuelta]);

  const ejecutar = async (accion: () => Promise<unknown>) => {
    if (trabajando) return;
    setTrabajando(true);
    setError(null);
    try {
      await accion();
      setVuelta((v) => v + 1);
      setHistorial(null);
      onCambio();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar");
    } finally {
      setTrabajando(false);
    }
  };

  const pedir = (pregunta: string, inicial = "") => {
    const r = window.prompt(pregunta, inicial);
    return r && r.trim() !== "" ? r.trim() : null;
  };

  // Con un solo grifo en la empresa, no se pregunta en cuál va.
  const grifoDelNuevo =
    grifos.hayVarios || grifos.grifosActivos.length === 0
      ? Number(nuevo.grifo)
      : grifos.grifosActivos[0].id;

  const crear = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nuevo.nombre.trim() || !grifoDelNuevo) return;
    void ejecutar(async () => {
      await enviar("/api/erp/combustible/surtidores", "POST", {
        grifo_interno_id: grifoDelNuevo,
        nombre: nuevo.nombre.trim(),
        usa_totalizador: nuevo.usa,
        totalizador_tolerancia: Number(nuevo.tolerancia),
      });
      setNuevo({ grifo: "", nombre: "", usa: false, tolerancia: "1" });
    });
  };

  const cambiarTotalizador = (s: Surtidor, usa: boolean) => {
    // Apagarlo es aflojar la vigilancia: pide motivo y avisa por correo.
    const motivo = !usa
      ? pedir(`¿Por qué se deja de anotar el totalizador de "${s.nombre}"?`)
      : null;
    if (!usa && !motivo) return;
    void ejecutar(() =>
      enviar(`/api/erp/combustible/surtidores/${s.id}`, "PUT", {
        usa_totalizador: usa,
        ...(motivo ? { motivo } : {}),
      })
    );
  };

  const cambiarTolerancia = (s: Surtidor) => {
    const valor = pedir("Diferencia tolerada (en la unidad del tanque):", s.totalizador_tolerancia);
    if (valor === null || Number.isNaN(Number(valor))) return;
    void ejecutar(() =>
      enviar(`/api/erp/combustible/surtidores/${s.id}`, "PUT", {
        totalizador_tolerancia: Number(valor),
      })
    );
  };

  const renombrar = (s: Surtidor) => {
    const nombre = pedir("Nuevo nombre:", s.nombre);
    if (!nombre || nombre === s.nombre) return;
    void ejecutar(() => enviar(`/api/erp/combustible/surtidores/${s.id}`, "PUT", { nombre }));
  };

  const conectar = (s: Surtidor) => {
    const combustibleId = Number(aConectar[s.id] ?? "");
    if (!combustibleId) return;
    const motivo = pedir("¿Por qué se conecta este tanque?");
    if (!motivo) return;
    void ejecutar(() =>
      enviar(`/api/erp/combustible/surtidores/${s.id}/conexiones`, "POST", {
        combustible_id: combustibleId,
        motivo,
      })
    );
  };

  const desconectar = (s: Surtidor, conexionId: number, codigo: string) => {
    const motivo = pedir(`¿Por qué se desconecta ${codigo} de "${s.nombre}"?`);
    if (!motivo) return;
    void ejecutar(() =>
      enviar(
        `/api/erp/combustible/surtidores/${s.id}/conexiones/${conexionId}/desconectar`,
        "PATCH",
        { motivo }
      )
    );
  };

  const cambiarEstado = (s: Surtidor) => {
    const motivo = pedir(
      s.activo
        ? `Dar de baja "${s.nombre}" lo desconecta de sus tanques. ¿Por qué?`
        : `¿Por qué se reactiva "${s.nombre}"? (las conexiones se vuelven a hacer a mano)`
    );
    if (!motivo) return;
    void ejecutar(() =>
      enviar(
        `/api/erp/combustible/surtidores/${s.id}/${s.activo ? "baja" : "reactivar"}`,
        "PATCH",
        {
          motivo,
        }
      )
    );
  };

  const verHistorial = async (s: Surtidor) => {
    if (historial?.id === s.id) {
      setHistorial(null);
      return;
    }
    const res = await apiFetch(`/api/erp/combustible/surtidores/${s.id}/conexiones`);
    setHistorial({ id: s.id, filas: res.ok ? ((await res.json()) as Conexion[]) : [] });
  };

  const boton =
    "px-2 py-1 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50";

  return (
    <VentanaFlotante
      id="combustible-surtidores"
      titulo="Surtidores"
      subtitulo="El aparato por el que sale el combustible, con su totalizador"
      onCerrar={onCerrar}
      anchoInicial={820}
      altoInicial={660}
    >
      <div className="p-6 space-y-5 overflow-auto">
        <p className="text-xs text-slate-500">
          Un tanque puede tener varios surtidores, y un surtidor puede alimentar a más de un tanque
          del mismo grifo. Si un tanque tiene uno solo, su totalizador se sigue configurando desde
          el formulario del tanque.
        </p>
        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
            {error}
          </p>
        )}

        {surtidores === null ? (
          <p className="text-sm text-slate-400">Cargando...</p>
        ) : (
          surtidores.map((s) => {
            const conectados = new Set(s.tanques.map((t) => t.combustible_id));
            const conectables = tanques.filter(
              (t) => t.activo && t.grifo_interno_id === s.grifo_interno_id && !conectados.has(t.id)
            );
            return (
              <section
                key={s.id}
                className={`border border-slate-200 rounded-2xl p-4 space-y-3 ${s.activo ? "" : "opacity-60"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h4 className="font-bold text-slate-800">{s.nombre}</h4>
                    <p className="text-[11px] text-slate-500">
                      {grifos.hayVarios && `${grifos.nombreDeGrifo(s.grifo_interno_id)} · `}
                      {s.activo ? "Activo" : `Dado de baja: ${s.motivo_baja ?? ""}`}
                      {s.usa_totalizador &&
                        ` · Totalizador actual: ${Number(s.totalizador_actual).toLocaleString("es-PE")}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={boton}
                      disabled={trabajando}
                      onClick={() => renombrar(s)}
                    >
                      Renombrar
                    </button>
                    <button type="button" className={boton} onClick={() => verHistorial(s)}>
                      Historial
                    </button>
                    <button
                      type="button"
                      className={boton}
                      disabled={trabajando}
                      onClick={() => cambiarEstado(s)}
                    >
                      {s.activo ? "Dar de baja" : "Reactivar"}
                    </button>
                  </div>
                </div>

                {s.activo && (
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={s.usa_totalizador}
                        disabled={trabajando}
                        onChange={(e) => cambiarTotalizador(s, e.target.checked)}
                      />
                      Anotar el totalizador en cada vale y varilla
                    </label>
                    {s.usa_totalizador && (
                      <button
                        type="button"
                        className={boton}
                        disabled={trabajando}
                        onClick={() => cambiarTolerancia(s)}
                      >
                        Diferencia tolerada: {Number(s.totalizador_tolerancia)}
                      </button>
                    )}
                  </div>
                )}

                <div className="text-sm">
                  <span className="text-xs font-bold uppercase text-slate-700">Alimenta a</span>
                  {s.tanques.length === 0 ? (
                    <p className="text-slate-400">Ningún tanque.</p>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {s.tanques.map((t) => (
                        <li key={t.conexion_id} className="flex items-center justify-between gap-2">
                          <span>
                            {t.codigo} — {t.tanque_nombre}
                          </span>
                          <button
                            type="button"
                            className={boton}
                            disabled={trabajando}
                            onClick={() => desconectar(s, t.conexion_id, t.codigo)}
                          >
                            Desconectar
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.activo && conectables.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      <label htmlFor={`conectar-${s.id}`} className="sr-only">
                        Tanque a conectar a {s.nombre}
                      </label>
                      <select
                        id={`conectar-${s.id}`}
                        className="border border-slate-200 rounded-lg p-1.5 text-sm bg-white"
                        value={aConectar[s.id] ?? ""}
                        onChange={(e) => setAConectar((p) => ({ ...p, [s.id]: e.target.value }))}
                      >
                        <option value="">Conectar un tanque del mismo grifo</option>
                        {conectables.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.codigo} — {t.tanque_nombre}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className={boton}
                        disabled={trabajando}
                        onClick={() => conectar(s)}
                      >
                        Conectar
                      </button>
                    </div>
                  )}
                </div>

                {historial?.id === s.id && (
                  <ul className="text-xs text-slate-600 border-t pt-2 space-y-1">
                    {historial.filas.map((c) => (
                      <li key={c.id}>
                        <strong>{c.codigo}</strong>: {desde(c.conectado_en)}
                        {c.conectado_por ? ` (${c.conectado_por})` : ""}
                        {c.motivo_conexion ? ` · ${c.motivo_conexion}` : ""}
                        {c.desconectado_en &&
                          ` → desconectado ${fecha(c.desconectado_en)}${
                            c.desconectado_por ? ` (${c.desconectado_por})` : ""
                          } · ${c.motivo_desconexion ?? ""}`}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })
        )}

        <form onSubmit={crear} className="space-y-3 border border-slate-200 rounded-xl p-4">
          <h4 className="text-sm font-bold text-slate-700 uppercase tracking-wide">
            Agregar un surtidor
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {grifos.hayVarios && (
              <div className="space-y-1">
                <label htmlFor="surtidor-nuevo-grifo" className="text-xs font-bold uppercase">
                  Grifo interno
                </label>
                <select
                  id="surtidor-nuevo-grifo"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white"
                  value={nuevo.grifo}
                  onChange={(e) => setNuevo({ ...nuevo, grifo: e.target.value })}
                >
                  <option value="">Elegir grifo</option>
                  {grifos.grifosActivos.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.etiqueta}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1">
              <label htmlFor="surtidor-nuevo-nombre" className="text-xs font-bold uppercase">
                Nombre
              </label>
              <input
                id="surtidor-nuevo-nombre"
                required
                maxLength={80}
                className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                placeholder="Ej.: Surtidor 2 (manguera larga)"
                value={nuevo.nombre}
                onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={nuevo.usa}
              onChange={(e) => setNuevo({ ...nuevo, usa: e.target.checked })}
            />
            Tiene totalizador y se anota en cada vale y varilla
          </label>
          {nuevo.usa && (
            <div className="space-y-1 max-w-xs">
              <label htmlFor="surtidor-nuevo-tolerancia" className="text-xs font-bold uppercase">
                Diferencia tolerada
              </label>
              <input
                id="surtidor-nuevo-tolerancia"
                type="number"
                min={0}
                step="0.001"
                className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                value={nuevo.tolerancia}
                onChange={(e) => setNuevo({ ...nuevo, tolerancia: e.target.value })}
              />
            </div>
          )}
          <p className="text-xs text-slate-500">
            Nace sin tanques: después se conecta a los que alimenta, desde su tarjeta.
          </p>
          <button
            type="submit"
            disabled={trabajando}
            className="px-4 py-2 bg-slate-900 text-white text-sm rounded-lg disabled:opacity-50"
          >
            Agregar surtidor
          </button>
        </form>
      </div>
    </VentanaFlotante>
  );
}
