// client/src/components/proveedores/FormularioProveedor.tsx
//
// Registrar o editar un proveedor. INTERNO es la compra para despachar desde la planta y EXTERNO la que
// se hace en el recorrido de ruta: las mismas palabras de Combustible. Doble clic: mientras guarda, el
// botón queda deshabilitado y el envío se ignora (el servidor, además, rechaza un nombre o un RUC repetido).
import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  actualizarProveedor,
  crearProveedor,
  type DatosProveedor,
  type Proveedor,
} from "./proveedoresApi";

const VACIO: DatosProveedor = {
  nombre: "",
  ruc: "",
  abastece_tanque: false,
  abastece_ruta: false,
  abastece_urea: false,
  abastece_urea_ruta: false,
};

function datosDe(p: Proveedor): DatosProveedor {
  return {
    nombre: p.nombre,
    ruc: p.ruc ?? "",
    abastece_tanque: p.combustible.interno,
    abastece_ruta: p.combustible.externo,
    abastece_urea: p.urea.interno,
    abastece_urea_ruta: p.urea.externo,
  };
}

type Bandera = "abastece_tanque" | "abastece_ruta" | "abastece_urea" | "abastece_urea_ruta";
const CASILLAS: { producto: string; uso: string; campo: Bandera }[] = [
  { producto: "Combustible", uso: "Interno", campo: "abastece_tanque" },
  { producto: "Combustible", uso: "Externo", campo: "abastece_ruta" },
  { producto: "Urea", uso: "Interno", campo: "abastece_urea" },
  { producto: "Urea", uso: "Externo", campo: "abastece_urea_ruta" },
];

export default function FormularioProveedor({
  proveedor,
  onGuardado,
  onCerrar,
}: {
  /** Sin proveedor = registrar uno nuevo. */
  proveedor?: Proveedor;
  onGuardado: (p: Proveedor) => void;
  onCerrar: () => void;
}) {
  const [datos, setDatos] = useState<DatosProveedor>(proveedor ? datosDe(proveedor) : VACIO);
  const [activo, setActivo] = useState(proveedor?.activo ?? true);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const primero = useRef<HTMLInputElement>(null);

  useEffect(() => {
    primero.current?.focus();
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    const nombre = datos.nombre.trim();
    const ruc = datos.ruc.trim();
    if (!nombre) return setError("Escribe el nombre del proveedor.");
    if (ruc !== "" && !/^\d{11}$/.test(ruc)) return setError("El RUC debe tener 11 dígitos.");
    if (!CASILLAS.some((c) => datos[c.campo])) return setError("Elige qué abastece el proveedor.");
    setError(null);
    setGuardando(true);
    try {
      const guardado = proveedor
        ? await actualizarProveedor(proveedor.id, { ...datos, nombre, ruc, activo })
        : await crearProveedor({ ...datos, nombre, ruc });
      onGuardado(guardado);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  };

  const campo =
    "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#84cc16]";
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="form-proveedor-titulo"
        onSubmit={enviar}
        className="w-full max-w-lg rounded-2xl bg-white shadow-xl"
      >
        <header className="flex items-start justify-between p-5 border-b border-slate-200">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              {proveedor ? "Editar" : "Nuevo registro"}
            </p>
            <h2 id="form-proveedor-titulo" className="text-xl font-semibold text-slate-900">
              {proveedor ? "Editar proveedor" : "Registrar proveedor"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="text-slate-500 hover:text-slate-900"
          >
            <X size={20} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          <label className="block text-xs font-semibold text-slate-600">
            Razón social
            <input
              ref={primero}
              value={datos.nombre}
              onChange={(e) => setDatos({ ...datos, nombre: e.target.value })}
              maxLength={150}
              className={`${campo} mt-1`}
            />
          </label>
          <label className="block text-xs font-semibold text-slate-600">
            RUC (opcional)
            <input
              value={datos.ruc}
              onChange={(e) => setDatos({ ...datos, ruc: e.target.value })}
              inputMode="numeric"
              maxLength={11}
              placeholder="11 dígitos"
              className={`${campo} mt-1`}
            />
          </label>

          <fieldset>
            <legend className="text-xs font-semibold text-slate-600">Qué abastece</legend>
            <p className="text-xs text-slate-500 mb-2">
              <b>Interno:</b> compra para despachar desde la planta. <b>Externo:</b> se compra en el
              recorrido de ruta.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {CASILLAS.map(({ producto, uso, campo: clave }) => (
                <label
                  key={clave}
                  className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 cursor-pointer has-[:checked]:border-[#84cc16] has-[:checked]:bg-[#BADC1E]/10"
                >
                  <input
                    type="checkbox"
                    checked={datos[clave]}
                    onChange={(e) => setDatos({ ...datos, [clave]: e.target.checked })}
                    className="accent-[#65a30d]"
                  />
                  {producto} · {uso}
                </label>
              ))}
            </div>
          </fieldset>

          {proveedor && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={activo}
                onChange={(e) => setActivo(e.target.checked)}
                className="accent-[#65a30d]"
              />
              Activo (recibe pedidos)
            </label>
          )}

          {error && (
            <p
              role="alert"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
            >
              {error}
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 p-5 border-t border-slate-200">
          <button
            type="button"
            onClick={onCerrar}
            className="h-10 px-4 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={guardando}
            className="h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95 disabled:opacity-60"
          >
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </footer>
      </form>
    </div>
  );
}
