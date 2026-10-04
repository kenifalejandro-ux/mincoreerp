// Surtidores (migración 0098): el aparato del grifo interno por el que sale el
// combustible, con su propio totalizador y su calibración (0108).
//
// Un tanque puede tener varios surtidores, y un surtidor puede alimentar a más
// de un tanque del mismo grifo. La conexión tiene historia: se conecta y se
// desconecta con motivo, desde ahora, y lo que ya pasó queda en el surtidor
// donde pasó.
//
// Diseño de dos niveles (rediseño 2026-10-03, aprobado por Kenif sobre un
// prototipo): una LISTA resumida con el estado de cada surtidor en una línea,
// y un DETALLE por surtidor con una sección por tema -- qué es, a la
// izquierda; cómo está, a la derecha -- cada una con su propio formulario en
// vez de los `window.prompt` de la versión anterior. Los permisos los decide
// el servidor (todo esto es del admin): acá se muestra el error que devuelva.
import { ChevronDown, ChevronRight, CircleAlert, Fuel, Plus, X } from "lucide-react";
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
  calibracion_emp_pct: string | null;
  calibracion_certificado: string | null;
  calibracion_vence: string | null;
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

const fechaHora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" }) : "—";

/** La conexión inicial de cada tanque es "desde siempre" (1900-01-01). */
const desde = (iso: string) =>
  new Date(iso).getFullYear() <= 1900 ? "desde siempre" : fechaHora(iso);

const fechaCorta = (iso: string) =>
  new Date(iso).toLocaleDateString("es-PE", { dateStyle: "medium" });

type EstadoCalibracion = "vencido" | "por_vencer" | "vigente" | null;

/** Vencido, o dentro de los 30 días previos: mismo margen que el resto de
 *  los avisos de vigencia del módulo. Null si no hay fecha cargada. */
function estadoCalibracion(vence: string | null): EstadoCalibracion {
  if (!vence) return null;
  const dias = (new Date(vence).getTime() - Date.now()) / 86_400_000;
  if (dias < 0) return "vencido";
  if (dias <= 30) return "por_vencer";
  return "vigente";
}

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

const texto = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

const CAMPO = "w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white";
const ETIQUETA = "text-xs font-bold uppercase text-slate-700";
const BTN =
  "px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50";
const BTN_PRIMARIO =
  "px-4 py-2 bg-slate-900 text-white text-sm font-semibold rounded-lg disabled:opacity-50";
const BTN_PELIGRO =
  "px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg disabled:opacity-50 hover:bg-red-700";
const BTN_TEXTO =
  "flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-[#a3e635] disabled:opacity-50";

