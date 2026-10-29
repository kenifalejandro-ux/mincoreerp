// Combustible › Viajes (0123): registrar, cerrar, corregir y anular viajes.
// El análisis (ranking, desvío) vive en el Histórico de cada producto.
import { Ban, Download, Eye, Flag, Lock, MapPin, Pencil, Play, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { CeldaDesvio } from "./ConsumoPorViaje";
import { DetalleViajeVentana } from "./DetalleViaje";
import { exportarViajesExcel } from "./exportarViajes";
import { IconoUnidad } from "./IconoUnidad";
import { LugaresPanel, type Lugar } from "./LugaresPanel";
import { textoDetenido } from "./motivosDescanso";
import {
  errorDelRecorrido,
  paradasDelRecorrido,
  RECORRIDO_VACIO,
  type Recorrido,
} from "./recorrido";
import { RecorridoViaje } from "./RecorridoViaje";
import { ResumenConductores } from "./ResumenConductores";
import { SelectorConductor, type OpcionConductor } from "./SelectorConductor";
import { SelectorRelevo } from "./SelectorRelevo";
import {
  desfaseSalida,
  fechaHora,
  fmt,
  ruta,
  semaforoViaje,
  unidadLabel,
  type FilaViaje,
  type NivelSemaforo,
} from "./viajesFormato";
import { useAuth } from "../../context/AuthContext";
import { apiFetch } from "../../services/apiClient";
import { ahoraParaInputLocal, paraInputLocal } from "../../utils/fechaLocal";

interface Equipo {
  id: number;
  placa_codigo: string;
  codigo_interno: string | null;
  tipo: string | null;
  tipo_medidor: "horometro" | "odometro" | null;
  conductor_nombre: string | null;
  conductor_dni: string | null;
  activo?: boolean;
  /** Rutas vigentes de la unidad en Equipos. */
  rutas?: {
    origen_id: number | string;
    destino_id: number | string;
    origen: string;
    destino: string;
  }[];
}

type Modal =
  | { tipo: "nuevo" }
  | { tipo: "iniciar"; v: FilaViaje }
  | { tipo: "editar"; v: FilaViaje }
  | { tipo: "cerrar"; v: FilaViaje }
  | { tipo: "anular"; v: FilaViaje };

const FORM_VACIO = {
  equipo_id: "",
  conductor_nombre: "",
  conductor_dni: "",
  relevo_dni: "",
  sale: "titular" as "titular" | "relevo",
  origen_id: "",
  destino_id: "",
  inicio_en: "",
  fin_en: "",
  medidor_inicio: "",
  medidor_fin: "",
  // Cuándo debería salir (opcional) y cuántos minutos de diferencia se aceptan (0155).
  salida_programada_en: "",
  desfase_tolerancia_min: "10",
  observaciones: "",
  nota_ruta: "",
  motivo: "",
};

interface Conductor {
  id: string;
  nombre: string;
  dni: string;
}

interface MedidorPrevio {
  tipo_medidor: "horometro" | "odometro" | null;
  valor: number | null;
  fuente: "viaje" | "carga" | null;
}

const ESTADOS: Record<FilaViaje["estado"], { texto: string; clase: string }> = {
  programado: { texto: "Programado", clase: "bg-sky-500/15 text-sky-300" },
  en_curso: { texto: "En curso", clase: "bg-amber-500/15 text-amber-300" },
  cerrado: { texto: "Cerrado", clase: "bg-emerald-500/15 text-emerald-300" },
  anulado: { texto: "Anulado", clase: "bg-red-500/15 text-red-300" },
};

const INPUT = "w-full border border-slate-200 rounded-xl p-3 text-sm";
const LABEL = "text-xs font-bold text-slate-700 uppercase";

const numeroONull = (s: string) => (s.trim() === "" ? null : Number(s));
const isoONull = (s: string) => (s ? new Date(s).toISOString() : null);

/** El estado del viaje en la lista: un viaje en curso con un descanso abierto dice qué le pasó. */
function textoDeEstado(v: FilaViaje) {
  if (v.estado !== "en_curso") return ESTADOS[v.estado].texto;
  const abierto = (v.descansos ?? []).find((d) => !d.fin_en && d.detiene !== false);
  return abierto ? textoDetenido(abierto.motivo) : ESTADOS[v.estado].texto;
}

/** El semáforo del viaje: un punto de color con los motivos al pasar el cursor o al leerlo. */
function PuntoSemaforo({ v }: { v: FilaViaje }) {
  const s = semaforoViaje(v);
  if (!s) return null;
  const texto = s.motivos.length
    ? s.motivos.join(" · ")
    : v.estado === "en_curso"
      ? "Sin desvíos hasta ahora"
      : "Sin desvíos";
  const color = { verde: "bg-emerald-400", ambar: "bg-amber-400", rojo: "bg-red-500" }[s.nivel];
  const nombre = { verde: "Verde", ambar: "Ámbar", rojo: "Rojo" }[s.nivel];
  return (
    <span
      role="img"
      aria-label={`Semáforo ${nombre}: ${texto}`}
      title={`${nombre}: ${texto}`}
      className={`ml-2 inline-block h-2.5 w-2.5 rounded-full align-middle ${color}`}
    />
  );
}

/** La hora no la puso el servidor en el momento: se avisa de dónde salió. */
function MarcaHora({ origen }: { origen: FilaViaje["inicio_origen_hora"] }) {
  if (origen !== "dispositivo" && origen !== "manual") return null;
  return (
    <span
      title={
        origen === "dispositivo"
          ? "Marcada sin señal: vale la hora del celular del conductor"
          : "Puesta a mano por la oficina, con motivo en la bitácora"
      }
      className="ml-1.5 px-1 py-0.5 rounded text-[10px] uppercase bg-slate-500/20 text-slate-300"
    >
      {origen === "dispositivo" ? "celular" : "manual"}
    </span>
  );
}

export default function ViajesPanel() {
  const { usuario } = useAuth();
  const [viajes, setViajes] = useState<FilaViaje[]>([]);
  const [lugares, setLugares] = useState<Lugar[]>([]);
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [totalEquipos, setTotalEquipos] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [filtroEstado, setFiltroEstado] = useState("");
  const [filtroEquipo, setFiltroEquipo] = useState("");
  // Estos dos filtran lo que ya se cargó: no piden nada nuevo al servidor.
  const [filtroConductor, setFiltroConductor] = useState("");
  // Los conductores que ya se vieron en alguna carga: si otro filtro deja sin viajes al elegido, sigue
  // en el desplegable y se puede quitar (si no, mostraría "Todos" con el filtro aún activo).
  const [conductoresVistos, setConductoresVistos] = useState<Record<string, string>>({});
  const [filtroSemaforo, setFiltroSemaforo] = useState<"" | NivelSemaforo>("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [modal, setModal] = useState<Modal | null>(null);
  const [form, setForm] = useState(FORM_VACIO);
  // El recorrido de un viaje NUEVO (solo ida, ida y vuelta, varias paradas); editar sigue
  // con origen y destino.
  const [recorrido, setRecorrido] = useState<Recorrido>(RECORRIDO_VACIO);
  const [lugaresAbierto, setLugaresAbierto] = useState(false);
  const [lugaresListos, setLugaresListos] = useState(false);
  const [lugaresError, setLugaresError] = useState(false);
  // Una respuesta lenta de la lista de lugares no debe pisar a una más nueva.
  const pedidoLugares = useRef(0);
  const [guardando, setGuardando] = useState(false);
  const [verId, setVerId] = useState<string | null>(null);
  const [retro, setRetro] = useState(false);
  // Un viaje con varias paradas no se registra ya terminado: se marca parada por parada.
  const retroVale = retro && paradasDelRecorrido(recorrido).length <= 2;
  const [horaManual, setHoraManual] = useState(false);
  const [rutaDudosa, setRutaDudosa] = useState(false);
  const [previo, setPrevio] = useState<MedidorPrevio | null>(null);
  // Salida, llegada y medidores de un viaje YA registrado nacen bloqueados:
  // un clic de más no cambia lo que ya ocurrió. Desbloquear es una acción a
  // propósito, y guardar sigue pidiendo motivo igual que el resto del form.
  const [desbloqueado, setDesbloqueado] = useState(false);
  const [conductores, setConductores] = useState<Conductor[]>([]);
  // Hasta que llegue la lista de usuarios no se sabe quién tiene cuenta: sin
  // esto, al abrir el formulario todos saldrían marcados como "sin usuario".
  const [conductoresListos, setConductoresListos] = useState(false);

  const permite = (accion: "nuevo" | "editar" | "lugares") => {
    const override = usuario?.permisosPestanas?.[`combustible:viajes:${accion}`];
    if (override !== undefined) return override;
    return usuario?.rol === "admin" || usuario?.rol === "operador";
  };

  const puedeProgramar = permite("nuevo");

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const q = new URLSearchParams();
      if (filtroEstado) q.set("estado", filtroEstado);
      if (filtroEquipo) q.set("equipo_id", filtroEquipo);
      if (desde) q.set("desde", new Date(`${desde}T00:00:00`).toISOString());
      if (hasta) q.set("hasta", new Date(`${hasta}T23:59:59`).toISOString());
      const res = await apiFetch(`/api/erp/combustible/viajes?${q}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? body?.message ?? "No se pudieron cargar los viajes.");
        return;
      }
      setError(null);
      const filas: FilaViaje[] = Array.isArray(body?.data) ? body.data : [];
      setViajes(filas);
      setConductoresVistos((antes) => {
        const ahora = { ...antes };
        for (const v of filas) {
          if (v.conductor_dni) ahora[v.conductor_dni] = v.conductor_nombre ?? v.conductor_dni;
          if (v.relevo_dni) ahora[v.relevo_dni] = v.relevo_nombre ?? v.relevo_dni;
        }
        return ahora;
      });
    } finally {
      setCargando(false);
    }
  }, [filtroEstado, filtroEquipo, desde, hasta]);

  const conductoresDeLaLista = Object.entries(conductoresVistos).sort((a, b) =>
    a[1].localeCompare(b[1])
  );
  const visibles = viajes.filter(
    (v) =>
      (!filtroConductor ||
        v.conductor_dni === filtroConductor ||
        v.relevo_dni === filtroConductor) &&
      (!filtroSemaforo || semaforoViaje(v)?.nivel === filtroSemaforo)
  );

  const cargarLugares = useCallback(async () => {
    const mio = ++pedidoLugares.current;
    try {
      const res = await apiFetch("/api/erp/combustible/lugares");
      const body = await res.json().catch(() => null);
      if (mio !== pedidoLugares.current) return;
      if (!res.ok) throw new Error("lugares");
      setLugares(Array.isArray(body?.data) ? body.data : []);
      setLugaresListos(true);
      setLugaresError(false);
    } catch {
      if (mio === pedidoLugares.current) setLugaresError(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargarLugares();
    void (async () => {
      const res = await apiFetch("/api/erp/combustible/equipos-destino?pageSize=200");
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setEquipos(Array.isArray(body?.data) ? body.data : []);
        setTotalEquipos(Number(body?.pagination?.total ?? 0));
      }
    })();
  }, [cargarLugares]);

  useEffect(() => {
    if (!puedeProgramar) return;
    void (async () => {
      const res = await apiFetch("/api/erp/combustible/viajes/conductores");
      const body = await res.json().catch(() => null);
      if (!res.ok) return;
      setConductores(Array.isArray(body?.data) ? body.data : []);
      setConductoresListos(true);
    })();
  }, [puedeProgramar]);

  useEffect(() => {
    const es = new EventSource("/api/eventos/stream", { withCredentials: true });
    const refrescar = () => void cargar();
    // Crear, editar o desactivar un lugar publica este mismo evento: la ventana de Lugares se
    // actualiza sola cuando otra sesión cambia algo.
    es.addEventListener("combustible.viaje_actualizado", () => {
      refrescar();
      void cargarLugares();
    });
    es.addEventListener("combustible.despacho_creado", refrescar);
    es.addEventListener("combustible.despacho_anulado", refrescar);
    return () => es.close();
  }, [cargar, cargarLugares]);

  const abrir = (m: Modal) => {
    setRetro(false);
    setHoraManual(false);
    setRutaDudosa(false);
    setPrevio(null);
    setDesbloqueado(false);
    if (m.tipo === "nuevo") {
      setRecorrido(RECORRIDO_VACIO);
      setForm({ ...FORM_VACIO, inicio_en: ahoraParaInputLocal() });
    } else if (m.tipo === "editar") {
      const v = m.v;
      setRutaDudosa(v.ruta_por_confirmar);
      setForm({
        ...FORM_VACIO,
        equipo_id: String(v.equipo_id),
        conductor_nombre: v.conductor_nombre ?? "",
        conductor_dni: v.conductor_dni ?? "",
        origen_id: String(v.origen_id),
        destino_id: String(v.destino_id),
        inicio_en: v.inicio_en ? paraInputLocal(v.inicio_en) : "",
        fin_en: v.fin_en ? paraInputLocal(v.fin_en) : "",
        medidor_inicio: v.medidor_inicio ?? "",
        medidor_fin: v.medidor_fin ?? "",
        salida_programada_en: v.salida_programada_en ? paraInputLocal(v.salida_programada_en) : "",
        desfase_tolerancia_min: String(v.desfase_tolerancia_min ?? 10),
        observaciones: v.observaciones ?? "",
        nota_ruta: v.nota_ruta ?? "",
        motivo: "",
      });
    } else if (m.tipo === "iniciar") {
      setForm({ ...FORM_VACIO, inicio_en: ahoraParaInputLocal() });
      void (async () => {
        const res = await apiFetch(`/api/erp/combustible/viajes/${m.v.id}/medidor-previo`);
        const body = await res.json().catch(() => null);
        if (res.ok) setPrevio(body);
      })();
    } else if (m.tipo === "cerrar") {
      setForm({ ...FORM_VACIO, fin_en: ahoraParaInputLocal() });
    } else {
      setForm(FORM_VACIO);
    }
    setModal(m);
  };

  const elegirEquipo = (id: string) => {
    const e = equipos.find((x) => String(x.id) === id);
    setForm((f) => ({
      ...f,
      equipo_id: id,
      conductor_nombre: e?.conductor_nombre ?? "",
      conductor_dni: e?.conductor_dni ?? "",
    }));
  };

  // Una ruta cuyo origen o destino se desactivó no sirve: el alta de viajes
  // exige lugares activos, así que ofrecerla solo llevaría a un error al
  // guardar sin manera de corregirlo desde aquí.
  const rutasUsables = (e?: Equipo) => {
    const activos = new Set(lugares.filter((l) => l.activo).map((l) => String(l.id)));
    return (e?.rutas ?? []).filter(
      (r) => activos.has(String(r.origen_id)) && activos.has(String(r.destino_id))
    );
  };

  const elegirConductor = (o: OpcionConductor) => {
    const e = equipos.find((x) => x.id === o.equipoId);
    const rutas = rutasUsables(e);
    setForm((f) => ({
      ...f,
      equipo_id: String(o.equipoId),
      conductor_nombre: e?.conductor_nombre ?? "",
      conductor_dni: e?.conductor_dni ?? "",
      relevo_dni: "",
      sale: "titular",
    }));
    setRecorrido((r) => ({
      ...r,
      paradas:
        rutas.length === 1 ? [String(rutas[0].origen_id), String(rutas[0].destino_id)] : ["", ""],
    }));
  };

  const enviar = async (url: string, method: string, body: unknown) => {
    if (guardando) return false;
    setGuardando(true);
    try {
      const res = await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(r.error || r.message || r.errors?.[0]?.message || "No se pudo guardar.");
        return false;
      }
      return true;
    } finally {
      setGuardando(false);
    }
  };

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modal) return;
    let ok = false;
    const base = "/api/erp/combustible/viajes";
    if (modal.tipo === "nuevo") {
      if (!form.equipo_id) {
        alert("Elige el conductor: de ahí salen la unidad y la ruta.");
        return;
      }
      const errorRecorrido = errorDelRecorrido(recorrido);
      if (errorRecorrido) {
        alert(`${errorRecorrido} Elígelo, o cárgalo a la unidad en Equipos.`);
        return;
      }
      ok = await enviar(base, "POST", {
        equipo_id: Number(form.equipo_id),
        conductor_nombre: form.conductor_nombre.trim() || null,
        conductor_dni: form.conductor_dni.trim() || null,
        ...(form.relevo_dni ? { relevo_dni: form.relevo_dni, sale: form.sale } : {}),
        paradas: paradasDelRecorrido(recorrido).map(Number),
        observaciones: form.observaciones.trim() || null,
        ...(retroVale
          ? {
              inicio_en: isoONull(form.inicio_en),
              fin_en: isoONull(form.fin_en),
              medidor_inicio: numeroONull(form.medidor_inicio),
              medidor_fin: numeroONull(form.medidor_fin),
            }
          : {
              salida_programada_en: isoONull(form.salida_programada_en),
              desfase_tolerancia_min: Number(form.desfase_tolerancia_min || 10),
            }),
      });
    } else if (modal.tipo === "iniciar") {
      ok = await enviar(`${base}/${modal.v.id}/iniciar`, "POST", {
        medidor_inicio: numeroONull(form.medidor_inicio),
        ...(horaManual ? { inicio_en: isoONull(form.inicio_en), motivo: form.motivo.trim() } : {}),
        ...(rutaDudosa
          ? { ruta_por_confirmar: true, nota_ruta: form.nota_ruta.trim() || null }
          : {}),
      });
    } else if (modal.tipo === "editar") {
      const v = modal.v;
      const programado = v.estado === "programado";
      ok = await enviar(`${base}/${v.id}`, "PUT", {
        ...(Number(form.equipo_id) !== v.equipo_id ? { equipo_id: Number(form.equipo_id) } : {}),
        conductor_nombre: form.conductor_nombre.trim() || null,
        conductor_dni: form.conductor_dni.trim() || null,
        origen_id: Number(form.origen_id),
        destino_id: Number(form.destino_id),
        observaciones: form.observaciones.trim() || null,
        ...(programado
          ? {}
          : {
              inicio_en: isoONull(form.inicio_en),
              fin_en: isoONull(form.fin_en),
              medidor_inicio: numeroONull(form.medidor_inicio),
              medidor_fin: numeroONull(form.medidor_fin),
            }),
        ...(v.ruta_por_confirmar ? { ruta_por_confirmar: rutaDudosa } : {}),
        // La hora programada y su tolerancia solo viajan si las cambió: reenviarlas igual volvería
        // a validar el rango de una hora vieja.
        ...(v.estado !== "cerrado" &&
        form.salida_programada_en !==
          (v.salida_programada_en ? paraInputLocal(v.salida_programada_en) : "")
          ? { salida_programada_en: isoONull(form.salida_programada_en) }
          : {}),
        ...(v.estado !== "cerrado" &&
        Number(form.desfase_tolerancia_min || 10) !== v.desfase_tolerancia_min
          ? { desfase_tolerancia_min: Number(form.desfase_tolerancia_min || 10) }
          : {}),
        motivo: form.motivo.trim(),
      });
    } else if (modal.tipo === "cerrar") {
      ok = await enviar(`${base}/${modal.v.id}/cerrar`, "POST", {
        medidor_fin: numeroONull(form.medidor_fin),
        ...(horaManual ? { fin_en: isoONull(form.fin_en), motivo: form.motivo.trim() } : {}),
      });
    } else if (modal.tipo === "anular") {
      ok = await enviar(`${base}/${modal.v.id}/anular`, "POST", { motivo: form.motivo.trim() });
    }
    if (ok) {
      setModal(null);
      await cargar();
    }
  };

  const lugaresActivos = lugares.filter((l) => l.activo);
  const equipoDelForm = equipos.find((x) => String(x.id) === form.equipo_id);
  const dnisConUsuario = new Set(conductores.map((c) => c.dni));
  const opcionesConductor: OpcionConductor[] = equipos
    .filter((e) => e.activo !== false && (e.conductor_nombre || e.conductor_dni))
    .map((e) => ({
      equipoId: e.id,
      nombre: e.conductor_nombre ?? `DNI ${e.conductor_dni}`,
      dni: e.conductor_dni ?? "",
      unidad: `${unidadLabel(e)}${e.tipo ? ` (${e.tipo})` : ""}`,
      sinUsuario: conductoresListos && (!e.conductor_dni || !dnisConUsuario.has(e.conductor_dni)),
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  const rutasDeLaUnidad = rutasUsables(equipoDelForm);
  const indiceRutaElegida = rutasDeLaUnidad.findIndex(
    (r) =>
      String(r.origen_id) === recorrido.paradas[0] && String(r.destino_id) === recorrido.paradas[1]
  );
  // Tenía rutas en Equipos, pero ninguna usable: hay que decir por qué.
  const rutasDeBaja = (equipoDelForm?.rutas ?? []).length > 0 && rutasDeLaUnidad.length === 0;
  const tipoMedidor =
    modal && "v" in modal ? modal.v.tipo_medidor : (equipoDelForm?.tipo_medidor ?? null);
  const medidorEtiqueta = tipoMedidor === "horometro" ? "horómetro" : "odómetro";
  const unidadMedidor = tipoMedidor === "horometro" ? "h" : "km";

  const selectLugar = (campo: "origen_id" | "destino_id", etiqueta: string) => (
    <div className="space-y-1">
      <label htmlFor={`viaje-${campo}`} className={LABEL}>
        {etiqueta}
      </label>
      <select
        id={`viaje-${campo}`}
        required
        className={INPUT}
        value={form[campo]}
        onChange={(e) => setForm({ ...form, [campo]: e.target.value })}
      >
        <option value="">Elegir...</option>
        {/* El lugar que el viaje ya tiene se ofrece aunque lo hayan desactivado después: sin esto el
            formulario de corregir no se podría enviar (el lugar no cambia, y el servidor lo acepta). */}
        {lugares
          .filter((l) => l.activo || String(l.id) === String(form[campo]))
          .map((l) => (
            <option key={l.id} value={l.id}>
              {l.activo ? l.nombre : `${l.nombre} (inactivo)`}
            </option>
          ))}
      </select>
    </div>
  );

  const campo = (
    nombre: keyof typeof FORM_VACIO,
    etiqueta: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {}
  ) => (
    <div className="space-y-1">
      <label htmlFor={`viaje-${nombre}`} className={LABEL}>
        {etiqueta}
      </label>
      <input
        id={`viaje-${nombre}`}
        className={INPUT}
        value={form[nombre]}
        onChange={(e) => setForm({ ...form, [nombre]: e.target.value })}
        {...props}
      />
    </div>
  );

  const tituloModal =
    modal?.tipo === "nuevo"
      ? "Programar viaje"
      : modal?.tipo === "iniciar"
        ? `Iniciar viaje V-${modal.v.numero}`
        : modal?.tipo === "editar"
          ? `Corregir viaje V-${modal.v.numero}`
          : modal?.tipo === "cerrar"
            ? `Cerrar viaje V-${modal.v.numero}`
            : modal?.tipo === "anular"
              ? `Anular viaje V-${modal.v.numero}`
              : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Viajes</h2>
          <p className="text-sm text-[#94a3b8]">
            Cada viaje es el recorrido de una unidad de un lugar a otro. Sus cargas de combustible y
            urea se toman solas: las de esa unidad entre la salida (incluida la tanqueada previa) y
            la llegada.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() =>
              void exportarViajesExcel(
                visibles,
                textoDeEstado,
                `Viajes ${desde || "todo"}${hasta ? ` a ${hasta}` : ""}.xlsx`
              )
            }
            disabled={visibles.length === 0}
            className="flex items-center gap-2 border border-[#334155] text-[#cbd5e1] px-4 py-2 rounded-lg hover:text-white disabled:opacity-40"
          >
            <Download className="w-4 h-4" /> Exportar a Excel
          </button>
          {permite("lugares") && (
            <button
              onClick={() => setLugaresAbierto(true)}
              className="flex items-center gap-2 border border-[#334155] text-[#cbd5e1] px-4 py-2 rounded-lg hover:text-white"
            >
              <MapPin className="w-4 h-4" /> Lugares
            </button>
          )}
          {permite("nuevo") && (
            <button
              onClick={() => abrir({ tipo: "nuevo" })}
              className="flex items-center gap-2 bg-[#BADC1E] text-[#0D1719] font-bold px-4 py-2 rounded-lg hover:brightness-110"
            >
              <Plus className="w-4 h-4" /> Nuevo viaje
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-[#94a3b8]">
          Salida desde
          <input
            type="date"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
            className="bg-[#0D1719] border border-[#334155] rounded-lg px-3 py-2 text-white"
          />
        </label>
        <label className="flex flex-col gap-1 text-[#94a3b8]">
          Hasta
          <input
            type="date"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
            className="bg-[#0D1719] border border-[#334155] rounded-lg px-3 py-2 text-white"
          />
        </label>
        <label className="flex flex-col gap-1 text-[#94a3b8]">
          Unidad
          <select
            value={filtroEquipo}
            onChange={(e) => setFiltroEquipo(e.target.value)}
            className="bg-[#0D1719] border border-[#334155] rounded-lg px-3 py-2 text-white"
          >
            <option value="">Todas</option>
            {equipos.map((e) => (
              <option key={e.id} value={e.id}>
                {unidadLabel(e)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[#94a3b8]">
          Conductor
          <select
            value={filtroConductor}
            onChange={(e) => setFiltroConductor(e.target.value)}
            className="bg-[#0D1719] border border-[#334155] rounded-lg px-3 py-2 text-white"
          >
            <option value="">Todos</option>
            {conductoresDeLaLista.map(([dni, nombre]) => (
              <option key={dni} value={dni}>
                {nombre}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[#94a3b8]">
          Semáforo
          <select
            value={filtroSemaforo}
            onChange={(e) => setFiltroSemaforo(e.target.value as "" | NivelSemaforo)}
            className="bg-[#0D1719] border border-[#334155] rounded-lg px-3 py-2 text-white"
          >
            <option value="">Todos</option>
            <option value="rojo">Rojo: revisar</option>
            <option value="ambar">Ámbar: desvío menor</option>
            <option value="verde">Verde: sin desvíos</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[#94a3b8]">
          Estado
          <select
            value={filtroEstado}
            onChange={(e) => setFiltroEstado(e.target.value)}
            className="bg-[#0D1719] border border-[#334155] rounded-lg px-3 py-2 text-white"
          >
            <option value="">Programados, en curso y cerrados</option>
            <option value="programado">Programados</option>
            <option value="en_curso">En curso</option>
            <option value="cerrado">Cerrados</option>
            <option value="anulado">Anulados</option>
          </select>
        </label>
        {cargando && <span className="text-[#94a3b8] pb-2">Cargando...</span>}
      </div>

      <ResumenConductores desde={desde} hasta={hasta} />

      {error && <p className="text-sm text-red-400">{error}</p>}
      {!error && !cargando && visibles.length === 0 && (
        <p className="text-sm text-[#94a3b8]">No hay viajes con estos filtros.</p>
      )}

      {visibles.length > 0 && (
        <div className="bg-[#192526] border border-[#2a2e37] rounded-lg overflow-x-auto">
          <table className="w-full text-sm text-[#e2e8f0]">
            <thead>
              <tr className="text-left text-[11px] uppercase text-[#94a3b8]">
                <th className="p-3">Viaje</th>
                <th className="p-3">Ruta</th>
                <th className="p-3">Unidad</th>
                <th className="p-3">Conductor</th>
                <th className="p-3">Salida</th>
                <th className="p-3">Llegada</th>
                <th className="p-3">Estado</th>
                <th className="p-3 text-right">Cargas</th>
                <th className="p-3 text-right">Combustible (gal)</th>
                <th className="p-3 text-right">vs. ruta</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {visibles.map((v) => (
                <tr
                  key={v.id}
                  // Un toque en la fila abre el tablero del viaje: en el celular
                  // la gerencia no tiene que buscar el ojo al final de la tabla.
                  onClick={() => setVerId(v.id)}
                  className={`border-t border-[#2a2e37] cursor-pointer hover:bg-[#1f2c2e] ${
                    v.estado === "anulado" ? "opacity-60" : ""
                  }`}
                >
                  <td className="p-3 font-mono whitespace-nowrap">V-{v.numero}</td>
                  <td className="p-3">
                    {ruta(v)}
                    {v.ruta_por_confirmar && (
                      <span
                        title={v.nota_ruta ?? "El conductor avisó a la oficina"}
                        className="ml-2 px-1.5 py-0.5 rounded text-[10px] uppercase whitespace-nowrap bg-amber-500/15 text-amber-300"
                      >
                        Ruta por confirmar
                      </span>
                    )}
                  </td>
                  <td className="p-3">{unidadLabel(v)}</td>
                  <td className="p-3">
                    {v.conductor_nombre ?? "—"}
                    {v.relevo_nombre && (
                      <span className="block text-xs text-[#94a3b8]">
                        Relevo: {v.relevo_nombre}
                        {v.estado === "en_curso" && (
                          <>
                            {" "}
                            · maneja{" "}
                            {v.volante_dni === v.relevo_dni ? v.relevo_nombre : v.conductor_nombre}
                          </>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    {v.inicio_en || !v.salida_programada_en ? (
                      fechaHora(v.inicio_en)
                    ) : (
                      <span title="Hora de salida programada" className="text-[#94a3b8]">
                        Prog. {fechaHora(v.salida_programada_en)}
                      </span>
                    )}
                    <MarcaHora origen={v.inicio_origen_hora} />
                    {(() => {
                      const d = desfaseSalida(v);
                      return d ? (
                        <p
                          className={`text-[11px] ${
                            d.tono === "tarde"
                              ? "text-red-300"
                              : d.tono === "antes"
                                ? "text-amber-300"
                                : "text-[#94a3b8]"
                          }`}
                        >
                          {d.texto}
                        </p>
                      ) : null;
                    })()}
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    {fechaHora(v.fin_en)}
                    <MarcaHora origen={v.fin_origen_hora} />
                  </td>
                  <td className="p-3">
                    <span
                      title={v.motivo_anulacion ?? undefined}
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap px-2 py-0.5 rounded text-xs ${ESTADOS[v.estado].clase}`}
                    >
                      <IconoUnidad tipo={v.equipo_tipo} className="w-3.5 h-3.5" />
                      {textoDeEstado(v)}
                    </span>
                    <PuntoSemaforo v={v} />
                  </td>
                  <td className="p-3 text-right font-mono">{v.cargas}</td>
                  <td className="p-3 text-right font-mono">{fmt(Number(v.cantidad))}</td>
                  <td className="p-3 text-right">
                    <CeldaDesvio v={v} />
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => setVerId(v.id)}
                        aria-label={`Ver viaje V-${v.numero}`}
                        title="Ver cargas"
                        className="p-1.5 rounded border border-[#334155] text-[#94a3b8] hover:text-white"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      {permite("editar") && v.estado === "programado" && (
                        <button
                          onClick={() => abrir({ tipo: "iniciar", v })}
                          aria-label={`Iniciar viaje V-${v.numero}`}
                          title="Iniciar viaje"
                          className="p-1.5 rounded border border-[#334155] text-[#94a3b8] hover:text-emerald-400"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                      )}
                      {permite("editar") && v.estado === "en_curso" && (
                        <button
                          onClick={() => abrir({ tipo: "cerrar", v })}
                          aria-label={`Cerrar viaje V-${v.numero}`}
                          title="Marcar llegada"
                          className="p-1.5 rounded border border-[#334155] text-[#94a3b8] hover:text-white"
                        >
                          <Flag className="w-4 h-4" />
                        </button>
                      )}
                      {permite("editar") && v.estado !== "anulado" && (
                        <>
                          <button
                            onClick={() => abrir({ tipo: "editar", v })}
                            aria-label={`Corregir viaje V-${v.numero}`}
                            title="Corregir"
                            className="p-1.5 rounded border border-[#334155] text-[#94a3b8] hover:text-white"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => abrir({ tipo: "anular", v })}
                            aria-label={`Anular viaje V-${v.numero}`}
                            title="Anular"
                            className="p-1.5 rounded border border-[#334155] text-[#94a3b8] hover:text-red-400"
                          >
                            <Ban className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lugaresAbierto && (
        <LugaresPanel
          lugares={lugares}
          listos={lugaresListos}
          errorCarga={lugaresError}
          onRecargar={cargarLugares}
          puedeGestionar={permite("lugares")}
          onCerrar={() => setLugaresAbierto(false)}
        />
      )}

      {modal && (
        <div className="fixed inset-0 bg-[#0D1719]/90 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">{tituloModal}</h3>
              <button
                onClick={() => setModal(null)}
                aria-label="Cerrar"
                className="text-slate-400 hover:text-slate-900"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {
              <form onSubmit={guardar} className="p-6 space-y-4">
                {modal.tipo === "nuevo" && (
                  <div className="space-y-1">
                    <label htmlFor="viaje-conductor" className={LABEL}>
                      Conductor
                    </label>
                    {totalEquipos > equipos.length && (
                      <p className="text-xs text-amber-600">
                        Hay {totalEquipos} unidades pero aquí solo caben {equipos.length}: algunas
                        no aparecen en la lista. Avisa a soporte para ampliarla.
                      </p>
                    )}
                    <SelectorConductor
                      opciones={opcionesConductor}
                      valor={form.equipo_id ? Number(form.equipo_id) : null}
                      onElegir={elegirConductor}
                    />
                    {equipoDelForm ? (
                      <div className="rounded-xl bg-slate-50/5 border border-slate-200 p-3 text-sm space-y-1">
                        <p>
                          <span className="font-semibold">Unidad:</span>{" "}
                          {unidadLabel(equipoDelForm)}
                          {equipoDelForm.tipo ? ` (${equipoDelForm.tipo})` : ""}
                        </p>
                        <p>
                          <span className="font-semibold">DNI:</span>{" "}
                          {equipoDelForm.conductor_dni ?? "—"}
                        </p>
                        {rutasDeLaUnidad.length === 1 && (
                          <p>
                            <span className="font-semibold">Ruta:</span> {rutasDeLaUnidad[0].origen}{" "}
                            → {rutasDeLaUnidad[0].destino}
                          </p>
                        )}
                        {conductoresListos &&
                          (!equipoDelForm.conductor_dni ||
                            !dnisConUsuario.has(equipoDelForm.conductor_dni)) && (
                            <p className="text-amber-600">
                              Este conductor no tiene usuario: no verá el viaje en “Mi viaje”.
                            </p>
                          )}
                        <p className="text-xs text-slate-500">
                          Estos datos vienen de Equipos. Si algo no es correcto, corrígelo allá.
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-600">
                        Al elegirlo se cargan la unidad, el DNI y la ruta desde Equipos.
                      </p>
                    )}
                  </div>
                )}

                {modal.tipo === "nuevo" && equipoDelForm && (
                  <SelectorRelevo
                    conductores={conductores}
                    titularDni={form.conductor_dni}
                    relevoDni={form.relevo_dni}
                    sale={form.sale}
                    onCambiar={(relevo_dni, sale) => setForm((f) => ({ ...f, relevo_dni, sale }))}
                  />
                )}

                {modal.tipo === "editar" && (
                  <div className="space-y-1">
                    <label htmlFor="viaje-equipo" className={LABEL}>
                      Unidad
                    </label>
                    <select
                      id="viaje-equipo"
                      required
                      className={INPUT}
                      value={form.equipo_id}
                      onChange={(e) => elegirEquipo(e.target.value)}
                    >
                      <option value="">Elegir...</option>
                      {equipos.map((e) => (
                        <option key={e.id} value={e.id}>
                          {unidadLabel(e)}
                          {e.tipo ? ` (${e.tipo})` : ""}
                        </option>
                      ))}
                    </select>
                    {modal.tipo === "editar" && Number(form.equipo_id) !== modal.v.equipo_id && (
                      <p className="text-xs text-amber-700">
                        Cambiar la unidad mueve sus cargas al otro vehículo.
                      </p>
                    )}
                  </div>
                )}

                {(modal.tipo === "nuevo" || modal.tipo === "editar") && (
                  <>
                    {lugaresActivos.length < 2 && (
                      <p className="text-sm text-amber-700 bg-amber-50 rounded-xl p-3">
                        Primero carga al menos dos lugares en “Lugares”.
                      </p>
                    )}
                    {modal.tipo === "nuevo" ? (
                      <>
                        {equipoDelForm && rutasDeLaUnidad.length > 1 && (
                          <div className="space-y-1">
                            <label htmlFor="viaje-ruta" className={LABEL}>
                              Ruta
                            </label>
                            <select
                              id="viaje-ruta"
                              required
                              className={INPUT}
                              value={indiceRutaElegida >= 0 ? String(indiceRutaElegida) : ""}
                              onChange={(e) => {
                                const r = rutasDeLaUnidad[Number(e.target.value)];
                                setRecorrido({
                                  ...recorrido,
                                  paradas: [
                                    r ? String(r.origen_id) : "",
                                    r ? String(r.destino_id) : "",
                                    ...recorrido.paradas.slice(2),
                                  ],
                                });
                              }}
                            >
                              <option value="">Elegir...</option>
                              {rutasDeLaUnidad.map((r, i) => (
                                <option key={i} value={i}>
                                  {r.origen} → {r.destino}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {equipoDelForm && rutasDeLaUnidad.length === 0 && (
                          <p className="text-sm text-amber-700 bg-amber-50 rounded-xl p-3">
                            {rutasDeBaja
                              ? "La ruta que tiene esta unidad en Equipos usa un lugar desactivado: elige otra aquí y corrígela en Equipos."
                              : "Esta unidad no tiene ruta en Equipos: elígela aquí y, cuando puedas, cárgala en Equipos."}
                          </p>
                        )}
                        <RecorridoViaje
                          lugares={lugaresActivos}
                          valor={recorrido}
                          onChange={setRecorrido}
                        />
                      </>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          {selectLugar("origen_id", "Origen")}
                          {selectLugar("destino_id", "Destino")}
                        </div>
                        {conductores.length > 0 && (
                          <div className="space-y-1">
                            <label htmlFor="viaje-conductor-lista" className={LABEL}>
                              Conductor
                            </label>
                            <select
                              id="viaje-conductor-lista"
                              className={INPUT}
                              value={
                                conductores.find((c) => c.dni === form.conductor_dni.trim())?.id ??
                                ""
                              }
                              onChange={(e) => {
                                const c = conductores.find((x) => x.id === e.target.value);
                                setForm({
                                  ...form,
                                  conductor_nombre: c?.nombre ?? "",
                                  conductor_dni: c?.dni ?? "",
                                });
                              }}
                            >
                              <option value="">Otro (escribir abajo)</option>
                              {conductores.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.nombre} · DNI {c.dni}
                                </option>
                              ))}
                            </select>
                            <p className="text-xs text-slate-600">
                              El viaje le aparece en “Mi viaje” al conductor con este DNI.
                            </p>
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-3">
                          {campo(
                            "conductor_nombre",
                            conductores.length > 0 ? "Nombre" : "Conductor",
                            {
                              maxLength: 150,
                            }
                          )}
                          {campo("conductor_dni", "DNI", { maxLength: 15 })}
                        </div>
                      </>
                    )}
                    {modal.tipo === "nuevo" && (
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={retroVale}
                          disabled={paradasDelRecorrido(recorrido).length > 2}
                          onChange={(e) => setRetro(e.target.checked)}
                        />
                        Registrar un viaje que ya se hizo (con sus horas y medidores)
                      </label>
                    )}
                    {modal.tipo === "editar" &&
                      modal.v.estado !== "programado" &&
                      !desbloqueado && (
                        <div className="space-y-2">
                          <dl className="rounded-xl bg-slate-100 p-4 text-sm space-y-2">
                            {[
                              ["Salida", fechaHora(modal.v.inicio_en)],
                              ["Llegada", fechaHora(modal.v.fin_en)],
                              ...(modal.v.medidor_inicio
                                ? [
                                    [
                                      `${medidorEtiqueta} salida`,
                                      `${fmt(Number(modal.v.medidor_inicio), 1)}`,
                                    ],
                                  ]
                                : []),
                              ...(modal.v.medidor_fin
                                ? [
                                    [
                                      `${medidorEtiqueta} llegada`,
                                      `${fmt(Number(modal.v.medidor_fin), 1)}`,
                                    ],
                                  ]
                                : []),
                            ].map(([k, valor]) => (
                              <div key={k} className="flex justify-between gap-3">
                                <dt className="text-slate-500 flex items-center gap-1">
                                  <Lock className="w-3 h-3" /> {k}
                                </dt>
                                <dd className="text-slate-900 font-mono">{valor}</dd>
                              </div>
                            ))}
                          </dl>
                          <button
                            type="button"
                            onClick={() => setDesbloqueado(true)}
                            className="text-sm text-sky-700 underline"
                          >
                            Editar estos datos
                          </button>
                        </div>
                      )}
                    {(retroVale ||
                      desbloqueado ||
                      (modal.tipo === "editar" && modal.v.estado === "programado")) && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          {campo("inicio_en", "Salida", { type: "datetime-local", required: true })}
                          {campo("fin_en", "Llegada (opcional)", {
                            type: "datetime-local",
                            required: modal.tipo === "editar" && modal.v.estado === "cerrado",
                          })}
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          {campo("medidor_inicio", `${medidorEtiqueta} salida`, {
                            type: "number",
                            min: 0,
                            step: "0.1",
                          })}
                          {campo("medidor_fin", `${medidorEtiqueta} llegada`, {
                            type: "number",
                            min: 0,
                            step: "0.1",
                          })}
                        </div>
                        {modal.tipo === "editar" && modal.v.estado !== "programado" && (
                          <p className="text-xs text-amber-700">
                            Vas a cambiar algo ya registrado: el motivo de abajo queda en la
                            bitácora.
                          </p>
                        )}
                      </>
                    )}
                    {!retroVale &&
                      (modal.tipo === "nuevo" ||
                        (modal.tipo === "editar" && modal.v.estado !== "cerrado")) && (
                        <div className="space-y-1">
                          <div className="grid grid-cols-2 gap-3">
                            {campo("salida_programada_en", "Hora de salida programada (opcional)", {
                              type: "datetime-local",
                            })}
                            {campo("desfase_tolerancia_min", "Tolerancia (min)", {
                              type: "number",
                              min: 0,
                              max: 240,
                              step: 1,
                            })}
                          </div>
                          <p className="text-xs text-slate-500">
                            Con la hora, el viaje dice si salió antes o tarde; pasada la tolerancia
                            se marca.
                          </p>
                        </div>
                      )}
                    {campo("observaciones", "Observaciones (opcional)", { maxLength: 1000 })}
                    {modal.tipo === "editar" && modal.v.ruta_por_confirmar && (
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={rutaDudosa}
                          onChange={(e) => setRutaDudosa(e.target.checked)}
                        />
                        Ruta por confirmar (desmarca al dejarla correcta)
                      </label>
                    )}
                  </>
                )}

                {modal.tipo === "iniciar" && (
                  <>
                    <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700 space-y-1">
                      <p>
                        <strong>{ruta(modal.v)}</strong> · {unidadLabel(modal.v)}
                      </p>
                      <p>{modal.v.conductor_nombre ?? "Sin conductor"}</p>
                    </div>
                    <div className="space-y-1">
                      <span className={LABEL}>Último {medidorEtiqueta} registrado</span>
                      <div className="rounded-xl bg-slate-100 p-3 text-sm font-mono text-slate-600">
                        {previo === null
                          ? "Consultando..."
                          : previo.valor === null
                            ? "Sin lectura anterior"
                            : `${fmt(previo.valor, 1)} ${unidadMedidor}`}
                        {previo?.fuente && (
                          <span className="ml-2 font-sans text-xs text-slate-500">
                            (
                            {previo.fuente === "viaje"
                              ? "llegada del viaje anterior"
                              : "última carga"}
                            )
                          </span>
                        )}
                      </div>
                    </div>
                    {tipoMedidor &&
                      campo("medidor_inicio", `${medidorEtiqueta} que marca el tablero`, {
                        type: "number",
                        min: 0,
                        step: "0.1",
                        required: true,
                        autoFocus: true,
                      })}
                    {previo?.valor != null && form.medidor_inicio !== "" && (
                      <p
                        className={`text-xs ${
                          Number(form.medidor_inicio) < previo.valor
                            ? "text-red-600"
                            : "text-slate-600"
                        }`}
                      >
                        {Number(form.medidor_inicio) < previo.valor
                          ? "Es menor que el último registrado: revisa la lectura."
                          : `Recorrido fuera de viaje: ${fmt(Number(form.medidor_inicio) - previo.valor, 1)} ${unidadMedidor}`}
                      </p>
                    )}
                    <label className="flex items-start gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={rutaDudosa}
                        onChange={(e) => setRutaDudosa(e.target.checked)}
                      />
                      <span>
                        La ruta o la unidad no es la correcta: avisé a la oficina y salgo igual
                      </span>
                    </label>
                    {rutaDudosa &&
                      campo("nota_ruta", "¿Qué hay que corregir? (opcional)", { maxLength: 500 })}
                    <p className="text-xs text-slate-600">
                      {horaManual
                        ? "La hora la pones a mano: queda marcada como manual en la bitácora."
                        : "La hora de salida la registra el sistema al guardar."}
                    </p>
                    {permite("editar") && (
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={horaManual}
                          onChange={(e) => setHoraManual(e.target.checked)}
                        />
                        Poner la hora a mano (se olvidó de marcar)
                      </label>
                    )}
                    {horaManual && (
                      <div className="grid grid-cols-2 gap-3">
                        {campo("inicio_en", "Salida", { type: "datetime-local", required: true })}
                        {campo("motivo", "Motivo", {
                          required: true,
                          minLength: 3,
                          maxLength: 500,
                        })}
                      </div>
                    )}
                  </>
                )}

                {modal.tipo === "cerrar" && (
                  <>
                    <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700 space-y-1">
                      <p>
                        <strong>{ruta(modal.v)}</strong> · {unidadLabel(modal.v)}
                      </p>
                      <p>
                        Salió {fechaHora(modal.v.inicio_en)}
                        {modal.v.medidor_inicio &&
                          ` con ${fmt(Number(modal.v.medidor_inicio), 1)} ${unidadMedidor}`}
                      </p>
                    </div>
                    {campo("medidor_fin", `${medidorEtiqueta} que marca el tablero`, {
                      type: "number",
                      min: modal.v.medidor_inicio ? Number(modal.v.medidor_inicio) : 0,
                      step: "0.1",
                      required: modal.v.medidor_inicio !== null,
                      autoFocus: true,
                    })}
                    <p className="text-xs text-slate-600">
                      {horaManual
                        ? "La hora la pones a mano: queda marcada como manual en la bitácora."
                        : "La hora de llegada la registra el sistema al guardar."}
                    </p>
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={horaManual}
                        onChange={(e) => setHoraManual(e.target.checked)}
                      />
                      Poner la hora a mano (se olvidó de marcar)
                    </label>
                    {horaManual && (
                      <div className="grid grid-cols-2 gap-3">
                        {campo("fin_en", "Llegada", { type: "datetime-local", required: true })}
                        {campo("motivo", "Motivo", {
                          required: true,
                          minLength: 3,
                          maxLength: 500,
                        })}
                      </div>
                    )}
                  </>
                )}

                {(modal.tipo === "editar" || modal.tipo === "anular") && (
                  <div className="space-y-1">
                    {campo(
                      "motivo",
                      modal.tipo === "anular"
                        ? "Motivo de la anulación"
                        : "Motivo de la corrección",
                      {
                        required: true,
                        minLength: 3,
                        maxLength: 500,
                      }
                    )}
                    <p className="text-xs text-slate-600">
                      Queda en la bitácora con tu usuario.
                      {modal.tipo === "anular" &&
                        " El viaje deja de contar en el consumo, pero no se borra."}
                    </p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={guardando}
                  className="w-full bg-[#BADC1E] text-[#0D1719] font-bold py-3 rounded-2xl hover:brightness-110 disabled:opacity-50"
                >
                  {guardando
                    ? "Guardando..."
                    : modal.tipo === "anular"
                      ? "Anular viaje"
                      : modal.tipo === "iniciar"
                        ? "Iniciar viaje"
                        : modal.tipo === "cerrar"
                          ? "Marcar llegada"
                          : modal.tipo === "nuevo" && !retroVale
                            ? "Programar viaje"
                            : "Guardar"}
                </button>
              </form>
            }
          </div>
        </div>
      )}

      {verId && (
        <DetalleViajeVentana
          viajeId={verId}
          onCerrar={() => setVerId(null)}
          puedeEditar={permite("editar")}
        />
      )}
    </div>
  );
}
