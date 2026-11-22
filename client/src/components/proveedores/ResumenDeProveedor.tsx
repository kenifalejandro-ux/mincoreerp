// client/src/components/proveedores/ResumenDeProveedor.tsx
//
// La pestaña «Resumen» de la ficha, como la maqueta: cuatro indicadores arriba, el resumen del proveedor y, a la
// derecha, qué suministra y su contacto principal. Los indicadores de lo que todavía no existe (documentos,
// homologación) dicen «Pronto»; el de precios solo cuenta si la persona ve precios.
import { Mail, Phone } from "lucide-react";

import {
  chipsDeSuministro,
  condicionDePago,
  contactoPrincipal,
  fichaCompleta,
  textoAbastece,
} from "./fichaProveedor";
import { Info, Panel } from "./PanelesDeFicha";
import type { FichaProveedor, ProveedorEnDirectorio, RespuestaPrecios } from "./proveedoresApi";

function Indicador({
  valor,
  etiqueta,
  nota,
  alerta,
  onNota,
}: {
  valor: string;
  etiqueta: string;
  nota: string;
  alerta?: boolean;
  /** Si la nota lleva a otra pestaña, es un botón. */
  onNota?: () => void;
}) {
  const color = alerta ? "text-amber-600" : "text-emerald-700";
  return (
    <article className="flex flex-col p-4 border-slate-200 border-r last:border-r-0 [&:nth-child(2)]:border-r-0 lg:[&:nth-child(2)]:border-r [&:nth-child(n+3)]:border-t lg:[&:nth-child(n+3)]:border-t-0">
      <b className="text-[21px] font-extrabold text-slate-900">{valor}</b>
      <span className="text-[11px] text-slate-500 my-0.5">{etiqueta}</span>
      {onNota ? (
        <button onClick={onNota} className={`text-left text-[11px] hover:underline ${color}`}>
          {nota}
        </button>
      ) : (
        <small className={`text-[11px] ${alerta ? color : "text-slate-500"}`}>{nota}</small>
      )}
    </article>
  );
}

export default function ResumenDeProveedor({
  proveedor,
  ficha,
  verPrecios,
  precios,
  onIrAComercial,
}: {
  proveedor: ProveedorEnDirectorio;
  ficha: FichaProveedor;
  verPrecios: boolean;
  /** Los precios (null mientras cargan o si no se ven). */
  precios: RespuestaPrecios | null;
  onIrAComercial: () => void;
}) {
  const completa = fichaCompleta(proveedor.ruc, ficha.datos, ficha.contactos);
  const filas = (precios?.filas ?? []).filter((f) => f.proveedorId === proveedor.id && f.vigente);
  const principal = contactoPrincipal(ficha.contactos);
  const abastece = textoAbastece({
    interno: proveedor.combustible.interno || proveedor.urea.interno,
    externo: proveedor.combustible.externo || proveedor.urea.externo,
  });
  const chips = chipsDeSuministro(
    filas.map((f) => f.detalle),
    proveedor.tipos
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_310px]">
      <div className="grid gap-4 content-start">
        <section
          aria-label="Indicadores del proveedor"
          className="grid grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-xl shadow-sm"
        >
          <Indicador
            valor={`${completa.porcentaje}%`}
            etiqueta="Ficha completa"
            nota={completa.faltan.length ? "Faltan datos" : "Completa"}
            alerta={completa.faltan.length > 0}
          />
          {verPrecios ? (
            <Indicador
              valor={precios ? String(filas.length) : "…"}
              etiqueta="Productos con precio"
              nota={filas.length ? "Ver en Comercial" : precios ? "Sin precio" : ""}
              alerta={!!precios && filas.length === 0}
              onNota={filas.length ? onIrAComercial : undefined}
            />
          ) : (
            <Indicador valor="—" etiqueta="Productos con precio" nota="Sin acceso" />
          )}
          <Indicador valor="—" etiqueta="Documentos" nota="Pronto" />
          <Indicador valor="—" etiqueta="Homologación" nota="Pronto" />
        </section>
        <Panel kicker="Información clave" titulo="Resumen del proveedor">
          <Info
            datos={[
              ["Razón social", proveedor.nombre],
              ["RUC", proveedor.ruc],
              ["Código", proveedor.codigo],
              ["Tipo", proveedor.tipos.join(", ")],
              ["Ciudad", ficha.datos.ciudad],
              ["Condición de pago", condicionDePago(ficha)],
            ]}
          />
        </Panel>
      </div>

      <aside className="grid gap-4 content-start">
        <Panel kicker="Qué suministra" titulo="Productos">
          <div className="flex flex-wrap gap-1.5 px-5 pb-2">
            {chips.map((c) => (
              <span
                key={c}
                className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600"
              >
                {c}
              </span>
            ))}
          </div>
          <p className="px-5 pb-4 text-[11px] text-slate-500">Abastece a: {abastece || "—"}</p>
        </Panel>
        <Panel kicker="Contacto principal" titulo={principal?.nombre ?? "Sin contacto"}>
          <div className="px-5 pb-4 space-y-1.5 text-sm">
            {principal?.correo && (
              <p className="flex items-center gap-2 text-[#3f6212]">
                <Mail size={14} /> {principal.correo}
              </p>
            )}
            {principal?.telefono && (
              <p className="flex items-center gap-2 text-[#3f6212]">
                <Phone size={14} /> {principal.telefono}
              </p>
            )}
            {!principal?.correo && !principal?.telefono && (
              <p className="text-slate-500">Sin datos de contacto</p>
            )}
          </div>
        </Panel>
      </aside>
    </div>
  );
}
