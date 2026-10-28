// client/src/components/combustible/HistorialComprasRuta.tsx
//
// El historial UNIFICADO de las compras en ruta (migración 0135): una fila por
// boleta, con su combustible y su urea juntos, y la foto ÚNICA. Es donde el
// conductor sube la boleta que no pudo subir al comprar (tiene 24 horas), o la
// reemplaza con motivo.
//
// Las compras anteriores al formulario unificado también aparecen, agrupadas por
// su número de comprobante, aunque no tengan el total del papel.
import { useCallback, useEffect, useState } from "react";

import { seccionesCompraEnRuta } from "./compraEnRutaAcceso";
import { prepararFotoComprobante } from "./fotoComprobante";
import PendientesDeEnvio from "./PendientesDeEnvio";
import { useAuth } from "../../context/AuthContext";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";

const LITROS_POR_GALON = 3.785411784;

interface Boleta {
  clave: string;
  despachado_en: string;
  proveedor: string | null;
  placa_codigo: string | null;
  registrado_por: string | null;
  comprobante_tipo: string;
  comprobante_numero: string;
  combustible: {
    id: number;
    tipo_combustible: string | null;
    galones: number;
    unidad: "gal" | "L";
    costo_unitario: number;
    total: number;
  } | null;
  urea: {
    id: number;
    litros: number;
    total: number;
    lineas: { nombre: string | null; presentacion: string; cantidad_bultos: number }[];
  } | null;
  total_sistema: number;
  total_boleta: number | null;
  diferencia: number | null;
  motivo_descuadre: string | null;
  con_foto: number;
  despachos: number;
  foto_de: { id: number; producto: "combustible" | "urea" } | null;
}

const ETIQUETA_COMBUSTIBLE: Record<string, string> = {
  diesel_b5: "Diésel B5",
  gasolina_90: "Gasolina 90",
  glp: "GLP",
};

