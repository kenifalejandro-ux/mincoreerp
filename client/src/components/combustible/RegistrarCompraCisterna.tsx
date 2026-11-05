import { X } from "lucide-react";
import { useState } from "react";

import {
  cuerpoDeLaCompra,
  ETIQUETA_COMBUSTIBLE,
  ETIQUETA_DOCUMENTO,
  formularioInicial,
  problemasDeLaCompra,
  sugerenciasPara,
  type FormularioDeCompra,
} from "./comprasCisternaLogica";
import type {
  CompraDeCisterna,
  DatosParaElFormulario,
  TipoCombustibleDeCompra,
  TipoDocumentoDeCompra,
} from "./comprasCisternaTipos";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";

// El formulario de "Registrar compra": lo que la encargada anota cuando se compra una cisterna.
// Pide lo que importa (proveedor, documento, fecha de emisión, llegada a planta y cantidad) y rellena
// solo la sede, el combustible, el precio y la empresa de transporte desde lo último de ese proveedor.
// Lo demás (placas, chofer, peso) vive en el documento. Quien lo monta le pone `key`: cada apertura
// nace con su formulario y su identificador de reenvío.

const CAMPO = "w-full border border-slate-200 rounded-xl p-3 text-sm";
const ETIQUETA = "text-xs font-bold text-slate-700 uppercase";

