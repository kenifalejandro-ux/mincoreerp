// client/src/components/proveedores/FormularioContacto.tsx
//
// Agregar o editar una persona de contacto del proveedor. Doble clic: mientras guarda, el botón queda
// deshabilitado y el envío se ignora; además, al agregar, el formulario manda un `cliente_uuid` fijo desde
// que se abre, así que un reintento no crea un segundo contacto.
import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  cuerpoDelContacto,
  formularioDeContacto,
  problemasDelContacto,
  type FormularioDeContacto,
} from "./fichaFormulario";
import { actualizarContacto, crearContacto, type Contacto } from "./proveedoresApi";

const CAMPO =
  "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#84cc16]";
const ETIQUETA = "block text-xs font-semibold text-slate-600";

export default function FormularioContacto({
  proveedorId,
  contacto,
  onGuardado,
  onCerrar,
}: {
  proveedorId: number;
  /** Sin contacto = agregar uno nuevo. */
  contacto?: Contacto;
  onGuardado: (mensaje: string) => void;
  onCerrar: () => void;
}) {
  const [form, setForm] = useState<FormularioDeContacto>(() => formularioDeContacto(contacto));
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

  const cambiar = <K extends keyof FormularioDeContacto>(
    clave: K,
    valor: FormularioDeContacto[K]
  ) => setForm((f) => ({ ...f, [clave]: valor }));

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    const problemas = problemasDelContacto(form);
    if (problemas.length > 0) return setError(problemas.join(" "));
    setError(null);
    setGuardando(true);
    try {
      if (contacto) {
        await actualizarContacto(proveedorId, contacto.id, cuerpoDelContacto(form));
        onGuardado("Contacto actualizado.");
      } else {
        await crearContacto(proveedorId, cuerpoDelContacto(form, clienteUuid));
        onGuardado("Contacto agregado.");
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
        aria-labelledby="form-contacto-titulo"
        onSubmit={enviar}
        className="w-full max-w-lg rounded-2xl bg-white shadow-xl"
      >
        <header className="flex items-start justify-between p-5 border-b border-slate-200">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              {contacto ? "Editar" : "Nuevo registro"}
            </p>
            <h2 id="form-contacto-titulo" className="text-xl font-semibold text-slate-900">
              {contacto ? "Editar contacto" : "Agregar contacto"}
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
              <label htmlFor="contacto-nombre" className={ETIQUETA}>
                Nombre
              </label>
              <input
                id="contacto-nombre"
                ref={primero}
                value={form.nombre}
                onChange={(e) => cambiar("nombre", e.target.value)}
                maxLength={120}
                className={`${CAMPO} mt-1`}
              />
            </div>
            <div>
              <label htmlFor="contacto-cargo" className={ETIQUETA}>
                Cargo (opcional)
              </label>
              <input
                id="contacto-cargo"
                value={form.cargo}
                onChange={(e) => cambiar("cargo", e.target.value)}
                maxLength={80}
                className={`${CAMPO} mt-1`}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="contacto-telefono" className={ETIQUETA}>
                Teléfono
              </label>
              <input
                id="contacto-telefono"
                value={form.telefono}
                onChange={(e) => cambiar("telefono", e.target.value)}
                inputMode="tel"
                maxLength={40}
                className={`${CAMPO} mt-1`}
              />
            </div>
            <div>
              <label htmlFor="contacto-correo" className={ETIQUETA}>
                Correo
              </label>
              <input
                id="contacto-correo"
                value={form.correo}
                onChange={(e) => cambiar("correo", e.target.value)}
                inputMode="email"
                maxLength={150}
                className={`${CAMPO} mt-1`}
              />
            </div>
          </div>
          <p className="text-xs text-slate-500">Escribe al menos un teléfono o un correo.</p>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.principal}
              onChange={(e) => cambiar("principal", e.target.checked)}
              className="accent-[#65a30d]"
            />
            Es el contacto principal
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
