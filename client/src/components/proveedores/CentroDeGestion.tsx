// client/src/components/proveedores/CentroDeGestion.tsx
//
// Pantalla de inicio del ecosistema, como la maqueta: cuatro tarjetas, «Requieren tu atención», la calidad de
// las fichas, los movimientos recientes (solo el admin) y los proveedores por tipo. Todas las cifras salen de
// los proveedores y precios que ya existen en el ERP: nada de ejemplo. Lo que todavía no existe (documentos,
// homologación) se dice «Pronto», no se inventa.
import {
  AlertTriangle,
  Building2,
  Check,
  ChevronRight,
  FolderOpen,
  Plus,
  ShieldCheck,
  Star,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  atencionDelCentro,
  cifrasDelCentro,
  degradadoDeDona,
  enMinuscula,
  fechaLarga,
  inicialesDe,
  tiempoRelativo,
  trozosPorTipo,
  type DestinoDelCentro,
  type TonoDeAtencion,
} from "./centroDeGestion";
import FormularioProveedor from "./FormularioProveedor";
import { puedeVerHistorialDeProveedores } from "./historialProveedores";
import { Panel } from "./PanelesDeFicha";
import { puedeVerPreciosDeProveedores } from "./proveedoresAcceso";
import { useDatosDelCentro } from "./useDatosDelCentro";
import { useAuth } from "../../context/AuthContext";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";

function saludo(): string {
  const hora = new Date().getHours();
  return hora < 12 ? "Buenos días" : hora < 19 ? "Buenas tardes" : "Buenas noches";
}

type TonoDeTarjeta = "lima" | "verde" | "ambar" | "rojo";
const TONO_TARJETA: Record<TonoDeTarjeta, string> = {
  lima: "bg-[#BADC1E]/25 text-[#3f6212]",
  verde: "bg-emerald-50 text-emerald-700",
  ambar: "bg-amber-50 text-amber-600",
  rojo: "bg-red-50 text-red-600",
};

function Tarjeta({
  etiqueta,
  valor,
  detalle,
  Icono,
  tono,
  onAbrir,
}: {
  etiqueta: string;
  valor: number | string;
  detalle: string;
  Icono: LucideIcon;
  tono: TonoDeTarjeta;
  /** Sin función, la tarjeta no es un botón. */
  onAbrir?: () => void;
}) {
  const contenido = (
    <>
      <span className={`grid h-10 w-10 place-items-center rounded-lg ${TONO_TARJETA[tono]}`}>
        <Icono size={20} />
      </span>
      <span className="mt-3 block text-xs font-semibold text-slate-500">{etiqueta}</span>
      <strong className="block text-[26px] font-extrabold leading-tight text-slate-900 tabular-nums">
        {valor}
      </strong>
      <span className="block text-xs text-slate-500">{detalle}</span>
    </>
  );
  const clase = "block w-full text-left bg-white border border-slate-200 rounded-xl shadow-sm p-5";
  return onAbrir ? (
    <button onClick={onAbrir} className={`${clase} hover:border-[#84cc16]`}>
      {contenido}
    </button>
  ) : (
    <article className={clase}>{contenido}</article>
  );
}

const TONO_ATENCION: Record<TonoDeAtencion, string> = {
  ambar: "bg-amber-50 text-amber-600",
  rojo: "bg-red-50 text-red-600",
  azul: "bg-blue-50 text-blue-600",
};

const TONO_AVATAR: Record<string, string> = {
  proveedor: "bg-blue-100 text-blue-700",
  precios: "bg-amber-100 text-amber-700",
  compras: "bg-emerald-100 text-emerald-700",
  ficha: "bg-slate-200 text-slate-700",
  cuentas: "bg-purple-100 text-purple-700",
};

