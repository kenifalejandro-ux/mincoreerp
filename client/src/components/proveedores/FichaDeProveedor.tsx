// client/src/components/proveedores/FichaDeProveedor.tsx
//
// La ficha de un proveedor, como la maqueta: cabecera con su logo, estado, ciudad y a qué abastece, con «Más
// acciones» y «Nuevo precio»; y las pestañas Resumen, Datos generales, Contactos, Cuentas, Comercial,
// Contratos, Documentos, Compras y recepciones e Historial. Cada persona ve solo las pestañas que le tocan.
import { ArrowLeft, Building2, Truck } from "lucide-react";
import { useState } from "react";

import BotonNuevoPrecio from "./BotonNuevoPrecio";
import ComercialDeProveedor from "./ComercialDeProveedor";
import ComprasDeProveedor from "./ComprasDeProveedor";
import ContactosDeProveedor from "./ContactosDeProveedor";
import CuentasDeProveedor from "./CuentasDeProveedor";
import DatosGenerales from "./DatosGenerales";
import EstadoDeProveedor from "./EstadoDeProveedor";
import {
  ETIQUETA_PESTANA,
  inicialesDeProveedor,
  pestanaPermitida,
  pestanasDeLaFicha,
  textoAbastece,
  textoDeTipos,
  type AccesoDeLaFicha,
  type PestanaFicha,
} from "./fichaProveedor";
import HistorialDeProveedores from "./HistorialDeProveedores";
import MasAcciones from "./MasAcciones";
import PestanaPronto from "./PestanaPronto";
import type { ProveedorEnDirectorio } from "./proveedoresApi";
import ResumenDeProveedor from "./ResumenDeProveedor";
import { useFicha } from "./useFicha";
import { usePrecios } from "./usePrecios";
import { usePuedeCargarPrecios } from "./usePuedeCargarPrecios";