const soles = (n: number) =>
  `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CLASE_TH = "p-3 text-xs font-bold uppercase tracking-widest text-slate-400";
const CLASE_BOTON_LIMA =
  "inline-flex cursor-pointer items-center rounded-xl border border-[#BADC1E] bg-[#BADC1E] px-3 py-1.5 text-xs font-semibold text-[#0A1014] hover:brightness-105";

function urlDeLaFoto(b: Boleta): string | null {
  if (!b.foto_de) return null;
  return b.foto_de.producto === "urea"
    ? `/api/erp/combustible/urea/compras/${b.foto_de.id}/comprobante`
    : `/api/erp/combustible/despachos/${b.foto_de.id}/comprobante`;
}

export default function HistorialComprasRuta() {
  const { usuario } = useAuth();
  const puedeSubir =
    seccionesCompraEnRuta(usuario).combustible || seccionesCompraEnRuta(usuario).urea;

  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [boletas, setBoletas] = useState<Boleta[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  // Reemplazar una foto que ya existe pide motivo: es cambiar la evidencia.
  const [reemplazando, setReemplazando] = useState<Boleta | null>(null);
  const [archivoNuevo, setArchivoNuevo] = useState<File | null>(null);
  const [motivo, setMotivo] = useState("");
  const [errorReemplazo, setErrorReemplazo] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);

  const cargar = useCallback(async (d: string, h: string) => {
    setCargando(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (d) params.set("desde", new Date(`${d}T00:00:00`).toISOString());
      if (h) params.set("hasta", new Date(`${h}T23:59:59.999`).toISOString());
      const res = await apiFetch(`/api/erp/combustible/compras-ruta?${params.toString()}`);
      const cuerpo = await res.json().catch(() => null);
      if (!res.ok) {
        setError(mensajeDeError(cuerpo, "No se pudo cargar el historial de compras."));
        setBoletas([]);
        return;
      }
      setBoletas(Array.isArray(cuerpo) ? cuerpo : []);
    } catch {
      setError("Sin conexión: no se pudo cargar el historial. Vuelve a intentarlo con señal.");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar -- ver IpercView.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar("", "");
    // Una compra o una foto nueva refresca la lista sola.
    const alCambiar = () => void cargar("", "");
    window.addEventListener("combustible:actualizado", alCambiar);
    return () => window.removeEventListener("combustible:actualizado", alCambiar);
  }, [cargar]);

  /** Sube la foto a la boleta: con el id de cualquiera de sus despachos, el
   *  servidor la deja en los dos. */
  const subir = async (b: Boleta, archivo: File, motivoReemplazo?: string) => {
    const r = await prepararFotoComprobante(archivo);
    if ("error" in r) return r.error;
    const idDespacho = b.combustible?.id ?? b.urea?.id;
    const formData = new FormData();
    formData.append("archivo", r.lista);
    if (motivoReemplazo) formData.append("motivo", motivoReemplazo);
    try {
      const res = await apiFetch(`/api/erp/combustible/compras-ruta/${idDespacho}/comprobante`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => null);
        return mensajeDeError(cuerpo, "No se pudo subir el comprobante.");
      }
    } catch {
      return "Sin conexión: no se pudo subir. Inténtalo cuando vuelva la señal.";
    }
    return null;
  };

  const adjuntar = async (b: Boleta, archivo: File | undefined) => {
    if (!archivo) return;
    setAviso(null);
    setError(null);
    const fallo = await subir(b, archivo);
    if (fallo) {
      setError(fallo);
      return;
    }
    setAviso(`Comprobante adjuntado a la ${b.comprobante_tipo} ${b.comprobante_numero}.`);
    await cargar(desde, hasta);
  };

  const confirmarReemplazo = async () => {
    if (!reemplazando || !archivoNuevo || !motivo.trim() || subiendo) return;
    setSubiendo(true);
    setErrorReemplazo(null);
    const fallo = await subir(reemplazando, archivoNuevo, motivo.trim());
    setSubiendo(false);
    if (fallo) {
      setErrorReemplazo(fallo);
      return;
    }
    setAviso(
      `Comprobante de la ${reemplazando.comprobante_tipo} ${reemplazando.comprobante_numero} reemplazado.`
    );
    setReemplazando(null);
    setArchivoNuevo(null);
    setMotivo("");
    await cargar(desde, hasta);
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-4">
        <label className="flex flex-col gap-1 text-xs font-bold uppercase text-slate-700">
          Desde
          <input
            id="compras-desde"
            type="date"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal normal-case"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-bold uppercase text-slate-700">
          Hasta
          <input
            id="compras-hasta"
            type="date"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal normal-case"
          />
        </label>
        <button
          type="button"
          onClick={() => void cargar(desde, hasta)}
          disabled={cargando}
          className="rounded-xl border border-[#BADC1E] bg-[#BADC1E] px-4 py-2 text-sm font-semibold text-[#0A1014] hover:brightness-105 disabled:opacity-50"
        >
          Consultar
        </button>
        <span className="ml-auto text-xs text-slate-500">
          {boletas.length} {boletas.length === 1 ? "boleta" : "boletas"}
        </span>
      </div>

      <PendientesDeEnvio ambito="compras" />

      {aviso && (
        <p
          role="status"
          className="m-4 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900"
        >
          {aviso}
        </p>
      )}
      {error && (
        <p role="alert" className="m-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        {cargando ? (
          <p className="py-10 text-center text-sm text-slate-500">Cargando historial...</p>
        ) : boletas.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">
            Todavía no hay compras en ruta registradas.
          </p>
        ) : (
          <table className="w-full min-w-max border-collapse text-left">
            <thead>
              <tr>
                <th className={CLASE_TH}>Comprobante</th>
                <th className={CLASE_TH}>Fecha</th>
                <th className={CLASE_TH}>Proveedor</th>
                <th className={CLASE_TH}>Unidad</th>
                <th className={CLASE_TH}>Qué se compró</th>
                <th className={`${CLASE_TH} text-right`}>Total</th>
                <th className={`${CLASE_TH} text-right`}>Foto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {boletas.map((b) => {
                const completa = b.con_foto === b.despachos;
                const urlFoto = urlDeLaFoto(b);
                return (
                  <tr key={b.clave} className="align-top hover:bg-slate-50/50">
                    <td className="p-3 font-mono text-sm text-slate-800">
                      {b.comprobante_tipo === "factura" ? "Factura" : "Boleta"}{" "}
                      {b.comprobante_numero}
                    </td>
                    <td className="whitespace-nowrap p-3 text-sm text-slate-600">
                      {new Date(b.despachado_en).toLocaleString("es-PE", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="p-3 text-sm text-slate-700">{b.proveedor ?? "—"}</td>
                    <td className="p-3 text-sm text-slate-700">
                      {b.placa_codigo ?? "—"}
                      {b.registrado_por && (
                        <span className="block text-xs text-slate-400">{b.registrado_por}</span>
                      )}
                    </td>
                    <td className="p-3 text-sm text-slate-700">
                      {b.combustible && (
                        <span className="block">
                          {ETIQUETA_COMBUSTIBLE[b.combustible.tipo_combustible ?? ""] ??
                            "Combustible"}
                          : {b.combustible.galones.toLocaleString("es-PE")} {b.combustible.unidad}
                          <span className="text-xs text-slate-400">
                            {" "}
                            (≈{" "}
                            {(b.combustible.unidad === "L"
                              ? b.combustible.galones / LITROS_POR_GALON
                              : b.combustible.galones * LITROS_POR_GALON
                            ).toLocaleString("es-PE", { maximumFractionDigits: 1 })}{" "}
                            {b.combustible.unidad === "L" ? "gal" : "L"})
                          </span>{" "}
                          a {soles(b.combustible.costo_unitario)}
                        </span>
                      )}
                      {b.urea && (
                        <span className="block">
                          Urea:{" "}
                          {b.urea.lineas
                            .map((l) => `${l.cantidad_bultos}× ${l.nombre ?? l.presentacion}`)
                            .join(" + ")}{" "}
                          ({b.urea.litros.toLocaleString("es-PE")} L)
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-3 text-right text-sm tabular-nums text-slate-800">
                      {soles(b.total_sistema)}
                      {b.diferencia !== null && Math.abs(b.diferencia) > 0.1 && (
                        <span
                          className="mt-1 block text-xs text-amber-600"
                          title={b.motivo_descuadre ?? undefined}
                        >
                          Papel: {soles(b.total_boleta ?? 0)} (dif. {soles(Math.abs(b.diferencia))})
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-right text-sm">
                      {completa && urlFoto ? (
                        <div className="flex flex-col items-end gap-1">
                          <button
                            type="button"
                            onClick={() => window.open(urlFoto, "_blank")}
                            className="text-blue-600 hover:underline"
                          >
                            Ver comprobante
                          </button>
                          {puedeSubir && (
                            <button
                              type="button"
                              onClick={() => {
                                setReemplazando(b);
                                setArchivoNuevo(null);
                                setMotivo("");
                                setErrorReemplazo(null);
                              }}
                              className="text-xs text-slate-500 hover:underline"
                            >
                              Reemplazar
                            </button>
                          )}
                        </div>
                      ) : puedeSubir ? (
                        <label className={CLASE_BOTON_LIMA}>
                          Subir foto
                          <input
                            type="file"
                            accept="image/jpeg,image/png,application/pdf"
                            className="sr-only"
                            onChange={(e) => {
                              const archivo = e.target.files?.[0];
                              e.target.value = "";
                              void adjuntar(b, archivo);
                            }}
                          />
                        </label>
                      ) : (
                        <span className="text-xs text-amber-600">Sin foto</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {reemplazando && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setReemplazando(null)}
        >
          <div
            role="dialog"
            aria-label="Reemplazar comprobante"
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-slate-800">Reemplazar el comprobante</h3>
            <p className="mt-1 text-sm text-slate-500">
              {reemplazando.comprobante_tipo === "factura" ? "Factura" : "Boleta"}{" "}
              {reemplazando.comprobante_numero}. Cambiar la foto cambia la evidencia de la compra:
              queda registrado quién lo hizo y por qué.
            </p>
            <div className="mt-4 flex flex-col gap-3">
              <label className={`${CLASE_BOTON_LIMA} self-start`}>
                {archivoNuevo ? "Cambiar archivo" : "Elegir foto nueva"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,application/pdf"
                  className="sr-only"
                  onChange={(e) => setArchivoNuevo(e.target.files?.[0] ?? null)}
                />
              </label>
              {archivoNuevo && <span className="text-xs text-slate-500">{archivoNuevo.name}</span>}
              <label className="flex flex-col gap-1 text-xs font-bold uppercase text-slate-700">
                Motivo del reemplazo (obligatorio)
                <input
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Ej. la foto anterior estaba cortada"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal normal-case"
                />
              </label>
              {errorReemplazo && <p className="text-sm text-red-600">{errorReemplazo}</p>}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReemplazando(null)}
                className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmarReemplazo()}
                disabled={!archivoNuevo || !motivo.trim() || subiendo}
                className="rounded-xl border border-[#BADC1E] bg-[#BADC1E] px-4 py-2 text-sm font-semibold text-[#0A1014] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {subiendo ? "Subiendo…" : "Reemplazar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