export default function CentroDeGestion({ onIr }: { onIr: (destino: DestinoDelCentro) => void }) {
  const { usuario } = useAuth();
  const verPrecios = puedeVerPreciosDeProveedores(usuario);
  const verHistorial = puedeVerHistorialDeProveedores(usuario);
  const puedeEscribir = usePuedeEscribir("proveedores");
  const { lista, precios, eventos, error, recargar } = useDatosDelCentro(verPrecios, verHistorial);
  const [registrando, setRegistrando] = useState(false);
  const [ahora] = useState(() => Date.now());

  const cifras = useMemo(() => cifrasDelCentro(lista ?? []), [lista]);
  const atencion = useMemo(
    () => atencionDelCentro(cifras, precios, ahora),
    [cifras, precios, ahora]
  );
  const trozos = useMemo(() => trozosPorTipo(lista ?? []), [lista]);
  const cargando = lista === null && !error;
  const num = (n: number | null) => (cargando || n === null ? "—" : n);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            Proveedores / Centro de gestión
          </p>
          <h1 className="text-3xl font-semibold text-slate-900 mt-1">
            {saludo()}
            {usuario?.nombre ? `, ${usuario.nombre.split(" ")[0]}` : ""}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Situación de tus proveedores de combustible y urea al {fechaLarga(ahora)}.
          </p>
        </div>
        {puedeEscribir && (
          <button
            onClick={() => setRegistrando(true)}
            className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
          >
            <Plus size={16} /> Registrar proveedor
          </button>
        )}
      </header>

      {error && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {error}
        </p>
      )}

      <section aria-label="Resumen" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tarjeta
          etiqueta="Proveedores registrados"
          valor={num(cifras.total)}
          detalle={`Combustible ${cifras.combustible} · Urea ${cifras.urea}`}
          Icono={Building2}
          tono="lima"
          onAbrir={() => onIr("directorio")}
        />
        <Tarjeta
          etiqueta="Activos"
          valor={num(cifras.activos)}
          detalle={`${cifras.pctActivos} % del directorio`}
          Icono={ShieldCheck}
          tono="verde"
          onAbrir={() => onIr("directorio")}
        />
        <Tarjeta
          etiqueta="Activos sin precio vigente"
          valor={num(cifras.activosSinPrecio)}
          detalle={verPrecios ? "Sin acuerdo cargado" : "Sin acceso a precios"}
          Icono={Star}
          tono="ambar"
          onAbrir={verPrecios ? () => onIr("comercial") : undefined}
        />
        <Tarjeta
          etiqueta="Documentos por vencer"
          valor="—"
          detalle="Pronto"
          Icono={FolderOpen}
          tono="rojo"
          onAbrir={() => onIr("documentos")}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel kicker="Prioridades" titulo="Requieren tu atención">
          <div className="pb-2">
            {atencion.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 border-t border-slate-100 px-5 py-3"
              >
                <span
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${TONO_ATENCION[a.tono]}`}
                >
                  {a.id === "fichas-incompletas" ? (
                    <Users size={18} />
                  ) : a.tono === "rojo" ? (
                    <AlertTriangle size={18} />
                  ) : (
                    <Star size={18} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <b className="block text-sm text-slate-900">{a.titulo}</b>
                  <span className="block text-xs text-slate-500">{a.detalle}</span>
                </div>
                <button
                  onClick={() => onIr(a.destino)}
                  className="flex shrink-0 items-center gap-1 text-xs font-semibold text-[#3f6212] hover:underline"
                >
                  {a.accion} <ChevronRight size={14} />
                </button>
              </div>
            ))}
            {atencion.length === 0 && (
              <div className="flex items-center gap-3 border-t border-slate-100 px-5 py-3">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-50 text-emerald-700">
                  <Check size={18} />
                </span>
                <div>
                  <b className="block text-sm text-slate-900">
                    {cargando ? "Cargando…" : "Todo al día"}
                  </b>
                  <span className="block text-xs text-slate-500">
                    {cargando ? "" : "No hay pendientes"}
                  </span>
                </div>
              </div>
            )}
          </div>
        </Panel>

        <Panel kicker="Calidad de datos" titulo="Estado de las fichas">
          <div className="flex items-center gap-5 px-5 pb-4">
            <div
              role="img"
              aria-label={`${cifras.promedioDeFichas} % de ficha completa en promedio`}
              className="grid h-24 w-24 shrink-0 place-items-center rounded-full"
              style={{
                background: `conic-gradient(#84cc16 0 ${cifras.promedioDeFichas}%, #e2e8f0 ${cifras.promedioDeFichas}%)`,
              }}
            >
              <div className="grid h-[78px] w-[78px] place-items-center rounded-full bg-white text-center leading-none">
                <span>
                  <strong className="block text-2xl font-extrabold text-slate-900">
                    {num(cifras.promedioDeFichas)}
                  </strong>
                  <span className="text-[10px] text-slate-500">% promedio</span>
                </span>
              </div>
            </div>
            <div>
              <b className="text-sm text-slate-900">Ficha completa</b>
              <p className="text-xs text-slate-500">Promedio de todos los proveedores</p>
            </div>
          </div>
          <div className="space-y-3 px-5 pb-5">
            {[
              verPrecios && cifras.pctConPrecio !== null
                ? { nombre: "Activos con precio vigente", valor: cifras.pctConPrecio }
                : null,
              { nombre: "Fichas completas (promedio)", valor: cifras.promedioDeFichas },
            ]
              .filter((m): m is { nombre: string; valor: number } => m !== null)
              .map((m) => (
                <div key={m.nombre}>
                  <span className="flex justify-between text-xs text-slate-600">
                    {m.nombre}
                    <b className="text-slate-900">{cargando ? "—" : `${m.valor}%`}</b>
                  </span>
                  <i className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <em
                      className="block h-full rounded-full bg-[#84cc16]"
                      style={{ width: `${cargando ? 0 : m.valor}%` }}
                    />
                  </i>
                </div>
              ))}
            <span className="flex justify-between text-xs text-slate-600">
              Documentos vigentes
              <b className="text-slate-400">Pronto</b>
            </span>
          </div>
        </Panel>
      </div>

      <div className={`grid gap-4 ${verHistorial ? "lg:grid-cols-2" : ""}`}>
        {verHistorial && (
          <Panel kicker="Actividad" titulo="Movimientos recientes">
            <div className="px-5 pb-4">
              {eventos === null && <p className="text-sm text-slate-500">Cargando…</p>}
              {eventos !== null && eventos.length === 0 && (
                <p className="text-sm text-slate-500">Todavía no hay movimientos.</p>
              )}
              {(eventos ?? []).map((e) => (
                <div
                  key={e.id}
                  className="flex items-start gap-3 border-t border-slate-100 py-3 first:border-t-0"
                >
                  <span
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-bold ${TONO_AVATAR[e.categoria ?? "ficha"] ?? TONO_AVATAR.ficha}`}
                  >
                    {inicialesDe(e.actor)}
                  </span>
                  <div className="min-w-0 text-sm text-slate-700">
                    <b className="text-slate-900">{e.actor ?? "Alguien"}</b> {enMinuscula(e.titulo)}
                    <small className="block text-xs text-slate-500">
                      {e.proveedorNombre ? `${e.proveedorNombre} · ` : ""}
                      {tiempoRelativo(e.creadoEn, ahora)}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        )}

        <Panel kicker="Distribución" titulo="Proveedores por tipo">
          <div className="flex flex-wrap items-center gap-6 px-5 pb-4">
            <div
              role="img"
              aria-label="Proveedores por tipo"
              className="grid h-32 w-32 shrink-0 place-items-center rounded-full"
              style={{ background: degradadoDeDona(trozos) }}
            >
              <div className="grid h-[88px] w-[88px] place-items-center rounded-full bg-white text-center leading-none">
                <span>
                  <b className="block text-2xl font-extrabold text-slate-900">
                    {num(cifras.total)}
                  </b>
                  <span className="text-[10px] text-slate-500">Total</span>
                </span>
              </div>
            </div>
            <div className="min-w-40 space-y-2 text-sm">
              {trozos.map((t) => (
                <div key={t.etiqueta} className="flex items-center gap-2">
                  <i
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ background: t.color }}
                    aria-hidden
                  />
                  <span className="text-slate-600">{t.etiqueta}</span>
                  <b className="ml-auto text-slate-900">{num(t.cantidad)}</b>
                </div>
              ))}
            </div>
          </div>
          <button
            onClick={() => onIr("directorio")}
            className="flex w-full items-center justify-center gap-2 border-t border-slate-100 py-3 text-sm font-semibold text-[#3f6212] hover:bg-slate-50"
          >
            Explorar directorio <ChevronRight size={15} />
          </button>
        </Panel>
      </div>

      {registrando && (
        <FormularioProveedor
          onGuardado={() => {
            setRegistrando(false);
            recargar();
          }}
          onCerrar={() => setRegistrando(false)}
        />
      )}
    </div>
  );
}