export default function RegistrarCompraCisterna({
  compras,
  datos,
  onCerrar,
  onRegistrado,
}: {
  compras: CompraDeCisterna[];
  datos: DatosParaElFormulario;
  onCerrar: () => void;
  onRegistrado: (mensaje: string) => void;
}) {
  const [form, setForm] = useState<FormularioDeCompra>(() => {
    const base = formularioInicial();
    // Una sola sede: no hay nada que elegir.
    return datos.sedes.length === 1
      ? { ...base, grifo_interno_id: String(datos.sedes[0].id) }
      : base;
  });
  // Lo que la persona ya escribió a mano no se pisa con una sugerencia nueva.
  const [tocados, setTocados] = useState<ReadonlySet<keyof FormularioDeCompra>>(new Set());
  const [clienteUuid] = useState(() => crypto.randomUUID());
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cambiar = <K extends keyof FormularioDeCompra>(campo: K, valor: FormularioDeCompra[K]) => {
    setTocados((t) => new Set(t).add(campo));
    setForm((f) => ({ ...f, [campo]: valor }));
  };

  // Elegir el proveedor (o el combustible) trae lo que se sabe de él, salvo lo ya tocado a mano.
  const aplicarSugerencias = (
    proveedor: string,
    tipoCombustible: TipoCombustibleDeCompra | undefined,
    tocadosAhora: ReadonlySet<keyof FormularioDeCompra>
  ) => {
    if (proveedor === "") return;
    const sugerido = sugerenciasPara(Number(proveedor), compras, datos, tipoCombustible);
    setForm((f) => {
      const siguiente = { ...f };
      for (const [campo, valor] of Object.entries(sugerido) as [
        keyof FormularioDeCompra,
        string,
      ][]) {
        if (!tocadosAhora.has(campo)) (siguiente[campo] as string) = valor;
      }
      return siguiente;
    });
  };

  const problemas = problemasDeLaCompra(form);
  const sedeUnica = datos.sedes.length === 1;
  const sinPrecio = form.grifo_id !== "" && form.costo_unitario === "";

  const registrar = async () => {
    if (enviando || problemas.length > 0) return;
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/compras-cisterna", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpoDeLaCompra(form, clienteUuid)),
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => ({}));
        setError(mensajeDeError(cuerpo, "No se pudo registrar la compra."));
        return;
      }
      const proveedor = datos.proveedores.find((p) => String(p.id) === form.grifo_id)?.nombre;
      const que = `${ETIQUETA_DOCUMENTO[form.tipo_documento]} ${form.numero_documento.trim()} de ${proveedor ?? "el proveedor"}`;
      onCerrar();
      onRegistrado(
        res.status === 202
          ? `Sin conexión: la compra (${que}) quedó guardada en este equipo y se enviará sola cuando vuelva la señal.`
          : `Compra registrada: ${que}.`
      );
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#0D1719]/90 backdrop-blur-sm flex justify-center items-center z-[60] p-4">
      <div className="bg-white w-full max-w-xl rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b flex items-start gap-3">
          <div className="flex-1">
            <h3 className="text-xl font-bold">Registrar compra de cisterna</h3>
            <p className="text-sm text-slate-600">
              Anota lo que ya compraste: la cancha la verá cuando llegue. Las placas y el chofer
              quedan en el documento.
            </p>
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={onCerrar}
            className="text-slate-400 hover:text-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-3">
          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-12 sm:col-span-6 space-y-1">
              <label htmlFor="compra-proveedor" className={ETIQUETA}>
                Proveedor
              </label>
              <select
                id="compra-proveedor"
                className={CAMPO}
                value={form.grifo_id}
                onChange={(e) => {
                  const siguiente = new Set(tocados).add("grifo_id");
                  setTocados(siguiente);
                  setForm((f) => ({ ...f, grifo_id: e.target.value }));
                  aplicarSugerencias(e.target.value, undefined, siguiente);
                }}
              >
                <option value="">Elegir...</option>
                {datos.proveedores.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </select>
              {datos.proveedores.length === 0 && (
                <p className="text-xs text-amber-700">
                  No hay proveedores de tanque. Márcalos en Proveedores.
                </p>
              )}
            </div>
            <div className="col-span-12 sm:col-span-6 space-y-1">
              <label htmlFor="compra-combustible" className={ETIQUETA}>
                Combustible
              </label>
              <select
                id="compra-combustible"
                className={CAMPO}
                value={form.tipo_combustible}
                onChange={(e) => {
                  const tipo = e.target.value as TipoCombustibleDeCompra;
                  const siguiente = new Set(tocados).add("tipo_combustible");
                  setTocados(siguiente);
                  setForm((f) => ({ ...f, tipo_combustible: tipo }));
                  // El precio cambia con el combustible; lo demás que ya se sugirió se queda.
                  aplicarSugerencias(form.grifo_id, tipo, siguiente);
                }}
              >
                {(Object.keys(ETIQUETA_COMBUSTIBLE) as TipoCombustibleDeCompra[]).map((t) => (
                  <option key={t} value={t}>
                    {ETIQUETA_COMBUSTIBLE[t]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-12 sm:col-span-5 space-y-1">
              <label htmlFor="compra-documento" className={ETIQUETA}>
                Documento
              </label>
              <select
                id="compra-documento"
                className={CAMPO}
                value={form.tipo_documento}
                onChange={(e) => cambiar("tipo_documento", e.target.value as TipoDocumentoDeCompra)}
              >
                {(Object.keys(ETIQUETA_DOCUMENTO) as TipoDocumentoDeCompra[]).map((t) => (
                  <option key={t} value={t}>
                    {ETIQUETA_DOCUMENTO[t]}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-12 sm:col-span-7 space-y-1">
              <label htmlFor="compra-numero" className={ETIQUETA}>
                N° del documento
              </label>
              <input
                id="compra-numero"
                className={CAMPO}
                maxLength={100}
                placeholder="TRR1-00003638"
                value={form.numero_documento}
                onChange={(e) => cambiar("numero_documento", e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-12 sm:col-span-3 space-y-1">
              <label htmlFor="compra-emision" className={`${ETIQUETA} block whitespace-nowrap`}>
                Fecha de emisión
              </label>
              <input
                id="compra-emision"
                type="date"
                className={CAMPO}
                value={form.fecha_compra}
                onChange={(e) => cambiar("fecha_compra", e.target.value)}
              />
            </div>
            <div className="col-span-12 sm:col-span-3 space-y-1">
              <label htmlFor="compra-llegada" className={`${ETIQUETA} block whitespace-nowrap`}>
                Llegada a planta
              </label>
              <input
                id="compra-llegada"
                type="date"
                className={CAMPO}
                value={form.llegada_estimada}
                onChange={(e) => cambiar("llegada_estimada", e.target.value)}
              />
            </div>
            <div className="col-span-8 sm:col-span-4 space-y-1">
              <label htmlFor="compra-cantidad" className={`${ETIQUETA} block whitespace-nowrap`}>
                Cantidad
              </label>
              <input
                id="compra-cantidad"
                type="number"
                min={0}
                step="0.01"
                className={CAMPO}
                value={form.cantidad_facturada}
                onChange={(e) => cambiar("cantidad_facturada", e.target.value)}
              />
            </div>
            <div className="col-span-4 sm:col-span-2 space-y-1">
              <label htmlFor="compra-unidad" className={`${ETIQUETA} block whitespace-nowrap`}>
                Unidad
              </label>
              <select
                id="compra-unidad"
                className={CAMPO}
                value={form.unidad}
                onChange={(e) => cambiar("unidad", e.target.value as "gal" | "L")}
              >
                <option value="gal">gal</option>
                <option value="L">L</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-slate-500">
            La llegada a planta es la fecha estimada en que esperas la cisterna (no la de salida del
            proveedor que trae la guía). Ese día la cancha ya la ve para descargarla.
          </p>
          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-12 sm:col-span-6 space-y-1">
              <label htmlFor="compra-sede" className={ETIQUETA}>
                Sede de llegada
              </label>
              <select
                id="compra-sede"
                className={CAMPO}
                value={form.grifo_interno_id}
                disabled={sedeUnica}
                onChange={(e) => cambiar("grifo_interno_id", e.target.value)}
              >
                {!sedeUnica && <option value="">Elegir...</option>}
                {datos.sedes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.sede === s.nombre ? s.nombre : `${s.sede} · ${s.nombre}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-12 sm:col-span-6 space-y-1">
              <label htmlFor="compra-costo" className={ETIQUETA}>
                Costo por {form.unidad}
              </label>
              <input
                id="compra-costo"
                type="number"
                min={0}
                step="0.0001"
                className={CAMPO}
                value={form.costo_unitario}
                onChange={(e) => cambiar("costo_unitario", e.target.value)}
              />
              {sinPrecio && (
                <p className="text-xs text-amber-700">
                  Este proveedor no tiene precio cargado para ese combustible: escríbelo a mano.
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-12 sm:col-span-8 space-y-1">
              <label htmlFor="compra-transportista" className={ETIQUETA}>
                Empresa de transporte
              </label>
              <input
                id="compra-transportista"
                className={CAMPO}
                maxLength={150}
                placeholder="Razón social"
                value={form.transportista}
                onChange={(e) => cambiar("transportista", e.target.value)}
              />
            </div>
            <div className="col-span-12 sm:col-span-4 space-y-1">
              <label htmlFor="compra-transportista-ruc" className={ETIQUETA}>
                RUC
              </label>
              <input
                id="compra-transportista-ruc"
                inputMode="numeric"
                maxLength={11}
                className={CAMPO}
                value={form.transportista_ruc}
                onChange={(e) => cambiar("transportista_ruc", e.target.value.replace(/\D/g, ""))}
              />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm font-medium text-red-700">
              {error}
            </p>
          )}
          {problemas.length > 0 && form.grifo_id !== "" && (
            <ul className="text-xs text-slate-500 list-disc pl-5 space-y-0.5">
              {problemas.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCerrar}
              className="px-4 py-2 rounded-lg text-sm font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={enviando || problemas.length > 0}
              onClick={() => void registrar()}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all active:scale-95 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {enviando ? "Registrando..." : "Registrar compra"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
