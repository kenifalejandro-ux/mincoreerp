// client/src/components/proveedores/FormularioDatosProveedor.tsx
//
// Editar los datos de contacto y las condiciones de pago de un proveedor. Todo es opcional. Doble clic:
// mientras guarda, el botón queda deshabilitado y el envío se ignora.
import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  cuerpoDeDatos,
  formularioDeDatos,
  problemasDeDatos,
  type FormularioDeDatos,
} from "./fichaFormulario";
import { guardarDatosFicha, type DatosFicha } from "./proveedoresApi";

const CAMPO =
  "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#84cc16]";
const ETIQUETA = "block text-xs font-semibold text-slate-600";

export default function FormularioDatosProveedor({
  proveedorId,
  datos,
  onGuardado,
  onCerrar,
}: {
  proveedorId: number;
  datos: DatosFicha;
  onGuardado: () => void;
  onCerrar: () => void;
}) {
  const [form, setForm] = useState<FormularioDeDatos>(() => formularioDeDatos(datos));
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const primero = useRef<HTMLInputElement>(null);

  useEffect(() => {
    primero.current?.focus();
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  const cambiar = <K extends keyof FormularioDeDatos>(clave: K, valor: FormularioDeDatos[K]) =>
    setForm((f) => ({ ...f, [clave]: valor }));

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    const problemas = problemasDeDatos(form);
    if (problemas.length > 0) return setError(problemas.join(" "));
    setError(null);
    setGuardando(true);
    try {
      await guardarDatosFicha(proveedorId, cuerpoDeDatos(form));
      onGuardado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="form-datos-titulo"
        onSubmit={enviar}
        className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-2xl bg-white shadow-xl"
      >
        <header className="flex items-start justify-between p-5 border-b border-slate-200">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              Ficha del proveedor
            </p>
            <h2 id="form-datos-titulo" className="text-xl font-semibold text-slate-900">
              Datos y condiciones de pago
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
          <div>
            <label htmlFor="datos-ciudad" className={ETIQUETA}>
              Ciudad
            </label>
            <input
              id="datos-ciudad"
              ref={primero}
              value={form.ciudad}
              onChange={(e) => cambiar("ciudad", e.target.value)}
              maxLength={80}
              placeholder="Ej. Arequipa"
              className={`${CAMPO} mt-1`}
            />
          </div>
          <div>
            <label htmlFor="datos-direccion" className={ETIQUETA}>
              Dirección
            </label>
            <input
              id="datos-direccion"
              value={form.direccion}
              onChange={(e) => cambiar("direccion", e.target.value)}
              maxLength={250}
              className={`${CAMPO} mt-1`}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="datos-telefono" className={ETIQUETA}>
                Teléfono
              </label>
              <input
                id="datos-telefono"
                value={form.telefono}
                onChange={(e) => cambiar("telefono", e.target.value)}
                inputMode="tel"
                maxLength={40}
                className={`${CAMPO} mt-1`}
              />
            </div>
            <div>
              <label htmlFor="datos-correo" className={ETIQUETA}>
                Correo
              </label>
              <input
                id="datos-correo"
                value={form.correo}
                onChange={(e) => cambiar("correo", e.target.value)}
                inputMode="email"
                maxLength={150}
                className={`${CAMPO} mt-1`}
              />
            </div>
          </div>

          <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
            <legend className="px-1 text-xs font-bold uppercase tracking-wider text-slate-500">
              Condiciones de pago
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="datos-forma" className={ETIQUETA}>
                  Forma de pago
                </label>
                <select
                  id="datos-forma"
                  value={form.forma_pago}
                  onChange={(e) =>
                    cambiar("forma_pago", e.target.value as "" | "contado" | "credito")
                  }
                  className={`${CAMPO} mt-1`}
                >
                  <option value="">Sin definir</option>
                  <option value="contado">Contado</option>
                  <option value="credito">Crédito</option>
                </select>
              </div>
              {form.forma_pago === "credito" && (
                <div>
                  <label htmlFor="datos-plazo" className={ETIQUETA}>
                    Plazo (días)
                  </label>
                  <input
                    id="datos-plazo"
                    value={form.plazo_pago_dias}
                    onChange={(e) => cambiar("plazo_pago_dias", e.target.value)}
                    inputMode="numeric"
                    maxLength={3}
                    className={`${CAMPO} mt-1`}
                  />
                </div>
              )}
            </div>
            <div>
              <label htmlFor="datos-moneda" className={ETIQUETA}>
                Moneda
              </label>
              <select
                id="datos-moneda"
                value={form.moneda}
                onChange={(e) => cambiar("moneda", e.target.value as "" | "PEN" | "USD")}
                className={`${CAMPO} mt-1`}
              >
                <option value="">Sin definir</option>
                <option value="PEN">Soles (S/)</option>
                <option value="USD">Dólares (US$)</option>
              </select>
            </div>
          </fieldset>

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
