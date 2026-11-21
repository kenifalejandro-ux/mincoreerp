// client/src/components/proveedores/ContactosDeProveedor.tsx
//
// La pestaña «Contactos» de la ficha: las personas de contacto del proveedor, con la principal primero.
// Quien puede editar la ficha agrega, edita y quita (quitar la oculta, no la borra: queda en la bitácora).
import { Mail, Pencil, Phone, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";

import FormularioContacto from "./FormularioContacto";
import { quitarContacto, type Contacto } from "./proveedoresApi";
import { useFicha } from "./useFicha";
import { usePuedeEditarProveedor } from "./usePuedeEditarProveedor";

export default function ContactosDeProveedor({ proveedorId }: { proveedorId: number }) {
  const { ficha, error, recargar } = useFicha(proveedorId);
  const puedeEditar = usePuedeEditarProveedor();
  // `null` = cerrado; `{}` = agregar; `{ contacto }` = editar.
  const [formulario, setFormulario] = useState<{ contacto?: Contacto } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [problema, setProblema] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState<number | null>(null);
  const [quitando, setQuitando] = useState(false);

  if (error)
    return (
      <p
        role="alert"
        className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
      >
        {error}
      </p>
    );
  if (!ficha) return <p className="text-sm text-slate-500">Cargando…</p>;

  const quitar = async (c: Contacto) => {
    if (quitando) return;
    setQuitando(true);
    setProblema(null);
    try {
      await quitarContacto(proveedorId, c.id);
      setConfirmando(null);
      setAviso("Contacto quitado.");
      recargar();
    } catch (e) {
      setProblema(e instanceof Error ? e.message : "No se pudo quitar el contacto.");
    } finally {
      setQuitando(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Personas de contacto</h2>
        {puedeEditar && (
          <button
            onClick={() => setFormulario({})}
            className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
          >
            <Plus size={16} /> Agregar contacto
          </button>
        )}
      </div>
      {aviso && (
        <p
          role="status"
          className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3"
        >
          {aviso}
        </p>
      )}
      {problema && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {problema}
        </p>
      )}

      {ficha.contactos.length === 0 ? (
        <p className="text-sm text-slate-600 bg-white border border-dashed border-slate-300 rounded-xl p-5">
          Este proveedor todavía no tiene contactos.
          {puedeEditar ? " Agrega el primero con «Agregar contacto»." : ""}
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {ficha.contactos.map((c) => (
            <li
              key={c.id}
              className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900 flex flex-wrap items-center gap-2">
                    {c.nombre}
                    {c.principal && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#BADC1E]/25 text-[#3f6212]">
                        <Star size={10} /> Principal
                      </span>
                    )}
                  </p>
                  {c.cargo && <p className="text-xs text-slate-500">{c.cargo}</p>}
                </div>
                {puedeEditar && (
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => setFormulario({ contacto: c })}
                      aria-label={`Editar contacto ${c.nombre}`}
                      className="p-2 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => setConfirmando(confirmando === c.id ? null : c.id)}
                      aria-label={`Quitar contacto ${c.nombre}`}
                      className="p-2 rounded-md text-slate-500 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </div>
              {c.telefono && (
                <p className="flex items-center gap-2 text-sm text-slate-700">
                  <Phone size={14} className="text-slate-400" /> {c.telefono}
                </p>
              )}
              {c.correo && (
                <p className="flex items-center gap-2 text-sm text-slate-700 break-all">
                  <Mail size={14} className="text-slate-400" /> {c.correo}
                </p>
              )}
              {confirmando === c.id && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  ¿Quitar a {c.nombre}?
                  <button
                    onClick={() => quitar(c)}
                    disabled={quitando}
                    className="h-8 px-3 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-60"
                  >
                    {quitando ? "Quitando…" : "Sí, quitar"}
                  </button>
                  <button
                    onClick={() => setConfirmando(null)}
                    className="h-8 px-3 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700"
                  >
                    No
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {formulario && (
        <FormularioContacto
          proveedorId={proveedorId}
          contacto={formulario.contacto}
          onCerrar={() => setFormulario(null)}
          onGuardado={(mensaje) => {
            setFormulario(null);
            setAviso(mensaje);
            recargar();
          }}
        />
      )}
    </section>
  );
}
