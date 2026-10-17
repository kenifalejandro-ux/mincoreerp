// Precios de combustible y urea en una sola tabla (reemplaza las dos pestañas
// "Precios combustible" / "Precios urea"). Mismo estilo que Proveedores.
//
//   Combustible: un precio va a UN tanque (venta interna) o a UN proveedor de
//   ruta (compra), por tipo de combustible; el cambio puede aplicarse a varios
//   tanques o proveedores de una vez (POST /precios/masivo, todo o nada).
//   Urea: un precio por proveedor y presentación (POST /urea/precios).
//
// Los precios se apilan con su "vigente desde", nunca se editan; uno mal
// cargado se anula con motivo. Cada producto se ve y se escribe con su propio
// permiso (tanques:precios / urea:precios) y, además, solo admin y operador
// escriben: el servidor lo exige igual, acá solo se esconden los botones.
import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { IconoEstacion, IconoSurtidor } from "./IconosProveedor";
import {
  DIAS_PRECIO_VIEJO,
  ETIQUETA_COMBUSTIBLE,
  UMBRAL_CONFIRMACION_PCT,
  UNIDAD_PRECIO,
  anterior,
  claveCombustible,
  claveUrea,
  construirFilas,
  diasDesde,
  programado,
  textoRango,
  textoVariacion,
  ultimoCambio,
  variacionPct,
  vigente,
} from "./preciosUnificados";
import type {
  FilaPrecio,
  PresentacionPrecio,
  PrecioCombustibleApi,
  PrecioUreaApi,
  ProductoPrecio,
  ProveedorPrecio,
  ProveedorUreaPrecio,
  TanquePrecio,
  TipoCombustible,
  TipoPrecio,
} from "./preciosUnificados";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";

/** Con más destinos que esto, la lista del modal trae su buscador. */
const DESTINOS_PARA_BUSCADOR = 8;

const ETIQUETA_TIPO: Record<TipoPrecio, string> = {
  interna: "Venta interna",
  externa: "Compra a proveedor de ruta",
};

interface Datos {
  precios: PrecioCombustibleApi[];
  preciosUrea: PrecioUreaApi[];
  proveedoresUrea: ProveedorUreaPrecio[];
  presentaciones: PresentacionPrecio[];
}
const DATOS_VACIOS: Datos = {
  precios: [],
  preciosUrea: [],
  proveedoresUrea: [],
  presentaciones: [],
};

/** Pide una lista; si falla, la deja vacía y anota qué no se pudo cargar. */
async function pedirLista<T>(url: string, etiqueta: string, fallos: string[]): Promise<T[]> {
  try {
    const res = await apiFetch(url);
    if (!res.ok) {
      fallos.push(etiqueta);
      return [];
    }
    const body: unknown = await res.json().catch(() => null);
    if (Array.isArray(body)) return body as T[];
    fallos.push(etiqueta);
    return [];
  } catch {
    fallos.push(etiqueta);
    return [];
  }
}

function aInputLocal(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const fmtPrecio = (n: number) => `S/ ${n.toFixed(2)}`;
const fmtFecha = (iso: string, conHora = true) =>
  new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(conHora ? { hour: "2-digit", minute: "2-digit" } : {}),
  });

function Chip({
  activo,
  onClick,
  icono,
  texto,
  cuenta,
}: {
  activo: boolean;
  onClick: () => void;
  icono?: ReactNode;
  texto: string;
  cuenta: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={activo}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${
        activo
          ? "border-[#BADC1E] bg-[#BADC1E] text-[#0D1719]"
          : "border-[#2a2e37] bg-[#192526] text-[#94a3b8] hover:text-white"
      }`}
    >
      {icono}
      {texto}
      <span className="font-mono">{cuenta}</span>
    </button>
  );
}

function IconoDe({ producto, className }: { producto: ProductoPrecio; className: string }) {
  return producto === "combustible" ? (
    <IconoSurtidor className={className} />
  ) : (
    <IconoEstacion className={className} />
  );
}

/** Punto lleno = venta interna; aro = compra a proveedor. */
function PuntoTipo({ tipo }: { tipo: TipoPrecio }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        tipo === "interna" ? "bg-[#BADC1E]" : "border-2 border-[#94a3b8]"
      }`}
    />
  );
}

interface FormPrecio {
  producto: ProductoPrecio;
  tipo: TipoPrecio;
  comb: TipoCombustible;
  destinos: number[];
  grifoUrea: string;
  presentacion: string;
  marca: string;
  precio: string;
  desde: string;
  /** El precio (tal cual escrito) que la persona ya confirmó como correcto. */
  confirmadoPara: string;
  /** Texto del buscador de la lista de tanques o proveedores. */
  buscaDestino: string;
}

interface Props {
  tanques: TanquePrecio[];
  grifos: ProveedorPrecio[];
  onRecargarGrifos: () => Promise<void> | void;
  puedeCombustible: boolean;
  puedeUrea: boolean;
  /** Solo admin y operador escriben (el servidor lo exige igual). */
  puedeEscribir: boolean;
}

