// client/src/components/proveedores/DatosDeProveedor.tsx
//
// «Datos y condiciones de pago» de la ficha (pestaña Datos generales): dirección, teléfono, correo, forma de
// pago y moneda (la ciudad se ve en «Identificación», pero se edita aquí). Quien puede editar la ficha ve el botón «Editar datos».
import { Pencil } from "lucide-react";
import { useState } from "react";

import { textoDeFormaDePago, textoDeMoneda } from "./fichaFormulario";
import FormularioDatosProveedor from "./FormularioDatosProveedor";
import type { DatosFicha } from "./proveedoresApi";
import { usePuedeEditarProveedor } from "./usePuedeEditarProveedor";

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string | null }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{etiqueta}</dt>
      <dd className={valor ? "text-sm text-slate-800" : "text-sm text-slate-400"}>
        {valor ?? "Sin definir"}
      </dd>
    </div>
  );
}

export default function DatosDeProveedor({
  proveedorId,
  datos,
  onGuardado,
}: {
  proveedorId: number;
  datos: DatosFicha;
  /** Se guardaron los datos: quien la dibuja vuelve a leer la ficha. */
  onGuardado: () => void;
}) {
  const puedeEditar = usePuedeEditarProveedor();
  const [editando, setEditando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
      <header className="flex items-center justify-between gap-3 px-5 pt-4">
        <h2 className="text-base font-semibold text-slate-900">Datos y condiciones de pago</h2>
        {puedeEditar && (
          <button
            onClick={() => setEditando(true)}
            className="flex items-center gap-2 h-9 px-3 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Pencil size={14} /> Editar datos
          </button>
        )}
      </header>
      {aviso && (
        <p
          role="status"
          className="mx-5 mt-3 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3"
        >
          {aviso}
        </p>
      )}
      <dl className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        <Dato etiqueta="Dirección" valor={datos.direccion} />
        <Dato etiqueta="Teléfono" valor={datos.telefono} />
        <Dato etiqueta="Correo" valor={datos.correo} />
        <Dato etiqueta="Forma de pago" valor={datos.formaPago ? textoDeFormaDePago(datos) : null} />
        <Dato etiqueta="Moneda" valor={datos.moneda ? textoDeMoneda(datos.moneda) : null} />
      </dl>
      {editando && (
        <FormularioDatosProveedor
          proveedorId={proveedorId}
          datos={datos}
          onCerrar={() => setEditando(false)}
          onGuardado={() => {
            setEditando(false);
            setAviso("Datos guardados.");
            onGuardado();
          }}
        />
      )}
    </section>
  );
}
