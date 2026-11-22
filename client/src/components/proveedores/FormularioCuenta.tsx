// client/src/components/proveedores/FormularioCuenta.tsx
//
// Agregar o editar una cuenta bancaria del proveedor. El número nunca vuelve a la pantalla: al editar el
// campo queda vacío y, si no se escribe nada, se conserva el que está. Doble clic: mientras guarda, el
// botón queda deshabilitado; además, al agregar, el formulario manda un `cliente_uuid` fijo desde que se
// abre, así que un reintento no crea una segunda cuenta.
import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  TIPOS_DE_CUENTA,
  cuerpoDeLaCuenta,
  formularioDeCuenta,
  problemasDeLaCuenta,
  type FormularioDeCuenta,
} from "./cuentasFormulario";
import { actualizarCuenta, crearCuenta, type CuentaBancaria } from "./proveedoresApi";

const CAMPO =
  "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#84cc16]";
const ETIQUETA = "block text-xs font-semibold text-slate-600";

export default function FormularioCuenta({
  proveedorId,
  cuenta,
  onGuardado,
  onCerrar,
}: {
  proveedorId: number;
  /** Sin cuenta = agregar una nueva. */
  cuenta?: CuentaBancaria;
  onGuardado: (mensaje: string) => void;
  onCerrar: () => void;
}) {
  const [form, setForm] = useState<FormularioDeCuenta>(() => formularioDeCuenta(cuenta));
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [clienteUuid] = useState(() => crypto.randomUUID());
  const primero = useRef<HTMLInputElement>(null);

  useEffect(() => {
    primero.current?.focus();
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  const cambiar = <K extends keyof FormularioDeCuenta>(clave: K, valor: FormularioDeCuenta[K]) =>
    setForm((f) => ({ ...f, [clave]: valor }));

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    const problemas = problemasDeLaCuenta(form, !!cuenta);
    if (problemas.length > 0) return setError(problemas.join(" "));
    setError(null);
    setGuardando(true);
    try {
      if (cuenta) {
        await actualizarCuenta(proveedorId, cuenta.id, cuerpoDeLaCuenta(form));
        onGuardado("Cuenta actualizada.");
      } else {
        await crearCuenta(proveedorId, cuerpoDeLaCuenta(form, { clienteUuid }));
        onGuardado("Cuenta agregada.");
      }
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
        aria-labelledby="form-cuenta-titulo"
        onSubmit={enviar}
        className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-2xl bg-white shadow-xl"
      >
        <header className="flex items-start justify-between p-5 border-b border-slate-200">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              {cuenta ? "Editar" : "Nuevo registro"}
            </p>
            <h2 id="form-cuenta-titulo" className="text-xl font-semibold text-slate-900">
              {cuenta ? "Editar cuenta bancaria" : "Agregar cuenta bancaria"}
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
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="cuenta-banco" className={ETIQUETA}>
                Banco
              </label>
              <input
                id="cuenta-banco"
                ref={primero}
                value={form.banco}
                onChange={(e) => cambiar("banco", e.target.value)}
                maxLength={80}
                className={`${CAMPO} mt-1`}
              />
            </div>
            <div>
              <label htmlFor="cuenta-tipo" className={ETIQUETA}>
                Tipo de cuenta
              </label>
              <select
                id="cuenta-tipo"
                value={form.tipo_cuenta}
                onChange={(e) =>
                  cambiar("tipo_cuenta", e.target.value as FormularioDeCuenta["tipo_cuenta"])
                }
                className={`${CAMPO} mt-1`}
              >
                {TIPOS_DE_CUENTA.map((t) => (
                  <option key={t.valor} value={t.valor}>
                    {t.texto}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="cuenta-moneda" className={ETIQUETA}>
                Moneda
              </label>
              <select
                id="cuenta-moneda"
                value={form.moneda}
                onChange={(e) => cambiar("moneda", e.target.value as FormularioDeCuenta["moneda"])}
                className={`${CAMPO} mt-1`}
              >
                <option value="PEN">Soles (S/)</option>
                <option value="USD">Dólares (US$)</option>
              </select>
            </div>
            <div>
              <label htmlFor="cuenta-titular" className={ETIQUETA}>
                Titular (opcional)
              </label>
              <input
                id="cuenta-titular"
                value={form.titular}
                onChange={(e) => cambiar("titular", e.target.value)}
                maxLength={150}
                className={`${CAMPO} mt-1`}
              />
            </div>
          </div>
          <div>
            <label htmlFor="cuenta-numero" className={ETIQUETA}>
              Número de cuenta o CCI
            </label>
            <input
              id="cuenta-numero"
              value={form.numero}
              onChange={(e) => cambiar("numero", e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              maxLength={30}
              placeholder={
                cuenta
                  ? `Déjalo vacío para conservar el actual (${cuenta.numeroEnmascarado})`
                  : "De 8 a 20 dígitos"
              }
              className={`${CAMPO} mt-1`}
            />
            <p className="mt-1 text-xs text-slate-500">
              Se guarda cifrado y solo se ve completo quien tiene ese permiso.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.principal}
              onChange={(e) => cambiar("principal", e.target.checked)}
              className="accent-[#65a30d]"
            />
            Es la cuenta principal
          </label>

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