export default function PreciosPagina({
  tanques,
  grifos,
  onRecargarGrifos,
  puedeCombustible,
  puedeUrea,
  puedeEscribir,
}: Props) {
  const escribeComb = puedeCombustible && puedeEscribir;
  const escribeUrea = puedeUrea && puedeEscribir;

  const [datos, setDatos] = useState<Datos>(DATOS_VACIOS);
  const [cargado, setCargado] = useState(false);
  const [fallos, setFallos] = useState<string[]>([]);
  const [ahora, setAhora] = useState(0);
  // Una respuesta lenta de una carga vieja no debe pisar a la más nueva.
  const pedido = useRef(0);

  const cargar = useCallback(async () => {
    const mio = ++pedido.current;
    const lista: string[] = [];
    const [precios, preciosUrea, proveedoresUrea, presentaciones] = await Promise.all([
      puedeCombustible
        ? pedirLista<PrecioCombustibleApi>(
            "/api/erp/combustible/precios",
            "los precios de combustible",
            lista
          )
        : Promise.resolve<PrecioCombustibleApi[]>([]),
      puedeUrea
        ? pedirLista<PrecioUreaApi>(
            "/api/erp/combustible/urea/precios",
            "los precios de urea",
            lista
          )
        : Promise.resolve<PrecioUreaApi[]>([]),
      puedeUrea
        ? pedirLista<ProveedorUreaPrecio>(
            "/api/erp/combustible/urea/proveedores",
            "los proveedores de urea",
            lista
          )
        : Promise.resolve<ProveedorUreaPrecio[]>([]),
      puedeUrea
        ? pedirLista<PresentacionPrecio>(
            "/api/erp/combustible/urea/presentaciones",
            "las presentaciones de urea",
            lista
          )
        : Promise.resolve<PresentacionPrecio[]>([]),
    ]);
    if (mio !== pedido.current) return;
    setDatos({ precios, preciosUrea, proveedoresUrea, presentaciones });
    setFallos(lista);
    setAhora(Date.now());
    setCargado(true);
  }, [puedeCombustible, puedeUrea]);

  useEffect(() => {
    void cargar();
    if (puedeCombustible) void onRecargarGrifos();
  }, [cargar, onRecargarGrifos, puedeCombustible]);

  const filas = useMemo(
    () =>
      construirFilas(
        {
          precios: datos.precios,
          tanques,
          proveedores: grifos,
          preciosUrea: datos.preciosUrea,
          proveedoresUrea: datos.proveedoresUrea,
          presentaciones: datos.presentaciones,
        },
        { combustible: puedeCombustible, urea: puedeUrea }
      ),
    [datos, tanques, grifos, puedeCombustible, puedeUrea]
  );
  const porClave = useMemo(() => new Map(filas.map((f) => [f.clave, f])), [filas]);

  const [producto, setProducto] = useState<"todos" | ProductoPrecio>("todos");
  const [tipo, setTipo] = useState<"todos" | TipoPrecio>("todos");
  const [busca, setBusca] = useState("");
  const [soloSin, setSoloSin] = useState(false);
  const [abiertas, setAbiertas] = useState<Record<string, boolean>>({});
  const [aviso, setAviso] = useState<string | null>(null);

  const sinPrecio = filas.filter((f) => !vigente(f, ahora));
  const q = busca.trim().toLowerCase();
  const coincide = (f: FilaPrecio, p: typeof producto, t: typeof tipo) =>
    (p === "todos" || f.producto === p) && (t === "todos" || f.tipo === t);
  const visibles = filas.filter(
    (f) =>
      coincide(f, producto, tipo) &&
      (!q || `${f.destino} ${f.detalle}`.toLowerCase().includes(q)) &&
      (!soloSin || !vigente(f, ahora))
  );

  // ── Tarjetas de resumen ──────────────────────────────────────────────────
  const tiposCombustible = [
    ...new Set(filas.filter((f) => f.producto === "combustible").map((f) => f.subtipo)),
  ] as TipoCombustible[];
  const filasUrea = filas.filter((f) => f.producto === "urea");
  const presentacionesUrea = [...new Set(filasUrea.map((f) => f.subtipo))].map((codigo) => ({
    codigo,
    nombre: filasUrea.find((f) => f.subtipo === codigo)?.detalle ?? codigo,
  }));
  const valoresVigentes = (fs: FilaPrecio[]) =>
    fs.flatMap((f) => {
      const v = vigente(f, ahora);
      return v ? [v.precio] : [];
    });
  const textoUltimo = (fs: FilaPrecio[]) => {
    const u = ultimoCambio(fs, ahora);
    return u ? `último cambio ${fmtFecha(u, false)}` : "sin cambios";
  };

  // ── Modal de precio ──────────────────────────────────────────────────────
  const [form, setForm] = useState<FormPrecio | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);

  const destinosDe = useCallback(
    (f: Pick<FormPrecio, "tipo" | "comb">) =>
      f.tipo === "interna"
        ? tanques
            .filter((t) => t.activo && t.tipo_combustible === f.comb)
            .map((t) => ({ id: t.id, nombre: t.tanque_nombre }))
        : grifos
            .filter((g) => g.activo && g.abastece_ruta)
            .map((g) => ({ id: g.id, nombre: g.nombre })),
    [tanques, grifos]
  );

  const abrirModal = (fila: FilaPrecio | null) => {
    const primero: ProductoPrecio = escribeComb ? "combustible" : "urea";
    const prod = fila ? fila.producto : primero;
    const comb: TipoCombustible =
      fila?.producto === "combustible"
        ? (fila.subtipo as TipoCombustible)
        : (tiposCombustible[0] ?? "diesel_b5");
    const tipoNuevo: TipoPrecio = fila?.producto === "combustible" ? fila.tipo : "interna";
    const base = { tipo: tipoNuevo, comb };
    const activas = datos.presentaciones.filter((p) => p.activa);
    setErrorForm(null);
    setForm({
      producto: prod,
      ...base,
      // "Nuevo precio" empieza con todos marcados (el caso del alza general);
      // "Cambiar precio" desde una fila, solo con esa.
      destinos:
        fila?.producto === "combustible" ? [fila.destinoId] : destinosDe(base).map((d) => d.id),
      grifoUrea:
        fila?.producto === "urea"
          ? String(fila.destinoId)
          : String(datos.proveedoresUrea[0]?.id ?? ""),
      presentacion: fila?.producto === "urea" ? fila.subtipo : (activas[0]?.codigo ?? ""),
      marca: "",
      precio: "",
      desde: aInputLocal(new Date()),
      confirmadoPara: "",
      buscaDestino: "",
    });
  };

  const cambiarForm = (cambio: Partial<FormPrecio>) => {
    setForm((actual) => {
      if (!actual) return actual;
      const nuevo = { ...actual, ...cambio };
      // Al cambiar el tipo o el combustible, la lista de destinos es otra:
      // se vuelve a marcar entera.
      if (
        (cambio.tipo !== undefined && cambio.tipo !== actual.tipo) ||
        (cambio.comb !== undefined && cambio.comb !== actual.comb)
      ) {
        nuevo.destinos = destinosDe(nuevo).map((d) => d.id);
        nuevo.buscaDestino = "";
      }
      return nuevo;
    });
  };

  /** Las filas a las que el formulario le va a cargar precio. */
  const objetivos: (FilaPrecio | undefined)[] = !form
    ? []
    : form.producto === "urea"
      ? form.grifoUrea && form.presentacion
        ? [porClave.get(claveUrea(Number(form.grifoUrea), form.presentacion))]
        : []
      : form.destinos.map((id) => porClave.get(claveCombustible(form.tipo, id, form.comb)));

  const nuevoPrecio = form ? parseFloat(form.precio) : NaN;
  const vigentesObjetivo = objetivos.flatMap((f) => {
    const v = f ? vigente(f, ahora) : null;
    return v ? [v.precio] : [];
  });
  const variaciones =
    nuevoPrecio > 0 ? vigentesObjetivo.map((base) => variacionPct(nuevoPrecio, base)) : [];
  const salto = variaciones.length ? Math.max(...variaciones.map(Math.abs)) : 0;
  const pideConfirmar = salto > UMBRAL_CONFIRMACION_PCT;
  const confirmado = !!form && form.confirmadoPara === form.precio;
  const sinDestino = objetivos.length === 0;
  const programadoFuturo = !!form?.desde && new Date(form.desde).getTime() > ahora;
  const botonBloqueado =
    guardando || sinDestino || !(nuevoPrecio > 0) || (pideConfirmar && !confirmado);

  const mostrarAviso = (texto: string) => {
    setAviso(texto);
    setTimeout(() => setAviso(null), 3500);
  };

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (!form || botonBloqueado) return;
    const desde = new Date(form.desde);
    if (Number.isNaN(desde.getTime())) {
      setErrorForm("Elige una fecha válida.");
      return;
    }
    setGuardando(true);
    setErrorForm(null);
    try {
      const esUrea = form.producto === "urea";
      const res = await apiFetch(
        esUrea ? "/api/erp/combustible/urea/precios" : "/api/erp/combustible/precios/masivo",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            esUrea
              ? {
                  grifo_id: Number(form.grifoUrea),
                  presentacion: form.presentacion,
                  marca: form.marca.trim() || undefined,
                  precio_por_bulto: nuevoPrecio,
                  vigente_desde: desde.toISOString(),
                }
              : {
                  tipo_combustible: form.comb,
                  ...(form.tipo === "interna"
                    ? { combustible_ids: form.destinos }
                    : { grifo_ids: form.destinos }),
                  precio_unitario: nuevoPrecio,
                  vigente_desde: desde.toISOString(),
                }
          ),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setErrorForm(mensajeDeError(body, "No se pudo cargar el precio."));
        return;
      }
      const cuantos = esUrea ? 1 : form.destinos.length;
      setForm(null);
      await cargar();
      mostrarAviso(cuantos > 1 ? `Precio cargado en ${cuantos} destinos` : "Precio cargado");
    } finally {
      setGuardando(false);
    }
  };

  // ── Anulación ────────────────────────────────────────────────────────────
  const [porAnular, setPorAnular] = useState<{
    fila: FilaPrecio;
    id: number;
    precio: number;
    desde: string;
  } | null>(null);
  const [motivo, setMotivo] = useState("");
  const [anulando, setAnulando] = useState(false);
  const [errorAnular, setErrorAnular] = useState<string | null>(null);

  const anular = async (e: FormEvent) => {
    e.preventDefault();
    if (!porAnular || anulando || !motivo.trim()) return;
    setAnulando(true);
    setErrorAnular(null);
    try {
      const base =
        porAnular.fila.producto === "urea"
          ? "/api/erp/combustible/urea/precios"
          : "/api/erp/combustible/precios";
      const res = await apiFetch(`${base}/${porAnular.id}/anular`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivo.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setErrorAnular(mensajeDeError(body, "No se pudo anular el precio."));
        return;
      }
      setPorAnular(null);
      setMotivo("");
      await cargar();
      mostrarAviso("Precio anulado");
    } finally {
      setAnulando(false);
    }
  };

  const escribeFila = (f: FilaPrecio) => (f.producto === "combustible" ? escribeComb : escribeUrea);
  const hayEscritura = escribeComb || escribeUrea;
  const claseInput =
    "w-full rounded-lg border border-[#2a2e37] bg-[#0D1719] p-3 text-sm text-white outline-none focus:border-[#BADC1E]";
  const claseEtiqueta =
    "mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-[#94a3b8]";

  if (!cargado) {
    return <div className="p-6 text-sm text-[#94a3b8]">Cargando precios...</div>;
  }

  const destinosForm = form && form.producto === "combustible" ? destinosDe(form) : [];
  const activasUrea = datos.presentaciones.filter((p) => p.activa);
  const conBuscador = destinosForm.length > DESTINOS_PARA_BUSCADOR;
  const buscando = conBuscador && !!form && form.buscaDestino.trim() !== "";
  const destinosVisibles = buscando
    ? destinosForm.filter((d) =>
        d.nombre.toLowerCase().includes(form!.buscaDestino.trim().toLowerCase())
      )
    : destinosForm;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Precios</h2>
          <p className="text-sm text-[#94a3b8]">
            <strong className="text-white">Venta interna:</strong> precio al que se despacha desde
            cada tanque hacia las flotas.
            <br />
            <strong className="text-white">Compra a un proveedor de ruta:</strong> precio pactado
            con cada proveedor para las compras en ruta; el conductor puede corregirlo según su
            boleta.
            <br />
            <strong className="text-white">Urea:</strong> precio por envase de cada proveedor, para
            la entrada al almacén y la compra en ruta.
          </p>
        </div>
        {hayEscritura && (
          <button
            type="button"
            onClick={() => abrirModal(null)}
            className="flex items-center gap-2 rounded-lg bg-[#BADC1E] px-4 py-2 font-bold text-[#0D1719] hover:brightness-110"
          >
            <Plus className="h-4 w-4" /> Nuevo precio
          </button>
        )}
      </div>

      {fallos.length > 0 && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        >
          <span>No se pudo cargar {fallos.join(", ")}.</span>
          <button
            type="button"
            onClick={() => void cargar()}
            className="rounded-lg border border-red-400/50 px-3 py-1 text-xs font-bold hover:text-white"
          >
            Reintentar
          </button>
        </div>
      )}
      {aviso && (
        <div
          role="status"
          className="rounded-lg bg-[#BADC1E] px-4 py-2 text-sm font-bold text-[#0D1719]"
        >
          {aviso}
        </div>
      )}

      {(tiposCombustible.length > 0 || presentacionesUrea.length > 0) && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {tiposCombustible.map((tc) => {
            const fs = filas.filter((f) => f.producto === "combustible" && f.subtipo === tc);
            return (
              <div key={tc} className="rounded-lg border border-[#2a2e37] bg-[#192526] px-4 py-3">
                <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[#BADC1E]">
                  <IconoSurtidor className="h-4 w-4" /> {ETIQUETA_COMBUSTIBLE[tc]}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-4">
                  {(["interna", "externa"] as const).map((t) => (
                    <div key={t}>
                      <p className="text-xs text-[#94a3b8]">{ETIQUETA_TIPO[t]}</p>
                      <p className="font-mono text-xl font-bold text-white">
                        {textoRango(valoresVigentes(fs.filter((f) => f.tipo === t)))}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-[#64748b]">{textoUltimo(fs)}</p>
              </div>
            );
          })}
          {presentacionesUrea.length > 0 && (
            <div className="rounded-lg border border-[#2a2e37] bg-[#192526] px-4 py-3">
              <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[#BADC1E]">
                <IconoEstacion className="h-4 w-4" /> Urea
              </p>
              <div className="mt-2 grid grid-cols-2 gap-4">
                {presentacionesUrea.map((p) => (
                  <div key={p.codigo}>
                    <p className="text-xs text-[#94a3b8]">{p.nombre}</p>
                    <p className="font-mono text-xl font-bold text-white">
                      {textoRango(valoresVigentes(filasUrea.filter((f) => f.subtipo === p.codigo)))}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-[#64748b]">{textoUltimo(filasUrea)}</p>
            </div>
          )}
        </div>
      )}

      {sinPrecio.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-300">
          <span>
            <strong>{sinPrecio.length} sin precio.</strong> En compras en ruta el conductor tendrá
            que tipear el costo sin referencia y no habrá con qué compararlo.
          </span>
          <button
            type="button"
            onClick={() => setSoloSin((v) => !v)}
            className="rounded-lg border border-amber-400/50 px-3 py-1 text-xs font-bold hover:text-white"
          >
            {soloSin ? "Ver todos" : "Ver solo esos"}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-[#64748b]">
            Producto
          </span>
          <Chip
            activo={producto === "todos"}
            onClick={() => setProducto("todos")}
            texto="Todos"
            cuenta={filas.filter((f) => coincide(f, "todos", tipo)).length}
          />
          {puedeCombustible && (
            <Chip
              activo={producto === "combustible"}
              onClick={() => setProducto("combustible")}
              icono={<IconoSurtidor className="h-3.5 w-auto" />}
              texto="Combustible"
              cuenta={filas.filter((f) => coincide(f, "combustible", tipo)).length}
            />
          )}
          {puedeUrea && (
            <Chip
              activo={producto === "urea"}
              onClick={() => setProducto("urea")}
              icono={<IconoEstacion className="h-3.5 w-auto" />}
              texto="Urea"
              cuenta={filas.filter((f) => coincide(f, "urea", tipo)).length}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-[#64748b]">
            Tipo
          </span>
          <Chip
            activo={tipo === "todos"}
            onClick={() => setTipo("todos")}
            texto="Todos"
            cuenta={filas.filter((f) => coincide(f, producto, "todos")).length}
          />
          <Chip
            activo={tipo === "interna"}
            onClick={() => setTipo("interna")}
            texto={ETIQUETA_TIPO.interna}
            cuenta={filas.filter((f) => coincide(f, producto, "interna")).length}
          />
          <Chip
            activo={tipo === "externa"}
            onClick={() => setTipo("externa")}
            texto={ETIQUETA_TIPO.externa}
            cuenta={filas.filter((f) => coincide(f, producto, "externa")).length}
          />
        </div>
        <input
          type="text"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar tanque, proveedor o envase"
          aria-label="Buscar precio"
          className="min-w-[200px] max-w-xs flex-1 rounded-lg border border-[#2a2e37] bg-[#192526] px-3 py-2 text-sm text-white outline-none focus:border-[#BADC1E]"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-[#2a2e37] bg-[#192526]">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="bg-[#1d2d30] text-[11px] uppercase tracking-widest text-[#94a3b8]">
              <th className="px-4 py-3 text-left">Producto</th>
              <th className="px-4 py-3 text-left">Tipo</th>
              <th className="px-4 py-3 text-left">Precio</th>
              <th className="px-4 py-3 text-left">Vigente</th>
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center font-mono text-xs text-[#64748b]">
                  {filas.length === 0
                    ? "TODAVÍA NO HAY TANQUES NI PROVEEDORES PARA PONERLES PRECIO"
                    : "SIN PRECIOS CON ESE FILTRO"}
                </td>
              </tr>
            )}
            {visibles.map((f) => {
              const v = vigente(f, ahora);
              const prog = programado(f, ahora);
              const previo = v ? anterior(f, v) : null;
              const delta = v && previo ? variacionPct(v.precio, previo.precio) : null;
              const dias = v ? diasDesde(v.desde, ahora) : 0;
              const abierta = !!abiertas[f.clave];
              const puedeFila = escribeFila(f);
              return (
                <FilaTabla key={f.clave}>
                  <tr className="border-t border-[#2a2e37] align-top hover:bg-[#BADC1E]/5">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-semibold text-white">
                        <span className="text-[#BADC1E]">
                          <IconoDe producto={f.producto} className="h-4 w-4" />
                        </span>
                        {f.producto === "combustible" ? "Combustible" : "Urea"}
                      </span>
                      <span className="block text-xs text-[#94a3b8]">{f.destino}</span>
                      <span className="block text-xs text-[#64748b]">
                        {f.detalle}
                        {v?.marca ? ` · ${v.marca}` : ""}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-semibold text-white">
                        <PuntoTipo tipo={f.tipo} />
                        {f.producto === "urea" ? "Compra a proveedor" : ETIQUETA_TIPO[f.tipo]}
                      </span>
                      {f.producto === "urea" && (
                        <span className="block text-xs text-[#64748b]">
                          Entrada al almacén y ruta
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {v ? (
                        <>
                          <span className="font-mono text-lg font-bold text-white">
                            {fmtPrecio(v.precio)}
                          </span>
                          <span className="ml-1 text-xs text-[#94a3b8]">
                            / {UNIDAD_PRECIO[f.producto]}
                          </span>
                          {delta !== null && (
                            <span
                              className={`block font-mono text-xs ${delta >= 0 ? "text-amber-400" : "text-emerald-400"}`}
                            >
                              {delta >= 0 ? "▲" : "▼"} {textoVariacion(delta)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-sm font-semibold text-amber-400">Sin precio</span>
                      )}
                      {prog && (
                        <span className="mt-1 block text-xs text-sky-400">
                          Programado: {fmtPrecio(prog.precio)} desde {fmtFecha(prog.desde, false)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {v ? (
                        <>
                          <span className="font-mono text-xs text-white">{fmtFecha(v.desde)}</span>
                          <span className="block text-xs text-[#94a3b8]">
                            {v.por ?? "—"} ·{" "}
                            <span
                              className={
                                dias > DIAS_PRECIO_VIEJO ? "font-semibold text-amber-400" : ""
                              }
                            >
                              hace {dias} {dias === 1 ? "día" : "días"}
                            </span>
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-[#64748b]">Todavía no cargado</span>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {f.entradas.length > 0 && (
                          <button
                            type="button"
                            aria-expanded={abierta}
                            onClick={() => setAbiertas((a) => ({ ...a, [f.clave]: !a[f.clave] }))}
                            className="rounded-lg border border-[#334155] px-3 py-1 text-xs font-bold text-[#94a3b8] hover:text-white"
                          >
                            {abierta ? "Ocultar historial" : "Historial"}
                          </button>
                        )}
                        {puedeFila && (
                          <button
                            type="button"
                            onClick={() => abrirModal(f)}
                            className="rounded-lg border border-[#334155] px-3 py-1 text-xs font-bold text-[#94a3b8] hover:text-white"
                          >
                            {v ? "Cambiar precio" : "Cargar precio"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {abierta && (
                    <tr className="bg-[#1d2d30]">
                      <td colSpan={4} className="px-4 py-3">
                        <div className="grid grid-cols-[150px_1fr_1fr_1fr_1.4fr] gap-x-4 gap-y-1 text-xs">
                          {["Desde", "Precio", "Variación", "Cargado por", ""].map((t) => (
                            <span
                              key={t || "acciones"}
                              className="text-[10px] font-bold uppercase tracking-widest text-[#64748b]"
                            >
                              {t}
                            </span>
                          ))}
                          {f.entradas.map((e) => {
                            const prev = e.anulado ? null : anterior(f, e);
                            const d = prev ? variacionPct(e.precio, prev.precio) : null;
                            const esVigente = v?.id === e.id;
                            const futuro = new Date(e.desde).getTime() > ahora;
                            return (
                              <div key={e.id} className="contents">
                                <span className="font-mono text-white">
                                  {fmtFecha(e.desde)}
                                  {e.anulado ? (
                                    <b className="ml-1 text-[10px] uppercase text-red-400">
                                      anulado
                                    </b>
                                  ) : esVigente ? (
                                    <b className="ml-1 text-[10px] uppercase text-emerald-400">
                                      vigente
                                    </b>
                                  ) : futuro ? (
                                    <b className="ml-1 text-[10px] uppercase text-sky-400">
                                      programado
                                    </b>
                                  ) : null}
                                </span>
                                <span
                                  className={`font-mono ${e.anulado ? "text-[#64748b] line-through" : "text-white"}`}
                                >
                                  {fmtPrecio(e.precio)}
                                </span>
                                <span className="font-mono text-[#94a3b8]">
                                  {e.anulado
                                    ? "—"
                                    : d === null
                                      ? "primer precio"
                                      : textoVariacion(d)}
                                </span>
                                <span className="text-[#94a3b8]">{e.por ?? "—"}</span>
                                <span className="text-[#94a3b8]">
                                  {e.anulado ? (
                                    `Motivo: ${e.anuladaMotivo ?? "—"}`
                                  ) : puedeFila ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setMotivo("");
                                        setErrorAnular(null);
                                        setPorAnular({
                                          fila: f,
                                          id: e.id,
                                          precio: e.precio,
                                          desde: e.desde,
                                        });
                                      }}
                                      className="underline hover:text-red-400"
                                    >
                                      Anular
                                    </button>
                                  ) : null}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </FilaTabla>
              );
            })}
          </tbody>
        </table>
      </div>

      {form && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Precio"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !guardando) setForm(null);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D1719]/90 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={guardar}
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-[#2a2e37] bg-[#192526] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#2a2e37] bg-[#1d2d30] px-5 py-4">
              <h3 className="text-lg font-bold text-white">Precio</h3>
              <button
                type="button"
                onClick={() => setForm(null)}
                aria-label="Cerrar"
                className="text-[#94a3b8] hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className={escribeComb && escribeUrea ? "" : "hidden"}>
                <label htmlFor="precio-producto" className={claseEtiqueta}>
                  Producto
                </label>
                <select
                  id="precio-producto"
                  value={form.producto}
                  onChange={(e) => cambiarForm({ producto: e.target.value as ProductoPrecio })}
                  className={claseInput}
                >
                  <option value="combustible">Combustible</option>
                  <option value="urea">Urea</option>
                </select>
              </div>

              {form.producto === "combustible" ? (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="precio-tipo" className={claseEtiqueta}>
                        Tipo de precio
                      </label>
                      <select
                        id="precio-tipo"
                        value={form.tipo}
                        onChange={(e) => cambiarForm({ tipo: e.target.value as TipoPrecio })}
                        className={claseInput}
                      >
                        <option value="interna">Venta interna (tanque → flotas)</option>
                        <option value="externa">Compra a un proveedor de ruta</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="precio-combustible" className={claseEtiqueta}>
                        Combustible
                      </label>
                      <select
                        id="precio-combustible"
                        value={form.comb}
                        onChange={(e) => cambiarForm({ comb: e.target.value as TipoCombustible })}
                        className={claseInput}
                      >
                        {(Object.keys(ETIQUETA_COMBUSTIBLE) as TipoCombustible[]).map((c) => (
                          <option key={c} value={c}>
                            {ETIQUETA_COMBUSTIBLE[c]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <fieldset>
                    <legend className={claseEtiqueta}>
                      {form.tipo === "interna"
                        ? "Aplicar a estos tanques"
                        : "Aplicar a estos proveedores"}
                    </legend>
                    {conBuscador && (
                      <input
                        type="text"
                        value={form.buscaDestino}
                        onChange={(e) => cambiarForm({ buscaDestino: e.target.value })}
                        placeholder={form.tipo === "interna" ? "Buscar tanque" : "Buscar proveedor"}
                        aria-label="Buscar en la lista"
                        className="mb-2 w-full rounded-lg border border-[#2a2e37] bg-[#0D1719] px-3 py-2 text-sm text-white outline-none focus:border-[#BADC1E]"
                      />
                    )}
                    <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-[#2a2e37] bg-[#0D1719] p-2 text-sm text-white">
                      {destinosForm.length === 0 ? (
                        <p className="p-2 text-xs text-[#94a3b8]">
                          {form.tipo === "interna"
                            ? `No hay tanques activos de ${ETIQUETA_COMBUSTIBLE[form.comb]}.`
                            : "No hay proveedores de ruta activos."}
                        </p>
                      ) : destinosVisibles.length === 0 ? (
                        <p className="p-2 text-xs text-[#94a3b8]">
                          Ninguno coincide con la búsqueda.
                        </p>
                      ) : (
                        <>
                          <label className="flex cursor-pointer items-center gap-2 border-b border-[#2a2e37] p-1.5 font-semibold text-[#BADC1E]">
                            <input
                              type="checkbox"
                              checked={destinosVisibles.every((d) => form.destinos.includes(d.id))}
                              onChange={(e) => {
                                const ids = destinosVisibles.map((d) => d.id);
                                cambiarForm({
                                  destinos: e.target.checked
                                    ? [...new Set([...form.destinos, ...ids])]
                                    : form.destinos.filter((x) => !ids.includes(x)),
                                });
                              }}
                              className="h-4 w-4 accent-[#BADC1E]"
                            />
                            {buscando
                              ? `Marcar los ${destinosVisibles.length} que se ven`
                              : "Todos"}
                          </label>
                          {destinosVisibles.map((d) => (
                            <label
                              key={d.id}
                              className="flex cursor-pointer items-center gap-2 p-1.5"
                            >
                              <input
                                type="checkbox"
                                checked={form.destinos.includes(d.id)}
                                onChange={(e) =>
                                  cambiarForm({
                                    destinos: e.target.checked
                                      ? [...form.destinos, d.id]
                                      : form.destinos.filter((x) => x !== d.id),
                                  })
                                }
                                className="h-4 w-4 accent-[#BADC1E]"
                              />
                              {d.nombre}
                            </label>
                          ))}
                        </>
                      )}
                    </div>
                    {conBuscador && (
                      <p className="mt-1 text-xs text-[#64748b]">
                        {form.destinos.length} de {destinosForm.length} marcados
                      </p>
                    )}
                  </fieldset>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="precio-prov-urea" className={claseEtiqueta}>
                        Proveedor
                      </label>
                      <select
                        id="precio-prov-urea"
                        value={form.grifoUrea}
                        onChange={(e) => cambiarForm({ grifoUrea: e.target.value })}
                        className={claseInput}
                      >
                        {datos.proveedoresUrea.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.nombre}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="precio-presentacion" className={claseEtiqueta}>
                        Presentación
                      </label>
                      <select
                        id="precio-presentacion"
                        value={form.presentacion}
                        onChange={(e) => cambiarForm({ presentacion: e.target.value })}
                        className={claseInput}
                      >
                        {activasUrea.map((p) => (
                          <option key={p.codigo} value={p.codigo}>
                            {p.litros ? `${p.nombre} (${Number(p.litros)} L)` : p.nombre}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="precio-marca" className={claseEtiqueta}>
                      Marca (opcional)
                    </label>
                    <input
                      id="precio-marca"
                      type="text"
                      maxLength={80}
                      placeholder="Green 32"
                      value={form.marca}
                      onChange={(e) => cambiarForm({ marca: e.target.value })}
                      className={claseInput}
                    />
                  </div>
                </>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="precio-valor" className={claseEtiqueta}>
                    Precio por {UNIDAD_PRECIO[form.producto]} (S/)
                  </label>
                  <input
                    id="precio-valor"
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    autoFocus
                    required
                    value={form.precio}
                    onChange={(e) => cambiarForm({ precio: e.target.value })}
                    className={claseInput}
                  />
                </div>
                <div>
                  <label htmlFor="precio-desde" className={claseEtiqueta}>
                    Vigente desde
                  </label>
                  <input
                    id="precio-desde"
                    type="datetime-local"
                    required
                    value={form.desde}
                    onChange={(e) => cambiarForm({ desde: e.target.value })}
                    className={claseInput}
                  />
                </div>
              </div>

              <div
                aria-live="polite"
                className={`rounded-lg px-3 py-2.5 text-sm ${
                  pideConfirmar
                    ? "border border-amber-500/40 bg-amber-500/10 text-amber-300"
                    : "bg-[#1d2d30] text-[#94a3b8]"
                }`}
              >
                {sinDestino ? (
                  <p>
                    Elige al menos un {form.producto === "urea" ? "proveedor" : "destino"} para
                    cargar el precio.
                  </p>
                ) : (
                  <p>
                    {vigentesObjetivo.length > 0 ? (
                      <>
                        Vigente hoy:{" "}
                        <b className="font-mono text-white">{textoRango(vigentesObjetivo)}</b> en{" "}
                        {vigentesObjetivo.length} de {objetivos.length}.
                      </>
                    ) : (
                      "Todavía no tiene precio cargado."
                    )}
                    {variaciones.length > 0 && (
                      <>
                        {" "}
                        Con el precio nuevo:{" "}
                        <b className="font-mono text-white">
                          {Math.min(...variaciones) === Math.max(...variaciones)
                            ? textoVariacion(variaciones[0])
                            : `${textoVariacion(Math.min(...variaciones))} a ${textoVariacion(Math.max(...variaciones))}`}
                        </b>
                        .
                      </>
                    )}
                    {programadoFuturo && (
                      <>
                        {" "}
                        Quedará como <b>programado</b> hasta esa fecha.
                      </>
                    )}
                  </p>
                )}
                {pideConfirmar && (
                  <label className="mt-2 flex cursor-pointer items-center gap-2 font-semibold">
                    <input
                      type="checkbox"
                      checked={confirmado}
                      onChange={(e) =>
                        cambiarForm({ confirmadoPara: e.target.checked ? form.precio : "" })
                      }
                      className="h-4 w-4 accent-[#BADC1E]"
                    />
                    Confirmo que el precio nuevo es correcto
                  </label>
                )}
              </div>
              {errorForm && <p className="text-sm text-red-400">{errorForm}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-[#2a2e37] px-5 py-4">
              <button
                type="button"
                onClick={() => setForm(null)}
                disabled={guardando}
                className="rounded-lg border border-[#334155] px-4 py-2 text-sm font-medium text-[#94a3b8] hover:text-white disabled:opacity-40"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={botonBloqueado}
                className="rounded-lg bg-[#BADC1E] px-4 py-2 text-sm font-bold text-[#0D1719] hover:brightness-110 disabled:opacity-40"
              >
                {guardando ? "Guardando..." : "Cargar precio"}
              </button>
            </div>
          </form>
        </div>
      )}

      {porAnular && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Anular precio"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !anulando) setPorAnular(null);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D1719]/90 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={anular}
            className="w-full max-w-sm rounded-xl border border-[#2a2e37] bg-[#192526] shadow-2xl"
          >
            <div className="space-y-3 p-5">
              <h3 className="text-lg font-bold text-white">Anular precio</h3>
              <p className="text-sm text-[#94a3b8]">
                {porAnular.fila.destino} · {porAnular.fila.detalle}:{" "}
                <b className="font-mono text-white">{fmtPrecio(porAnular.precio)}</b> desde{" "}
                {fmtFecha(porAnular.desde)}
              </p>
              <div>
                <label htmlFor="precio-motivo" className={claseEtiqueta}>
                  Motivo (obligatorio)
                </label>
                <input
                  id="precio-motivo"
                  type="text"
                  autoFocus
                  required
                  maxLength={500}
                  placeholder="Ej.: se digitó mal la coma"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  className={claseInput}
                />
              </div>
              <p className="text-xs text-[#64748b]">
                El precio no se borra: queda en el historial como anulado y vuelve a regir el
                anterior.
              </p>
              {errorAnular && <p className="text-sm text-red-400">{errorAnular}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-[#2a2e37] px-5 py-4">
              <button
                type="button"
                onClick={() => setPorAnular(null)}
                disabled={anulando}
                className="rounded-lg border border-[#334155] px-4 py-2 text-sm font-medium text-[#94a3b8] hover:text-white disabled:opacity-40"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={anulando || !motivo.trim()}
                className="rounded-lg bg-[#BADC1E] px-4 py-2 text-sm font-bold text-[#0D1719] hover:brightness-110 disabled:opacity-40"
              >
                {anulando ? "Anulando..." : "Anular precio"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/** Agrupa la fila de la tabla con su historial desplegado sin un <div> de por
 *  medio (dentro de <tbody> solo caben filas). */
function FilaTabla({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
