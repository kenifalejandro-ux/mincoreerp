// client/src/components/proveedores/FormularioProveedor.tsx
//
// Registrar o editar un proveedor, como la maqueta: razón social, RUC, ciudad y dos listas («Qué suministra» y
// «Abastece a»). INTERNO es la compra para despachar desde la planta y EXTERNO la que se hace en el recorrido de
// ruta: las mismas palabras de Combustible. Al registrar, la pantalla termina con «Proveedor registrado». Un
// proveedor ya existente con una mezcla que las listas no pueden decir se edita con las cuatro casillas. Doble
// clic: mientras guarda, el botón queda deshabilitado y el envío se ignora (el servidor, además, rechaza un
// nombre o un RUC repetido). La lógica está en formularioProveedor.ts.
import { Check, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  cuerpoDelProveedor,
  ETIQUETA_SUMINISTRA,
  ETIQUETA_USO,
  formularioInicial,
  problemasDelProveedor,
  type Banderas,
  type FormularioDeProveedor,
  type Suministra,
  type UsoDeProveedor,
} from "./formularioProveedor";
import {
  actualizarProveedor,
  crearProveedor,
  type Proveedor,
  type ProveedorBasico,
} from "./proveedoresApi";

const CASILLAS: { producto: string; uso: string; campo: keyof Banderas }[] = [
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
  proveedor?: ProveedorBasico;
  onGuardado: (p: Proveedor) => void;
  onCerrar: () => void;
}) {
  const [form, setForm] = useState<FormularioDeProveedor>(() => formularioInicial(proveedor));
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  // Al registrar, la pantalla pasa a «Proveedor registrado» y el aviso a quien la abrió espera al «Continuar».
  const [registrado, setRegistrado] = useState<Proveedor | null>(null);
  const primero = useRef<HTMLInputElement>(null);

  useEffect(() => {
    primero.current?.focus();
  }, []);
  // Escape cierra; si ya se registró, cierra avisando (el proveedor ya existe y la lista debe leerse).
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (registrado) onGuardado(registrado);
      else onCerrar();
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar, onGuardado, registrado]);

  const cambiar = <K extends keyof FormularioDeProveedor>(
    campo: K,
    valor: FormularioDeProveedor[K]
  ) => setForm((f) => ({ ...f, [campo]: valor }));

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    const problemas = problemasDelProveedor(form);
    if (problemas.length) return setError(problemas[0]);
    setError(null);
    setGuardando(true);
    try {
      const cuerpo = cuerpoDelProveedor(form);
      if (proveedor) {
        onGuardado(await actualizarProveedor(proveedor.id, { ...cuerpo, activo: form.activo }));
      } else {
        setRegistrado(await crearProveedor(cuerpo));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  };

  const campo =
    "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#84cc16]";
  const etiqueta = "flex flex-col gap-1.5 text-[11px] font-semibold text-slate-500";
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !registrado && onCerrar()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="form-proveedor-titulo"
        onSubmit={enviar}
        className="w-full max-w-[570px] overflow-hidden rounded-[13px] bg-white shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-slate-200 px-[22px] pt-5 pb-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              {proveedor ? "Editar" : "Nuevo registro"}
            </p>
            <h2
              id="form-proveedor-titulo"
              className="mt-1 text-[19px] font-semibold text-slate-900"
            >
              {registrado
                ? "Proveedor registrado"
                : proveedor
                  ? "Editar proveedor"
                  : "Registrar proveedor"}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => (registrado ? onGuardado(registrado) : onCerrar())}
            aria-label="Cerrar"
            className="text-slate-500 hover:text-slate-900"
          >
            <X size={20} />
          </button>
        </header>

        {registrado ? (
          <div className="flex flex-col items-center px-8 py-10 text-center">
            <span className="mb-3 grid h-14 w-14 place-items-center rounded-full bg-[#BADC1E]/25 text-[#3f6212]">
              <Check size={30} />
            </span>
            <h3 className="text-lg font-semibold text-slate-900">Proveedor registrado</h3>
            <p className="mt-1 mb-5 max-w-sm text-sm text-slate-500">
              Ya aparece en el directorio. Completa su ficha y carga sus precios.
            </p>
            <button
              type="button"
              onClick={() => onGuardado(registrado)}
              className="h-10 px-5 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
            >
              Continuar
            </button>
          </div>
        ) : (
          <>
            <div className="grid gap-[15px] p-[22px] sm:grid-cols-2">
              <label className={`${etiqueta} sm:col-span-2`}>
                Razón social
                <input
                  ref={primero}
                  value={form.nombre}
                  onChange={(e) => cambiar("nombre", e.target.value)}
                  maxLength={150}
                  placeholder="Ej. Grifo Santa Rosa S.A.C."
                  className={campo}
                />
              </label>
              <label className={etiqueta}>
                RUC
                <input
                  value={form.ruc}
                  onChange={(e) => cambiar("ruc", e.target.value)}
                  inputMode="numeric"
                  maxLength={11}
                  placeholder="11 dígitos"
                  className={campo}
                />
              </label>
              <label className={etiqueta}>
                Ciudad
                <input
                  value={form.ciudad}
                  onChange={(e) => cambiar("ciudad", e.target.value)}
                  maxLength={80}
                  placeholder="Ej. Arequipa"
                  className={campo}
                />
              </label>

              {form.casillas ? (
                <fieldset className="sm:col-span-2">
                  <legend className="text-[11px] font-semibold text-slate-500">Qué abastece</legend>
                  <p className="mt-1 mb-2 text-xs text-slate-500">
                    Este proveedor mezcla productos y usos que las listas no pueden decir: elige
                    cada uno.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {CASILLAS.map(({ producto, uso, campo: clave }) => (
                      <label
                        key={clave}
                        className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 cursor-pointer has-[:checked]:border-[#84cc16] has-[:checked]:bg-[#BADC1E]/10"
                      >
                        <input
                          type="checkbox"
                          checked={form.casillas![clave]}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              casillas: { ...f.casillas!, [clave]: e.target.checked },
                            }))
                          }
                          className="accent-[#65a30d]"
                        />
                        {producto} · {uso}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : (
                <>
                  <label className={etiqueta}>
                    Qué suministra
                    <select
                      value={form.suministra}
                      onChange={(e) => cambiar("suministra", e.target.value as Suministra)}
                      className={campo}
                    >
                      {(Object.keys(ETIQUETA_SUMINISTRA) as Suministra[]).map((s) => (
                        <option key={s} value={s}>
                          {ETIQUETA_SUMINISTRA[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={etiqueta}>
                    Abastece a
                    <select
                      value={form.uso}
                      onChange={(e) => cambiar("uso", e.target.value as UsoDeProveedor)}
                      className={campo}
                    >
                      {(Object.keys(ETIQUETA_USO) as UsoDeProveedor[]).map((u) => (
                        <option key={u} value={u}>
                          {ETIQUETA_USO[u]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-xs text-slate-500 sm:col-span-2">
                    <b>Interno:</b> compra para despachar desde la planta. <b>Externo:</b> se compra
                    en el recorrido de ruta.
                  </p>
                </>
              )}

              {proveedor && (
                <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={form.activo}
                    onChange={(e) => cambiar("activo", e.target.checked)}
                    className="accent-[#65a30d]"
                  />
                  Activo (recibe pedidos)
                </label>
              )}

              {error && (
                <p
                  role="alert"
                  className="sm:col-span-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
                >
                  {error}
                </p>
              )}
            </div>

            <footer className="flex justify-end gap-2 border-t border-slate-200 px-[22px] py-3.5">
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
                className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95 disabled:opacity-60"
              >
                <Check size={16} /> {guardando ? "Guardando…" : "Guardar"}
              </button>
            </footer>
          </>
        )}
      </form>
    </div>
  );
}
