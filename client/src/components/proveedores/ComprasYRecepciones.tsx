// client/src/components/proveedores/ComprasYRecepciones.tsx
//
// Compras y recepciones (PR5, solo lectura): las compras de cisterna con su estado y, si ya se
// descargaron, lo recibido contra el documento. Son las de Combustible → Cisternas: acá se consultan;
// registrar, habilitar o anular una compra se sigue haciendo allá.
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";

import AnularCompra from "./AnularCompra";
import { ETIQUETA_ESTADO, totalesCompras } from "./comprasProveedores";
import FormularioCompra from "./FormularioCompra";
import {
  datosFormularioCompra,
  habilitarCompra,
  type CompraDeCisterna,
  type DatosFormularioCompra,
  type EstadoCompra,
} from "./proveedoresApi";
import TablaDeCompras from "./TablaDeCompras";
import { useCompras } from "./useCompras";
import { useAuth } from "../../context/AuthContext";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";

type FiltroEstado = "todos" | EstadoCompra;

function Total({ etiqueta, valor, detalle }: { etiqueta: string; valor: number; detalle: string }) {
  return (
    <article className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
      <p className="text-xs font-semibold text-slate-500">{etiqueta}</p>
      <p className="text-2xl font-semibold text-slate-900 tabular-nums">{valor}</p>
      <p className="text-xs text-slate-500">{detalle}</p>
    </article>
  );
}

export default function ComprasYRecepciones({
  onAbrirProveedor,
}: {
  onAbrirProveedor: (proveedorId: number) => void;
}) {
  const { datos, error, recargar } = useCompras();
  const { usuario } = useAuth();
  const puedeEscribir = usePuedeEscribir("proveedores");
  const conCombustible = !!usuario?.modulosPermitidos.includes("combustible");
  // Registrar, habilitar y anular: solo quien gestiona compras (el servidor lo exige igual).
  const puedeGestionar = puedeEscribir && !!datos?.gestiona;
  const [formulario, setFormulario] = useState<DatosFormularioCompra | null>(null);
  const [anulando, setAnulando] = useState<CompraDeCisterna | null>(null);
  const [ocupada, setOcupada] = useState<number | null>(null);
  const [abriendo, setAbriendo] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [estado, setEstado] = useState<FiltroEstado>("todos");

  const compras = useMemo(() => datos?.compras ?? [], [datos]);
  const resumen = useMemo(() => totalesCompras(compras), [compras]);
  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return compras.filter((c) => {
      if (
        q &&
        !`${c.numeroDocumento} ${c.proveedorNombre} ${c.proveedorCodigo}`.toLowerCase().includes(q)
      )
        return false;
      return estado === "todos" || c.estado === estado;
    });
  }, [compras, busqueda, estado]);

  const abrirFormulario = async () => {
    if (abriendo) return;
    setAbriendo(true);
    setFallo(null);
    try {
      setFormulario(await datosFormularioCompra());
    } catch (e) {
      setFallo(e instanceof Error ? e.message : "No se pudo abrir el formulario.");
    } finally {
      setAbriendo(false);
    }
  };
  const habilitar = async (c: CompraDeCisterna) => {
    if (ocupada !== null) return;
    setOcupada(c.id);
    setFallo(null);
    try {
      await habilitarCompra(c.id);
      setAviso(`La compra ${c.numeroDocumento} quedó por llegar: ya la ve la cancha.`);
      recargar();
    } catch (e) {
      setFallo(e instanceof Error ? e.message : "No se pudo habilitar la compra.");
    } finally {
      setOcupada(null);
    }
  };

  const control =
    "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#84cc16]";
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            Abastecimiento / Compras y recepciones
          </p>
          <h1 className="text-3xl font-semibold text-slate-900 mt-1">Compras y recepciones</h1>
          <p className="text-sm text-slate-500 mt-1">
            Lo que se compra a cada proveedor y cómo llegó a la cancha.
          </p>
        </div>
        {puedeGestionar && (
          <button
            onClick={abrirFormulario}
            disabled={abriendo}
            className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95 disabled:opacity-60"
          >
            <Plus size={16} /> Registrar compra
          </button>
        )}
      </header>

      {aviso && (
        <p
          role="status"
          className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3"
        >
          {aviso}
        </p>
      )}
      {fallo && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {fallo}
        </p>
      )}

      <section aria-label="Resumen" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Total etiqueta="Por llegar" valor={resumen.porLlegar} detalle="Esperan la descarga" />
        <Total etiqueta="Recibidas" valor={resumen.recibidas} detalle="Ya descargadas" />
        <Total
          etiqueta="Con diferencia"
          valor={resumen.conDiferencia}
          detalle={datos ? `Fuera de ${datos.tolerancia} gal de tolerancia` : "Fuera de tolerancia"}
        />
        <Total etiqueta="Anuladas" valor={resumen.anuladas} detalle="Sin efecto" />
      </section>

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-slate-200">
          <label className="relative flex-1 min-w-56 max-w-md">
            <span className="sr-only">Buscar</span>
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por documento o proveedor"
              className={`${control} w-full pl-9`}
            />
          </label>
          <select
            aria-label="Estado de la compra"
            className={control}
            value={estado}
            onChange={(e) => setEstado(e.target.value as FiltroEstado)}
          >
            <option value="todos">Todos los estados</option>
            {(Object.keys(ETIQUETA_ESTADO) as EstadoCompra[]).map((e) => (
              <option key={e} value={e}>
                {ETIQUETA_ESTADO[e]}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p
            role="alert"
            className="m-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
          >
            {error}
          </p>
        )}
        {datos === null && !error && (
          <p className="px-4 py-8 text-center text-slate-500">Cargando…</p>
        )}
        {datos !== null && (
          <>
            {compras.length === 0 ? (
              <p className="px-4 py-8 text-center text-slate-500">
                Todavía no hay compras de cisterna.
                {puedeGestionar ? " Registra la primera con «Registrar compra»." : ""}
              </p>
            ) : (
              <TablaDeCompras
                compras={visibles}
                conProveedor
                onAbrirProveedor={onAbrirProveedor}
                acciones={
                  puedeGestionar
                    ? { onHabilitar: habilitar, onAnular: setAnulando, ocupada }
                    : undefined
                }
              />
            )}
            <p className="px-4 py-3 text-xs text-slate-500">
              {conCombustible
                ? "La descarga en cancha se registra en Combustible → Cisternas; el resultado se ve aquí."
                : "Esta empresa no usa Combustible: la compra queda «por llegar». La descarga en cancha se registra en Combustible."}
              {!datos.gestiona &&
                " Tu perfil ve solo las compras que ya están por llegar y no las registra."}
            </p>
          </>
        )}
      </section>
      {formulario && (
        <FormularioCompra
          datos={formulario}
          compras={compras}
          onCerrar={() => setFormulario(null)}
          onRegistrada={(c) => {
            setFormulario(null);
            setAviso(`Compra ${c.numeroDocumento} registrada.`);
            recargar();
          }}
        />
      )}
      {anulando && (
        <AnularCompra
          compra={anulando}
          onCerrar={() => setAnulando(null)}
          onAnulada={(c) => {
            setAnulando(null);
            setAviso(`La compra ${c.numeroDocumento} quedó anulada.`);
            recargar();
          }}
        />
      )}
    </div>
  );
}
