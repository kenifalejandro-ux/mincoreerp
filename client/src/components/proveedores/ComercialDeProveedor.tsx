// client/src/components/proveedores/ComercialDeProveedor.tsx
//
// La pestaña «Comercial» de la ficha: los precios de UN proveedor, cada uno con su historia (los
// anulados se ven tachados con su motivo). Quien carga precios puede poner uno nuevo y anular uno mal
// cargado (con motivo); el resto solo lo consulta.
import { useState } from "react";

import AnularPrecio from "./AnularPrecio";
import BotonNuevoPrecio from "./BotonNuevoPrecio";
import { textoDeFormaDePago, textoDeMoneda } from "./fichaFormulario";
import { ETIQUETA_DE_USO, formatoDia, formatoFecha, formatoPrecio } from "./preciosProveedores";
import { PrecioVigente, Programado, RigeDesde, VigenciaHasta, Variacion } from "./TablaDePrecios";
import { useFicha } from "./useFicha";
import { usePrecios } from "./usePrecios";
import { usePuedeCargarPrecios } from "./usePuedeCargarPrecios";

export default function ComercialDeProveedor({ proveedorId }: { proveedorId: number }) {
  const { datos, error, recargar } = usePrecios();
  const { ficha } = useFicha(proveedorId);
  const puedeCargar = usePuedeCargarPrecios(datos);
  const [ahora] = useState(() => Date.now());
  const [aviso, setAviso] = useState<string | null>(null);
  const [anulando, setAnulando] = useState<{
    producto: "combustible" | "urea";
    id: number;
    descripcion: string;
  } | null>(null);
  const filas = (datos?.filas ?? []).filter((f) => f.proveedorId === proveedorId);

  if (error)
    return (
      <p
        role="alert"
        className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
      >
        {error}
      </p>
    );
  if (datos === null) return <p className="text-sm text-slate-500">Cargando…</p>;
  const boton = puedeCargar && (
    <BotonNuevoPrecio
      filas={datos.filas}
      proveedorInicial={proveedorId}
      onCargado={(mensaje) => {
        setAviso(mensaje);
        recargar();
      }}
    />
  );
  const mensaje = aviso && (
    <p
      role="status"
      className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3"
    >
      {aviso}
    </p>
  );
  if (filas.length === 0)
    return (
      <div className="space-y-4">
        {mensaje}
        <section className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 text-sm text-slate-600 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 mb-1">Sin precios</h2>
            Este proveedor todavía no tiene precios cargados.
            {puedeCargar ? "" : " Se cargan en Combustible → Precios."}
          </div>
          {boton}
        </section>
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-3">{boton}</div>
      {mensaje}
      {filas.map((f) => (
        <article key={f.clave} className="bg-white border border-slate-200 rounded-xl shadow-sm">
          <header className="flex flex-wrap items-start justify-between gap-4 p-5">
            <div>
              <h2 className="text-base font-semibold text-slate-900">{f.detalle}</h2>
              <p className="text-xs text-slate-500">
                {f.producto === "combustible" ? "Combustible (ruta)" : "Urea"}
              </p>
            </div>
            <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Precio vigente</dt>
                <dd>
                  <PrecioVigente fila={f} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Vs. anterior</dt>
                <dd>
                  <Variacion fila={f} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Rige desde</dt>
                <dd>
                  <RigeDesde fila={f} ahora={ahora} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Vigencia hasta</dt>
                <dd>
                  <VigenciaHasta fila={f} ahora={ahora} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Programado</dt>
                <dd>
                  <Programado fila={f} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Uso</dt>
                <dd className="text-slate-800">{ETIQUETA_DE_USO[f.uso]}</dd>
              </div>
            </dl>
          </header>
          <details className="border-t border-slate-200">
            <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-slate-700">
              Historial ({f.historial.length})
            </summary>
            {f.historial.length === 0 ? (
              <p className="px-5 pb-4 text-sm text-slate-500">Todavía no se cargó ningún precio.</p>
            ) : (
              <ul className="px-5 pb-4 space-y-1.5 text-sm">
                {f.historial.map((h) => (
                  <li
                    key={h.id}
                    className={`flex flex-wrap items-baseline gap-x-4 ${h.anulado ? "text-slate-400" : "text-slate-700"}`}
                  >
                    <span className={`tabular-nums w-24 ${h.anulado ? "line-through" : ""}`}>
                      {formatoFecha(h.desde)}
                    </span>
                    <b className={`tabular-nums ${h.anulado ? "line-through" : ""}`}>
                      {formatoPrecio(h.precio)}
                    </b>
                    {h.hasta && <span className="text-xs">hasta {formatoDia(h.hasta)}</span>}
                    {h.marca && <span>{h.marca}</span>}
                    {h.por && <span className="text-xs">cargado por {h.por}</span>}
                    {h.anulado && (
                      <span className="text-xs">(anulado: {h.motivo ?? "sin motivo"})</span>
                    )}
                    {puedeCargar && !h.anulado && (
                      <button
                        onClick={() =>
                          setAnulando({
                            producto: f.producto,
                            id: h.id,
                            descripcion: `${f.detalle} · ${formatoPrecio(h.precio)} desde ${formatoFecha(h.desde)}`,
                          })
                        }
                        aria-label={`Anular precio ${f.detalle} ${formatoPrecio(h.precio)}`}
                        className="ml-auto h-7 px-2.5 rounded-lg border border-red-200 text-xs font-semibold text-red-700 hover:bg-red-50"
                      >
                        Anular
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </article>
      ))}
      <section className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
          Condiciones
        </p>
        <h2 className="text-base font-semibold text-slate-900">Condiciones comerciales</h2>
        <dl className="mt-3 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Moneda
            </dt>
            <dd className="text-sm text-slate-800">
              {ficha?.datos.moneda ? textoDeMoneda(ficha.datos.moneda) : "Sin definir"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Condición de pago habitual
            </dt>
            <dd className="text-sm text-slate-800">
              {ficha?.datos.formaPago ? textoDeFormaDePago(ficha.datos) : "Sin definir"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Productos con precio
            </dt>
            <dd className="text-sm text-slate-800">{filas.filter((f) => f.vigente).length}</dd>
          </div>
        </dl>
      </section>
      {anulando && (
        <AnularPrecio
          producto={anulando.producto}
          precioId={anulando.id}
          descripcion={anulando.descripcion}
          onCerrar={() => setAnulando(null)}
          onAnulado={() => {
            setAnulando(null);
            setAviso("Precio anulado.");
            recargar();
          }}
        />
      )}
    </div>
  );
}