/** Chip de estado: mismo lenguaje visual en toda la lista y el detalle. */
function Chip({
  tono,
  children,
}: {
  tono: "ok" | "warn" | "crit" | "neutro";
  children: React.ReactNode;
}) {
  const estilos = {
    ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
    warn: "border-amber-200 bg-amber-50 text-amber-700",
    crit: "border-red-200 bg-red-50 text-red-700",
    neutro: "border-slate-200 text-slate-500",
  }[tono];
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${estilos}`}
    >
      {children}
    </span>
  );
}

function chipTotalizador(s: Surtidor) {
  return s.usa_totalizador ? (
    <Chip tono="ok">Totalizador controlado</Chip>
  ) : (
    <Chip tono="neutro">Totalizador sin control</Chip>
  );
}

function chipCalibracion(s: Surtidor) {
  const e = estadoCalibracion(s.calibracion_vence);
  if (!s.calibracion_emp_pct && !s.calibracion_vence) {
    return <Chip tono="neutro">Sin certificado de calibración</Chip>;
  }
  if (e === "vencido") return <Chip tono="crit">Certificado vencido</Chip>;
  if (e === "por_vencer") return <Chip tono="warn">Certificado por vencer</Chip>;
  if (e === "vigente")
    return <Chip tono="ok">Calibrado hasta {fechaCorta(s.calibracion_vence!)}</Chip>;
  return <Chip tono="neutro">Certificado sin vencimiento</Chip>;
}

/** Error de un formulario inline: mismo lugar en los seis formularios. */
function ErrorForm({ mensaje }: { mensaje: string | null }) {
  if (!mensaje) return null;
  return <p className="text-sm text-red-600">{mensaje}</p>;
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
  const [toast, setToast] = useState<string | null>(null);
  const [errorForm, setErrorForm] = useState<string | null>(null);

  const [vista, setVista] = useState<"lista" | "detalle" | "nuevo">("lista");
  const [seleccionado, setSeleccionado] = useState<number | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const [bajasAbiertas, setBajasAbiertas] = useState(false);
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

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const actual = surtidores?.find((s) => s.id === seleccionado) ?? null;

  const ejecutar = async (accion: () => Promise<unknown>, mensaje: string) => {
    if (trabajando) return;
    setTrabajando(true);
    setErrorForm(null);
    try {
      await accion();
      setVuelta((v) => v + 1);
      setHistorial(null);
      setEditando(null);
      setToast(mensaje);
      onCambio();
    } catch (err) {
      setErrorForm(err instanceof Error ? err.message : "No se pudo completar");
    } finally {
      setTrabajando(false);
    }
  };

  const abrirDetalle = (id: number) => {
    setSeleccionado(id);
    setVista("detalle");
    setEditando(null);
    setHistorial(null);
    setErrorForm(null);
  };
  const volverALista = () => {
    setVista("lista");
    setEditando(null);
    setErrorForm(null);
  };
  const abrirEdicion = (que: string) => {
    setEditando(que);
    setErrorForm(null);
  };
  const cancelarEdicion = () => {
    setEditando(null);
    setErrorForm(null);
  };

  const verHistorial = async (s: Surtidor) => {
    if (historial?.id === s.id) {
      setHistorial(null);
      return;
    }
    const res = await apiFetch(`/api/erp/combustible/surtidores/${s.id}/conexiones`);
    setHistorial({ id: s.id, filas: res.ok ? ((await res.json()) as Conexion[]) : [] });
  };

  // ── Las seis acciones de escritura, una por formulario ──────────────────

  const onSubmitRenombrar = (s: Surtidor, e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const nombre = texto(new FormData(e.currentTarget), "nombre");
    if (!nombre) return setErrorForm("El nombre no puede quedar vacío.");
    if (nombre === s.nombre) return cancelarEdicion();
    void ejecutar(
      () => enviar(`/api/erp/combustible/surtidores/${s.id}`, "PUT", { nombre }),
      "Nombre actualizado"
    );
  };

  const onSubmitBaja = (s: Surtidor, e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const motivo = texto(new FormData(e.currentTarget), "motivo");
    if (!motivo) return setErrorForm("Escribe el motivo: queda en la auditoría.");
    void ejecutar(
      () => enviar(`/api/erp/combustible/surtidores/${s.id}/baja`, "PATCH", { motivo }),
      "Surtidor dado de baja"
    );
  };

  const onSubmitReactivar = (s: Surtidor, e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const motivo = texto(new FormData(e.currentTarget), "motivo");
    if (!motivo) return setErrorForm("Escribe el motivo de la reactivación.");
    void ejecutar(
      () => enviar(`/api/erp/combustible/surtidores/${s.id}/reactivar`, "PATCH", { motivo }),
      "Surtidor reactivado. Ahora conéctalo a su tanque."
    );
  };

  const onSubmitConectar = (s: Surtidor, e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const combustibleId = Number(fd.get("tanque"));
    const motivo = texto(fd, "motivo");
    if (!combustibleId) return setErrorForm("Elige el tanque que alimenta.");
    if (!motivo) return setErrorForm("Escribe el motivo de la conexión.");
    void ejecutar(
      () =>
        enviar(`/api/erp/combustible/surtidores/${s.id}/conexiones`, "POST", {
          combustible_id: combustibleId,
          motivo,
        }),
      "Tanque conectado"
    );
  };

  const onSubmitDesconectar = (
    s: Surtidor,
    conexionId: number,
    e: React.FormEvent<HTMLFormElement>
  ) => {
    e.preventDefault();
    const motivo = texto(new FormData(e.currentTarget), "motivo");
    if (!motivo) return setErrorForm("Escribe el motivo de la desconexión.");
    void ejecutar(
      () =>
        enviar(
          `/api/erp/combustible/surtidores/${s.id}/conexiones/${conexionId}/desconectar`,
          "PATCH",
          { motivo }
        ),
      "Tanque desconectado"
    );
  };

  const onSubmitTotalizador = (s: Surtidor, e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const controlar = fd.get("controlar") === "si";
    const tolTexto = texto(fd, "tol");
    const motivo = texto(fd, "motivo");
    if (controlar) {
      const tol = Number(tolTexto);
      if (!(tol >= 0 && tol <= 1000)) return setErrorForm("La diferencia tolerada va de 0 a 1000.");
    }
    const apaga = s.usa_totalizador && !controlar;
    if (apaga && !motivo) return setErrorForm("Para dejar de controlarlo hace falta el motivo.");
    void ejecutar(
      () =>
        enviar(`/api/erp/combustible/surtidores/${s.id}`, "PUT", {
          usa_totalizador: controlar,
          ...(controlar ? { totalizador_tolerancia: Number(tolTexto) } : {}),
          ...(apaga ? { motivo } : {}),
        }),
      controlar ? "El totalizador se controla" : "El totalizador ya no se controla"
    );
  };

  const onSubmitCalibracion = (s: Surtidor, e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const empTexto = texto(fd, "emp");
    const certificado = texto(fd, "cert");
    const vence = texto(fd, "vence");
    if (
      empTexto !== "" &&
      (Number.isNaN(Number(empTexto)) || Number(empTexto) < 0 || Number(empTexto) > 20)
    ) {
      return setErrorForm("El error máximo permitido va de 0 a 20 %.");
    }
    void ejecutar(
      () =>
        enviar(`/api/erp/combustible/surtidores/${s.id}/calibracion`, "PUT", {
          emp_pct: empTexto === "" ? null : Number(empTexto),
          certificado: certificado === "" ? null : certificado,
          vence: vence === "" ? null : vence,
        }),
      empTexto === "" && certificado === "" && vence === ""
        ? "Certificado quitado"
        : "Certificado guardado"
    );
  };

  const quitarCalibracion = (s: Surtidor) => {
    void ejecutar(
      () =>
        enviar(`/api/erp/combustible/surtidores/${s.id}/calibracion`, "PUT", {
          emp_pct: null,
          certificado: null,
          vence: null,
        }),
      "Certificado quitado"
    );
  };

  // Con un solo grifo en la empresa, no se pregunta en cuál va.
  const [grifoNuevo, setGrifoNuevo] = useState("");
  const [usaTotNuevo, setUsaTotNuevo] = useState(false);
  const onSubmitNuevo = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const nombre = texto(fd, "nombre");
    const grifoInternoId =
      grifos.hayVarios || grifos.grifosActivos.length === 0
        ? Number(grifoNuevo)
        : grifos.grifosActivos[0].id;
    if (!nombre) return setErrorForm("Escribe el nombre del surtidor.");
    if (!grifoInternoId) return setErrorForm("Elige el grifo interno.");
    const tolTexto = texto(fd, "tol");
    if (usaTotNuevo && (tolTexto === "" || Number.isNaN(Number(tolTexto)))) {
      return setErrorForm(
        "La diferencia tolerada es obligatoria si vas a controlar el totalizador."
      );
    }
    void ejecutar(async () => {
      const creado = await enviar("/api/erp/combustible/surtidores", "POST", {
        grifo_interno_id: grifoInternoId,
        nombre,
        usa_totalizador: usaTotNuevo,
        totalizador_tolerancia: usaTotNuevo ? Number(tolTexto) : 1,
      });
      setGrifoNuevo("");
      setUsaTotNuevo(false);
      setSeleccionado(creado.id as number);
      setVista("detalle");
    }, "Surtidor creado. Ahora conéctalo a su tanque.");
  };

  return (
    <VentanaFlotante
      id="combustible-surtidores"
      titulo="Surtidores"
      subtitulo="Las bombas por las que sale el combustible de tus tanques"
      onCerrar={onCerrar}
      anchoInicial={820}
      altoInicial={660}
    >
      <div className="relative flex flex-col h-full overflow-hidden">
        <div className="flex-1 overflow-auto p-6">
          {surtidores === null ? (
            <p className="text-sm text-slate-400">Cargando...</p>
          ) : vista === "nuevo" ? (
            <VistaNueva
              tanques={tanques}
              grifos={grifos}
              grifoNuevo={grifoNuevo}
              setGrifoNuevo={setGrifoNuevo}
              usaTotNuevo={usaTotNuevo}
              setUsaTotNuevo={setUsaTotNuevo}
              trabajando={trabajando}
              errorForm={errorForm}
              onVolver={volverALista}
              onSubmit={onSubmitNuevo}
            />
          ) : vista === "detalle" && actual ? (
            <VistaDetalle
              s={actual}
              tanques={tanques}
              trabajando={trabajando}
              editando={editando}
              errorForm={errorForm}
              historial={historial?.id === actual.id ? historial.filas : null}
              onVolver={volverALista}
              onAbrirEdicion={abrirEdicion}
              onCancelarEdicion={cancelarEdicion}
              onVerHistorial={() => verHistorial(actual)}
              onSubmitRenombrar={(e) => onSubmitRenombrar(actual, e)}
              onSubmitBaja={(e) => onSubmitBaja(actual, e)}
              onSubmitReactivar={(e) => onSubmitReactivar(actual, e)}
              onSubmitConectar={(e) => onSubmitConectar(actual, e)}
              onSubmitDesconectar={(conexionId, e) => onSubmitDesconectar(actual, conexionId, e)}
              onSubmitTotalizador={(e) => onSubmitTotalizador(actual, e)}
              onSubmitCalibracion={(e) => onSubmitCalibracion(actual, e)}
              onQuitarCalibracion={() => quitarCalibracion(actual)}
            />
          ) : (
            <VistaLista
              surtidores={surtidores}
              bajasAbiertas={bajasAbiertas}
              setBajasAbiertas={setBajasAbiertas}
              onAbrirDetalle={abrirDetalle}
              onNuevo={() => {
                setVista("nuevo");
                setErrorForm(null);
              }}
            />
          )}
        </div>
        {toast && (
          <div className="absolute left-1/2 -translate-x-1/2 bottom-4 bg-slate-900 text-white text-sm px-4 py-2 rounded-full shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </VentanaFlotante>
  );
}

// ── Vista: lista ──────────────────────────────────────────────────────────

function VistaLista({
  surtidores,
  bajasAbiertas,
  setBajasAbiertas,
  onAbrirDetalle,
  onNuevo,
}: {
  surtidores: Surtidor[];
  bajasAbiertas: boolean;
  setBajasAbiertas: (v: boolean) => void;
  onAbrirDetalle: (id: number) => void;
  onNuevo: () => void;
}) {
  const activos = surtidores.filter((s) => s.activo);
  const bajas = surtidores.filter((s) => !s.activo);
  const vencidos = activos.filter(
    (s) => estadoCalibracion(s.calibracion_vence) === "vencido"
  ).length;
  const porVencer = activos.filter(
    (s) => estadoCalibracion(s.calibracion_vence) === "por_vencer"
  ).length;
  const sinTanque = activos.filter((s) => s.tanques.length === 0).length;

  return (
    <div className="space-y-4">
      <p className="flex gap-2 text-xs text-slate-500">
        <CircleAlert className="w-4 h-4 shrink-0 text-[#a3e635] mt-0.5" />
        <span>
          Cada surtidor es una bomba por la que sale combustible de un tanque. Toca uno para ver qué
          tanque alimenta, si se controla su contador y si su medidor está calibrado.
        </span>
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-bold text-slate-800">
            {activos.length} {activos.length === 1 ? "surtidor activo" : "surtidores activos"}
          </span>
          {vencidos > 0 && <Chip tono="crit">{vencidos} con certificado vencido</Chip>}
          {porVencer > 0 && (
            <Chip tono="warn">
              {porVencer} {porVencer === 1 ? "certificado vence" : "certificados vencen"} pronto
            </Chip>
          )}
          {sinTanque > 0 && <Chip tono="warn">{sinTanque} sin tanque conectado</Chip>}
        </div>
        <button
          type="button"
          onClick={onNuevo}
          className={`${BTN_PRIMARIO} flex items-center gap-1.5`}
        >
          <Plus className="w-4 h-4" /> Nuevo surtidor
        </button>
      </div>
      <ul className="space-y-2">
        {activos.map((s) => (
          <FilaSurtidor key={s.id} s={s} onClick={() => onAbrirDetalle(s.id)} />
        ))}
      </ul>
      {bajas.length > 0 && (
        <div className="pt-2">
          <button
            type="button"
            className={BTN_TEXTO}
            onClick={() => setBajasAbiertas(!bajasAbiertas)}
          >
            {bajasAbiertas ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            Dados de baja ({bajas.length})
          </button>
          {bajasAbiertas && (
            <ul className="space-y-2 mt-2 opacity-60">
              {bajas.map((s) => (
                <FilaSurtidor key={s.id} s={s} onClick={() => onAbrirDetalle(s.id)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function FilaSurtidor({ s, onClick }: { s: Surtidor; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center gap-3.5 text-left px-4 py-3.5 border border-slate-200 rounded-xl hover:bg-slate-50 hover:border-slate-300 transition-colors"
      >
        <span className="shrink-0 w-10 h-10 grid place-items-center rounded-lg bg-[#a3e635]/10 text-[#a3e635]">
          <Fuel className="w-5 h-5" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block font-bold text-slate-800">{s.nombre}</span>
          <span className="block text-xs text-slate-500 mt-0.5">
            {!s.activo ? (
              `Dado de baja · ${s.motivo_baja ?? ""}`
            ) : s.tanques.length === 0 ? (
              <span className="text-amber-600">No alimenta ningún tanque: no puede despachar</span>
            ) : (
              "Alimenta a " + s.tanques.map((t) => `${t.codigo} — ${t.tanque_nombre}`).join(" y ")
            )}
          </span>
          {s.activo && (
            <span className="flex flex-wrap gap-1.5 mt-1.5">
              {chipTotalizador(s)}
              {chipCalibracion(s)}
            </span>
          )}
        </span>
        <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
      </button>
    </li>
  );
}

// ── Vista: nuevo surtidor ────────────────────────────────────────────────

function VistaNueva({
  tanques,
  grifos,
  grifoNuevo,
  setGrifoNuevo,
  usaTotNuevo,
  setUsaTotNuevo,
  trabajando,
  errorForm,
  onVolver,
  onSubmit,
}: {
  tanques: TanqueParaSurtidor[];
  grifos: ReturnType<typeof useSedes>;
  grifoNuevo: string;
  setGrifoNuevo: (v: string) => void;
  usaTotNuevo: boolean;
  setUsaTotNuevo: (v: boolean) => void;
  trabajando: boolean;
  errorForm: string | null;
  onVolver: () => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  void tanques;
  return (
    <div className="space-y-4 ">
      <button type="button" className={BTN_TEXTO} onClick={onVolver}>
        <X className="w-3.5 h-3.5 text-slate-500 hover:text-[#a3e635]" /> Volver a la lista
      </button>
      <div>
        <h3 className="text-lg font-bold text-slate-800">Nuevo surtidor</h3>
        <p className="text-sm text-slate-500">
          Se agrega al grifo interno. Después de crearlo lo conectás al tanque del que saca
          combustible.
        </p>
      </div>
      <form onSubmit={onSubmit} className="space-y-4 border border-slate-200 rounded-xl p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {grifos.hayVarios && (
            <div className="space-y-1">
              <label htmlFor="n-grifo" className={ETIQUETA}>
                Grifo interno
              </label>
              <select
                id="n-grifo"
                className={CAMPO}
                value={grifoNuevo}
                onChange={(e) => setGrifoNuevo(e.target.value)}
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
            <label htmlFor="n-nombre" className={ETIQUETA}>
              Nombre
            </label>
            <input
              id="n-nombre"
              name="nombre"
              maxLength={80}
              className={CAMPO}
              placeholder="Ej.: Surtidor 2 (manguera larga)"
            />
            <p className="text-xs text-slate-500">
              Como lo conoce la gente de cancha. No puede repetir el nombre de otro surtidor del
              grifo.
            </p>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-600 border border-slate-200 rounded-xl p-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={usaTotNuevo}
            onChange={(e) => setUsaTotNuevo(e.target.checked)}
          />
          <span>
            <span className="font-bold text-slate-800 block">Controlar su totalizador</span>
            El grifero anota la lectura del contador en cada vale y en cada varilla. Se puede
            cambiar después.
          </span>
        </label>
        {usaTotNuevo && (
          <div className="space-y-1 max-w-xs">
            <label htmlFor="n-tol" className={ETIQUETA}>
              Diferencia tolerada
            </label>
            <input
              id="n-tol"
              name="tol"
              type="number"
              min={0}
              max={1000}
              step="0.001"
              defaultValue="1"
              className={CAMPO}
            />
          </div>
        )}
        <ErrorForm mensaje={errorForm} />
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onVolver}>
            Cancelar
          </button>
          <button type="submit" disabled={trabajando} className={BTN_PRIMARIO}>
            Crear surtidor
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Vista: detalle ───────────────────────────────────────────────────────

function VistaDetalle({
  s,
  tanques,
  trabajando,
  editando,
  errorForm,
  historial,
  onVolver,
  onAbrirEdicion,
  onCancelarEdicion,
  onVerHistorial,
  onSubmitRenombrar,
  onSubmitBaja,
  onSubmitReactivar,
  onSubmitConectar,
  onSubmitDesconectar,
  onSubmitTotalizador,
  onSubmitCalibracion,
  onQuitarCalibracion,
}: {
  s: Surtidor;
  tanques: TanqueParaSurtidor[];
  trabajando: boolean;
  editando: string | null;
  errorForm: string | null;
  historial: Conexion[] | null;
  onVolver: () => void;
  onAbrirEdicion: (que: string) => void;
  onCancelarEdicion: () => void;
  onVerHistorial: () => void;
  onSubmitRenombrar: (e: React.FormEvent<HTMLFormElement>) => void;
  onSubmitBaja: (e: React.FormEvent<HTMLFormElement>) => void;
  onSubmitReactivar: (e: React.FormEvent<HTMLFormElement>) => void;
  onSubmitConectar: (e: React.FormEvent<HTMLFormElement>) => void;
  onSubmitDesconectar: (conexionId: number, e: React.FormEvent<HTMLFormElement>) => void;
  onSubmitTotalizador: (e: React.FormEvent<HTMLFormElement>) => void;
  onSubmitCalibracion: (e: React.FormEvent<HTMLFormElement>) => void;
  onQuitarCalibracion: () => void;
}) {
  const conectados = new Set(s.tanques.map((t) => t.combustible_id));
  const conectables = tanques.filter(
    (t) => t.activo && t.grifo_interno_id === s.grifo_interno_id && !conectados.has(t.id)
  );

  return (
    <div className="space-y-5">
      <button type="button" className={BTN_TEXTO} onClick={onVolver}>
        <X className="w-3.5 h-3.5 text-slate-500 hover:text-[#a3e635]" /> Volver a la lista
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-bold text-slate-800">{s.nombre}</h3>
          <p className="text-sm text-slate-500 mt-0.5">
            {s.activo ? "Activo" : `Dado de baja · ${s.motivo_baja ?? ""}`}
          </p>
        </div>
        {editando !== "renombrar" && editando !== "baja" && editando !== "reactivar" && (
          <div className="flex gap-2">
            {s.activo ? (
              <>
                <button type="button" className={BTN} onClick={() => onAbrirEdicion("renombrar")}>
                  Renombrar
                </button>
                <button
                  type="button"
                  className={`${BTN} text-red-600 border-red-200 hover:bg-red-50`}
                  onClick={() => onAbrirEdicion("baja")}
                >
                  Dar de baja
                </button>
              </>
            ) : (
              <button type="button" className={BTN} onClick={() => onAbrirEdicion("reactivar")}>
                Reactivar
              </button>
            )}
          </div>
        )}
      </div>

      {editando === "renombrar" && (
        <form
          onSubmit={onSubmitRenombrar}
          className="space-y-3 border border-slate-200 rounded-xl p-4"
        >
          <div className="space-y-1">
            <label htmlFor="f-nombre" className={ETIQUETA}>
              Nuevo nombre
            </label>
            <input
              id="f-nombre"
              name="nombre"
              maxLength={80}
              defaultValue={s.nombre}
              className={CAMPO}
            />
          </div>
          <ErrorForm mensaje={errorForm} />
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN} onClick={onCancelarEdicion}>
              Cancelar
            </button>
            <button type="submit" disabled={trabajando} className={BTN_PRIMARIO}>
              Guardar nombre
            </button>
          </div>
        </form>
      )}

      {editando === "baja" && (
        <form onSubmit={onSubmitBaja} className="space-y-3 border border-red-200 rounded-xl p-4">
          <p className="font-bold text-slate-800">Dar de baja {s.nombre}</p>
          <p className="text-sm text-slate-500">
            Se desconecta de sus tanques y deja de poder despachar. Lo que ya se registró queda en
            su historial.
          </p>
          <div className="space-y-1">
            <label htmlFor="f-motivo-baja" className={ETIQUETA}>
              Motivo
            </label>
            <textarea
              id="f-motivo-baja"
              name="motivo"
              rows={2}
              maxLength={500}
              placeholder="Ej.: se retiró la bomba para mantenimiento"
              className={CAMPO}
            />
          </div>
          <ErrorForm mensaje={errorForm} />
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN} onClick={onCancelarEdicion}>
              Cancelar
            </button>
            <button type="submit" disabled={trabajando} className={BTN_PELIGRO}>
              Dar de baja
            </button>
          </div>
        </form>
      )}

      {editando === "reactivar" && (
        <form
          onSubmit={onSubmitReactivar}
          className="space-y-3 border border-slate-200 rounded-xl p-4"
        >
          <p className="text-sm text-slate-500">
            Vuelve sin tanques: las conexiones se hacen de nuevo a mano, desde ahora.
          </p>
          <div className="space-y-1">
            <label htmlFor="f-motivo-react" className={ETIQUETA}>
              Motivo
            </label>
            <textarea
              id="f-motivo-react"
              name="motivo"
              rows={2}
              maxLength={500}
              className={CAMPO}
            />
          </div>
          <ErrorForm mensaje={errorForm} />
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN} onClick={onCancelarEdicion}>
              Cancelar
            </button>
            <button type="submit" disabled={trabajando} className={BTN_PRIMARIO}>
              Reactivar
            </button>
          </div>
        </form>
      )}

      <div className="divide-y divide-slate-200 border-t border-slate-200">
        {/* Tanques que alimenta */}
        <Seccion
          titulo={s.tanques.length > 1 ? "Tanques que alimenta" : "Tanque que alimenta"}
          que="De dónde sale el combustible que despacha este surtidor. Solo se conectan tanques del mismo grifo."
        >
          {!s.activo ? (
            <p className="text-sm text-slate-500">
              Dado de baja, no alimenta ningún tanque. Al reactivarlo se conecta de nuevo a mano.
            </p>
          ) : (
            <>
              {s.tanques.length === 0 ? (
                <p className="flex gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <CircleAlert className="w-4 h-4 shrink-0 mt-0.5" />
                  Todavía no alimenta ningún tanque, así que no puede despachar. Conectalo al tanque
                  del que saca combustible.
                </p>
              ) : (
                <ul className="space-y-2">
                  {s.tanques.map((t) => (
                    <li key={t.conexion_id}>
                      {editando === `desconectar:${t.conexion_id}` ? (
                        <form
                          onSubmit={(e) => onSubmitDesconectar(t.conexion_id, e)}
                          className="space-y-3 border border-red-200 rounded-xl p-3"
                        >
                          <p className="font-bold text-sm text-slate-800">
                            Desconectar {t.codigo} de {s.nombre}
                          </p>
                          <div className="space-y-1">
                            <label htmlFor={`f-motivo-des-${t.conexion_id}`} className={ETIQUETA}>
                              Motivo
                            </label>
                            <input
                              id={`f-motivo-des-${t.conexion_id}`}
                              name="motivo"
                              maxLength={500}
                              className={CAMPO}
                            />
                          </div>
                          <ErrorForm mensaje={errorForm} />
                          <div className="flex justify-end gap-2">
                            <button type="button" className={BTN} onClick={onCancelarEdicion}>
                              Cancelar
                            </button>
                            <button type="submit" disabled={trabajando} className={BTN_PELIGRO}>
                              Desconectar
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="flex items-center justify-between gap-2 border border-slate-200 rounded-xl px-3 py-2 text-sm">
                          <span>
                            <strong>{t.codigo}</strong> — {t.tanque_nombre}
                          </span>
                          {s.activo && (
                            <button
                              type="button"
                              className={BTN}
                              onClick={() => onAbrirEdicion(`desconectar:${t.conexion_id}`)}
                            >
                              Desconectar
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {editando === "conectar" ? (
                <form
                  onSubmit={onSubmitConectar}
                  className="space-y-3 border border-slate-200 rounded-xl p-3"
                >
                  <div className="space-y-1">
                    <label htmlFor="f-tanque" className={ETIQUETA}>
                      Tanque
                    </label>
                    <select id="f-tanque" name="tanque" className={CAMPO}>
                      <option value="">Elegir tanque del mismo grifo</option>
                      {conectables.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.codigo} — {t.tanque_nombre}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="f-motivo-con" className={ETIQUETA}>
                      Motivo
                    </label>
                    <input
                      id="f-motivo-con"
                      name="motivo"
                      maxLength={500}
                      placeholder="Ej.: instalación de la bomba nueva"
                      className={CAMPO}
                    />
                  </div>
                  <p className="text-xs text-slate-500">
                    Vale desde ahora. Los vales anteriores siguen asociados al surtidor de su fecha.
                  </p>
                  <ErrorForm mensaje={errorForm} />
                  <div className="flex justify-end gap-2">
                    <button type="button" className={BTN} onClick={onCancelarEdicion}>
                      Cancelar
                    </button>
                    <button type="submit" disabled={trabajando} className={BTN_PRIMARIO}>
                      Conectar
                    </button>
                  </div>
                </form>
              ) : (
                conectables.length > 0 && (
                  <button
                    type="button"
                    className={`${BTN} flex items-center gap-1`}
                    onClick={() => onAbrirEdicion("conectar")}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {s.tanques.length ? "Conectar otro tanque" : "Conectar tanque"}
                  </button>
                )
              )}
            </>
          )}
        </Seccion>

        {/* Totalizador */}
        <Seccion
          titulo="Contador totalizador"
          que="El contador del surtidor que nunca vuelve a cero. Si se controla, el grifero anota su lectura en cada vale y en cada varilla, y el sistema avisa cuando salta o retrocede: combustible que salió sin vale."
        >
          {editando === "totalizador" ? (
            <FormTotalizador
              s={s}
              trabajando={trabajando}
              errorForm={errorForm}
              onSubmit={onSubmitTotalizador}
              onCancelar={onCancelarEdicion}
            />
          ) : s.usa_totalizador ? (
            <>
              <p className="flex items-center gap-1.5 font-bold text-emerald-700 text-sm">
                Se controla en cada vale y en cada varilla
              </p>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1 text-sm">
                <dt className="text-slate-500">Última lectura</dt>
                <dd className="font-mono">
                  {Number(s.totalizador_actual).toLocaleString("es-PE")}
                </dd>
                <dt className="text-slate-500">Diferencia tolerada</dt>
                <dd className="font-mono">±{Number(s.totalizador_tolerancia)}</dd>
              </dl>
              {s.activo && (
                <button type="button" className={BTN} onClick={() => onAbrirEdicion("totalizador")}>
                  Cambiar
                </button>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-slate-500">No se controla</p>
              <p className="text-xs text-slate-400">
                Los vales y las varillas de este surtidor no piden la lectura del contador.
              </p>
              {s.activo && (
                <button type="button" className={BTN} onClick={() => onAbrirEdicion("totalizador")}>
                  Cambiar
                </button>
              )}
            </>
          )}
        </Seccion>

        {/* Calibración */}
        <Seccion
          titulo="Calibración del contómetro"
          que="Lo que dice el certificado sobre cuánto se puede equivocar el contómetro del surtidor. Con ese dato el sistema separa un contómetro descalibrado de un faltante real."
        >
          {editando === "calibracion" ? (
            <FormCalibracion
              s={s}
              trabajando={trabajando}
              errorForm={errorForm}
              onSubmit={onSubmitCalibracion}
              onCancelar={onCancelarEdicion}
              onQuitar={
                s.calibracion_emp_pct || s.calibracion_certificado || s.calibracion_vence
                  ? onQuitarCalibracion
                  : undefined
              }
            />
          ) : !s.calibracion_emp_pct && !s.calibracion_certificado && !s.calibracion_vence ? (
            <>
              <p className="text-sm text-slate-500">Sin certificado cargado</p>
              <p className="text-xs text-slate-400">
                Mientras falte, el sistema no puede saber si una diferencia que se repite viene del
                medidor o de un faltante.
              </p>
              {s.activo && (
                <button
                  type="button"
                  className={`${BTN} flex items-center gap-1`}
                  onClick={() => onAbrirEdicion("calibracion")}
                >
                  <Plus className="w-3.5 h-3.5" /> Cargar certificado
                </button>
              )}
            </>
          ) : (
            <>
              <LineaCalibracion vence={s.calibracion_vence} />
              <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1 text-sm">
                <dt className="text-slate-500">Error máximo permitido</dt>
                <dd className="font-mono">
                  {s.calibracion_emp_pct !== null ? `±${Number(s.calibracion_emp_pct)} %` : "—"}
                </dd>
                <dt className="text-slate-500">N.º de certificado</dt>
                <dd>{s.calibracion_certificado || "—"}</dd>
                <dt className="text-slate-500">Vence</dt>
                <dd>{s.calibracion_vence ? fechaCorta(s.calibracion_vence) : "—"}</dd>
              </dl>
              {s.activo && (
                <button type="button" className={BTN} onClick={() => onAbrirEdicion("calibracion")}>
                  Editar
                </button>
              )}
            </>
          )}
        </Seccion>

        {/* Historial */}
        <section className="py-4">
          <button type="button" className={BTN_TEXTO} onClick={onVerHistorial}>
            {historial ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            Historial de conexiones
          </button>
          {historial && (
            <ul className="text-xs text-slate-600 space-y-1.5 mt-2 ml-5 list-disc">
              {historial.map((c) => (
                <li key={c.id}>
                  <strong>{c.codigo}</strong>: {desde(c.conectado_en)}
                  {c.conectado_por ? ` (${c.conectado_por})` : ""}
                  {c.motivo_conexion ? ` · ${c.motivo_conexion}` : ""}
                  {c.desconectado_en &&
                    ` → desconectado ${fechaHora(c.desconectado_en)}${
                      c.desconectado_por ? ` (${c.desconectado_por})` : ""
                    } · ${c.motivo_desconexion ?? ""}`}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Seccion({
  titulo,
  que,
  children,
}: {
  titulo: string;
  que: string;
  children: React.ReactNode;
}) {
  return (
    <section className="py-5 grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-3 lg:gap-8">
      <div>
        <h4 className="font-bold text-sm text-slate-800">{titulo}</h4>
        <p className="text-xs text-slate-500 mt-1">{que}</p>
      </div>
      <div className="space-y-2.5 min-w-0">{children}</div>
    </section>
  );
}

function LineaCalibracion({ vence }: { vence: string | null }) {
  const e = estadoCalibracion(vence);
  if (e === "vigente")
    return <p className="font-bold text-emerald-700 text-sm">Certificado vigente</p>;
  if (e === "por_vencer")
    return (
      <p className="font-bold text-amber-700 text-sm">
        Vence pronto: hay que pedir la recalibración
      </p>
    );
  if (e === "vencido")
    return (
      <p className="font-bold text-red-700 text-sm">
        Vencido: el medidor opera sin calibración vigente
      </p>
    );
  return <p className="text-sm text-slate-500">Sin fecha de vencimiento cargada</p>;
}

function FormTotalizador({
  s,
  trabajando,
  errorForm,
  onSubmit,
  onCancelar,
}: {
  s: Surtidor;
  trabajando: boolean;
  errorForm: string | null;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onCancelar: () => void;
}) {
  const [controlar, setControlar] = useState(s.usa_totalizador);
  const apaga = s.usa_totalizador && !controlar;
  return (
    <form onSubmit={onSubmit} className="space-y-3 border border-slate-200 rounded-xl p-3">
      <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <legend className="sr-only">¿Se controla el totalizador?</legend>
        <label
          className={`flex items-start gap-2 border rounded-xl p-3 text-sm cursor-pointer ${controlar ? "border-slate-800 bg-slate-50" : "border-slate-200"}`}
        >
          <input
            type="radio"
            name="controlar"
            value="si"
            checked={controlar}
            onChange={() => setControlar(true)}
            className="mt-0.5"
          />
          <span>
            <span className="font-bold text-slate-800 block">Controlarlo</span>
            El grifero anota la lectura del contador en cada vale y en cada varilla.
          </span>
        </label>
        <label
          className={`flex items-start gap-2 border rounded-xl p-3 text-sm cursor-pointer ${!controlar ? "border-slate-800 bg-slate-50" : "border-slate-200"}`}
        >
          <input
            type="radio"
            name="controlar"
            value="no"
            checked={!controlar}
            onChange={() => setControlar(false)}
            className="mt-0.5"
          />
          <span>
            <span className="font-bold text-slate-800 block">No controlarlo</span>
            Los vales y las varillas no piden la lectura.
          </span>
        </label>
      </fieldset>
      {controlar && (
        <div className="space-y-1 max-w-xs">
          <label htmlFor="f-tol" className={ETIQUETA}>
            Diferencia tolerada
          </label>
          <input
            id="f-tol"
            name="tol"
            type="number"
            min={0}
            max={1000}
            step="0.001"
            defaultValue={s.totalizador_tolerancia}
            className={CAMPO}
          />
          <p className="text-xs text-slate-500">
            Cuánto puede diferir la lectura anotada de la esperada sin que el sistema avise. Cubre
            el redondeo al leer el contador.
          </p>
        </div>
      )}
      {apaga && (
        <>
          <p className="flex gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
            <CircleAlert className="w-4 h-4 shrink-0 mt-0.5" />
            Dejar de controlarlo afloja la vigilancia. El cambio queda registrado y se avisa por
            correo a los administradores.
          </p>
          <div className="space-y-1">
            <label htmlFor="f-motivo-tot" className={ETIQUETA}>
              Motivo
            </label>
            <textarea
              id="f-motivo-tot"
              name="motivo"
              rows={2}
              maxLength={500}
              placeholder="Ej.: el contador se rompió y se cambia la semana que viene"
              className={CAMPO}
            />
          </div>
        </>
      )}
      <ErrorForm mensaje={errorForm} />
      <div className="flex justify-end gap-2">
        <button type="button" className={BTN} onClick={onCancelar}>
          Cancelar
        </button>
        <button type="submit" disabled={trabajando} className={BTN_PRIMARIO}>
          Guardar
        </button>
      </div>
    </form>
  );
}

function FormCalibracion({
  s,
  trabajando,
  errorForm,
  onSubmit,
  onCancelar,
  onQuitar,
}: {
  s: Surtidor;
  trabajando: boolean;
  errorForm: string | null;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onCancelar: () => void;
  onQuitar?: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-3 border border-slate-200 rounded-xl p-3">
      <div className="space-y-1 max-w-xs">
        <label htmlFor="f-emp" className={ETIQUETA}>
          Error máximo permitido
        </label>
        <div className="flex items-stretch">
          <span className="flex items-center px-2.5 border border-r-0 border-slate-200 rounded-l-xl bg-slate-50 text-sm text-slate-500">
            ±
          </span>
          <input
            id="f-emp"
            name="emp"
            type="number"
            min={0}
            max={20}
            step="0.01"
            defaultValue={s.calibracion_emp_pct ?? ""}
            placeholder="0.5"
            className="w-full border border-slate-200 p-3 text-sm outline-none"
          />
          <span className="flex items-center px-2.5 border border-l-0 border-slate-200 rounded-r-xl bg-slate-50 text-sm text-slate-500">
            %
          </span>
        </div>
        <p className="text-xs text-slate-500">
          En el certificado figura como «error máximo permisible» (EMP), en porcentaje del volumen
          medido.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="f-cert" className={ETIQUETA}>
            N.º de certificado
          </label>
          <input
            id="f-cert"
            name="cert"
            maxLength={80}
            defaultValue={s.calibracion_certificado ?? ""}
            placeholder="Ej.: INACAL-LM-2026-0481"
            className={CAMPO}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="f-vence" className={ETIQUETA}>
            Vence el
          </label>
          <input
            id="f-vence"
            name="vence"
            type="date"
            defaultValue={s.calibracion_vence ?? ""}
            className={CAMPO}
          />
        </div>
      </div>
      <p className="text-xs text-slate-500">
        El panel avisa cuando faltan 30 días o menos para el vencimiento.
      </p>
      <ErrorForm mensaje={errorForm} />
      <div className="flex justify-between items-center gap-2">
        {onQuitar ? (
          <button
            type="button"
            className="text-xs font-semibold text-red-600 hover:text-red-800"
            onClick={onQuitar}
          >
            Quitar certificado
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button type="button" className={BTN} onClick={onCancelar}>
            Cancelar
          </button>
          <button type="submit" disabled={trabajando} className={BTN_PRIMARIO}>
            Guardar
          </button>
        </div>
      </div>
    </form>
  );
}
