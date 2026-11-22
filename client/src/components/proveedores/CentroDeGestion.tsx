// client/src/components/proveedores/CentroDeGestion.tsx
//
// Pantalla de inicio del ecosistema. Todas las cifras salen de los proveedores que ya existen en el
// ERP: nada de ejemplo. Lo que todavía no existe (precios, documentos, compras...) se dice como
// «Pronto», no se inventa.
import { Building2, Droplets, Fuel, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { resumenProveedores, type ResumenProveedores } from "./proveedoresApi";
import { useAuth } from "../../context/AuthContext";

const PROXIMAMENTE = [
  "Homologación y gestión documental (se encienden por empresa)",
  "Contratos con proveedores",
  "Facturación y pagos",
  "Evaluación y desempeño, y riesgos y cumplimiento",
];

function saludo(): string {
  const hora = new Date().getHours();
  return hora < 12 ? "Buenos días" : hora < 19 ? "Buenas tardes" : "Buenas noches";
}

function Tarjeta({
  etiqueta,
  valor,
  detalle,
  Icono,
}: {
  etiqueta: string;
  valor: number | string;
  detalle: string;
  Icono: typeof Building2;
}) {
  return (
    <article className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 flex gap-4">
      <div className="w-10 h-10 rounded-lg bg-[#BADC1E]/20 text-[#4d7c0f] grid place-items-center shrink-0">
        <Icono size={20} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-500">{etiqueta}</p>
        <p className="text-2xl font-semibold text-slate-900 tabular-nums">{valor}</p>
        <p className="text-xs text-slate-500">{detalle}</p>
      </div>
    </article>
  );
}

export default function CentroDeGestion({ onIrAlDirectorio }: { onIrAlDirectorio: () => void }) {
  const { usuario } = useAuth();
  const [resumen, setResumen] = useState<ResumenProveedores | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    resumenProveedores()
      .then((r) => vigente && setResumen(r))
      .catch((e: Error) => vigente && setError(e.message));
    return () => {
      vigente = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
          Gestión de proveedores / Centro de gestión
        </p>
        <h1 className="text-3xl font-semibold text-slate-900 mt-1">
          {saludo()}
          {usuario?.nombre ? `, ${usuario.nombre.split(" ")[0]}` : ""}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          La situación de tus proveedores de combustible y urea.
        </p>
      </header>

      {error && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {error}
        </p>
      )}

      <section aria-label="Resumen" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tarjeta
          etiqueta="Proveedores registrados"
          valor={resumen?.total ?? "—"}
          detalle={resumen ? `${resumen.inactivos} desactivados` : "Cargando…"}
          Icono={Building2}
        />
        <Tarjeta
          etiqueta="Activos"
          valor={resumen?.activos ?? "—"}
          detalle="Reciben pedidos"
          Icono={ShieldCheck}
        />
        <Tarjeta
          etiqueta="Combustible"
          valor={resumen?.combustible ?? "—"}
          detalle={resumen ? `${resumen.internos} internos · ${resumen.externos} externos` : "—"}
          Icono={Fuel}
        />
        <Tarjeta
          etiqueta="Urea"
          valor={resumen?.urea ?? "—"}
          detalle="Proveedores de urea"
          Icono={Droplets}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
          <h2 className="text-base font-semibold text-slate-900">Directorio</h2>
          <p className="text-sm text-slate-500 mt-1">
            Consulta cada proveedor, qué abastece y si es interno (planta) o externo (ruta).
          </p>
          <button
            onClick={onIrAlDirectorio}
            className="mt-4 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
          >
            Abrir el directorio
          </button>
        </section>
        <section className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
          <h2 className="text-base font-semibold text-slate-900">Lo que viene</h2>
          <ul className="mt-2 space-y-1.5 text-sm text-slate-600 list-disc pl-5">
            {PROXIMAMENTE.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