export default function FichaDeProveedor({
  proveedor,
  acceso,
  pestanaInicial,
  onVolver,
  onEditar,
  onPestana,
}: {
  proveedor: ProveedorEnDirectorio;
  acceso: AccesoDeLaFicha;
  pestanaInicial: PestanaFicha;
  onVolver: () => void;
  /** Sin función = el perfil no puede editar. */
  onEditar?: () => void;
  /** Avisa cuando la persona cambia de pestaña (para reflejarlo en la dirección). */
  onPestana?: (pestana: PestanaFicha) => void;
}) {
  const [pestana, setPestana] = useState<PestanaFicha>(() =>
    pestanaPermitida(pestanaInicial, acceso)
  );
  const { ficha, error, recargar } = useFicha(proveedor.id);
  // Los precios se piden una sola vez: los usan el Resumen, la pestaña Comercial y «Nuevo precio».
  const precios = usePrecios(acceso.verPrecios);
  const puedeCargar = usePuedeCargarPrecios(precios.datos);
  const [aviso, setAviso] = useState<string | null>(null);

  const irA = (p: PestanaFicha) => {
    setPestana(p);
    setAviso(null);
    // El Resumen y Datos generales leen la ficha: al cambiar de pestaña se vuelve a leer (los contactos se
    // editan en su propia pestaña).
    recargar();
    onPestana?.(p);
  };

  const ciudad = ficha?.datos.ciudad ?? proveedor.ciudad;
  const abastece = textoAbastece({
    interno: proveedor.combustible.interno || proveedor.urea.interno,
    externo: proveedor.combustible.externo || proveedor.urea.externo,
  });
  const pestanas = pestanasDeLaFicha(acceso);

  return (
    <div className="space-y-5">
      <button
        onClick={onVolver}
        className="flex items-center gap-2 text-xs text-slate-500 hover:text-[#3f6212]"
      >
        <ArrowLeft size={14} /> Volver al directorio
      </button>

      <header className="flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-[60px] h-[60px] shrink-0 rounded-[13px] bg-[#BADC1E] text-[#0A1014] grid place-items-center font-extrabold text-lg">
            {inicialesDeProveedor(proveedor.nombre)}
          </div>
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold text-slate-900 flex flex-wrap items-center gap-3">
              {proveedor.nombre} <EstadoDeProveedor activo={proveedor.activo} />
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              {proveedor.codigo} · {proveedor.ruc ? `RUC ${proveedor.ruc}` : "Sin RUC"}
              {proveedor.tipos.length > 0 && ` · ${textoDeTipos(proveedor.tipos)}`}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-500">
              <span className="flex items-center gap-1.5">
                <Building2 size={15} /> {ciudad ? `${ciudad}, Perú` : "Sin ciudad"}
              </span>
              {abastece && (
                <span className="flex items-center gap-1.5">
                  <Truck size={15} /> Abastece a: {abastece}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MasAcciones
            acciones={
              onEditar ? [{ id: "editar", etiqueta: "Editar proveedor", alElegir: onEditar }] : []
            }
          />
          {puedeCargar && precios.datos && (
            <BotonNuevoPrecio
              filas={precios.datos.filas}
              proveedorInicial={proveedor.id}
              onCargado={(mensaje) => {
                setAviso(mensaje);
                precios.recargar();
              }}
            />
          )}
        </div>
      </header>

      {aviso && (
        <p
          role="status"
          className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3"
        >
          {aviso}
        </p>
      )}

      <div
        role="tablist"
        aria-label="Secciones de la ficha"
        className="flex gap-0.5 border-b border-slate-200 overflow-x-auto"
      >
        {pestanas.map((p) => (
          <button
            key={p}
            role="tab"
            aria-selected={pestana === p}
            onClick={() => irA(p)}
            className={`px-3 pt-3 pb-3 text-sm whitespace-nowrap -mb-px border-b-2 ${
              pestana === p
                ? "border-[#84cc16] font-bold text-[#3f6212]"
                : "border-transparent text-slate-500 hover:text-slate-900"
            }`}
          >
            {ETIQUETA_PESTANA[p]}
          </button>
        ))}
      </div>

      {error && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {error}
        </p>
      )}

      {pestana === "contactos" && <ContactosDeProveedor proveedorId={proveedor.id} />}
      {pestana === "cuentas" && <CuentasDeProveedor proveedorId={proveedor.id} />}
      {pestana === "comercial" && (
        <ComercialDeProveedor proveedorId={proveedor.id} precios={precios} />
      )}
      {pestana === "compras" && <ComprasDeProveedor proveedorId={proveedor.id} />}
      {pestana === "historial" && <HistorialDeProveedores proveedorId={proveedor.id} />}
      {pestana === "contratos" && (
        <PestanaPronto
          kicker="Compromisos"
          titulo="Contratos"
          aviso="Vista de lo que viene. Los contratos con proveedores se implementarán más adelante; hoy no están disponibles en el ERP."
          vacio="Sin contratos registrados."
        />
      )}
      {pestana === "documentos" && (
        <PestanaPronto
          kicker="Vigencias"
          titulo="Documentos"
          aviso="Vista de lo que viene. Los documentos y certificados de cada proveedor se implementarán más adelante; hoy no están disponibles en el ERP."
          vacio="Sin documentos cargados."
        />
      )}

      {!ficha && !error && (pestana === "resumen" || pestana === "datos") && (
        <p className="text-sm text-slate-500">Cargando…</p>
      )}
      {ficha && pestana === "resumen" && (
        <ResumenDeProveedor
          proveedor={proveedor}
          ficha={ficha}
          verPrecios={acceso.verPrecios}
          precios={precios.datos}
          onIrAComercial={() => irA("comercial")}
        />
      )}
      {ficha && pestana === "datos" && (
        <DatosGenerales proveedor={proveedor} ficha={ficha} onGuardado={recargar} />
      )}
    </div>
  );
}
