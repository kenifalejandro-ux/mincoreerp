// client/src/components/proveedores/DirectorioProveedores.tsx
//
// Directorio y ficha de los proveedores (solo lectura). INTERNO es la compra para despachar desde
// la planta y EXTERNO la que se hace en el recorrido de ruta: las mismas palabras que la pestaña
// Proveedores de Combustible.
import { ArrowLeft, Pencil, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import ComercialDeProveedor from "./ComercialDeProveedor";
import ComprasDeProveedor from "./ComprasDeProveedor";
import ContactosDeProveedor from "./ContactosDeProveedor";
import CuentasDeProveedor from "./CuentasDeProveedor";
import DatosDeProveedor from "./DatosDeProveedor";
import {
  abasteceA,
  dineroDelDirectorio,
  fichaIncompleta,
  filtrarDirectorio,
  resumenDelDirectorio,
  type FiltroAbastece,
  type FiltroEstado,
} from "./directorioProveedores";
import FormularioProveedor from "./FormularioProveedor";
import {
  puedeVerComprasDeProveedores,
  puedeVerCuentasDeProveedores,
  puedeVerPreciosDeProveedores,
} from "./proveedoresAcceso";
import {
  listarProveedores,
  type Proveedor,
  type ProveedorEnDirectorio,
  type TipoProveedor,
} from "./proveedoresApi";
import { useAuth } from "../../context/AuthContext";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";

const iniciales = (nombre: string) =>
  nombre
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();

function Uso({ interno, externo }: { interno: boolean; externo: boolean }) {
  if (!interno && !externo) return <span className="text-slate-400">—</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {interno && (
        <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-xs font-semibold">
          Interno
        </span>
      )}
      {externo && (
        <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-xs font-semibold">
          Externo
        </span>
      )}
    </span>
  );
}

function Estado({ activo }: { activo: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${
        activo ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
      }`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {activo ? "Activo" : "Desactivado"}
    </span>
  );
}

export type PestanaFicha = "resumen" | "contactos" | "cuentas" | "comercial" | "compras";

const ETIQUETA_PESTANA: Record<PestanaFicha, string> = {
  resumen: "Resumen",
  contactos: "Contactos",
  cuentas: "Cuentas",
  comercial: "Comercial",
  compras: "Compras",
};

function Ficha({
  proveedor,
  onVolver,
  onEditar,
  verPrecios,
  verCompras,
  verCuentas,
  pestanaInicial,
  onPestana,
}: {
  proveedor: ProveedorEnDirectorio;
  onVolver: () => void;
  /** Sin función = el perfil no puede editar. */
  onEditar?: () => void;
  /** Muestra la pestaña «Comercial» (precios): solo quien ve los precios. */
  verPrecios: boolean;
  /** Muestra la pestaña «Compras»: solo quien ve las compras de cisterna. */
  verCompras: boolean;
  /** Muestra la pestaña «Cuentas»: solo quien tiene ese permiso (nace solo para el admin). */
  verCuentas: boolean;
  pestanaInicial: PestanaFicha;
  /** Avisa cuando la persona cambia de pestaña (para reflejarlo en la dirección). */
  onPestana?: (pestana: PestanaFicha) => void;
}) {
  const pestanas: PestanaFicha[] = [
    "resumen",
    "contactos",
    ...(verCuentas ? (["cuentas"] as const) : []),
    ...(verPrecios ? (["comercial"] as const) : []),
    ...(verCompras ? (["compras"] as const) : []),
  ];
  const [pestana, setPestana] = useState<PestanaFicha>(
    pestanas.includes(pestanaInicial) ? pestanaInicial : "resumen"
  );
  const filas: { producto: string; interno: boolean; externo: boolean }[] = [
    { producto: "Combustible", ...proveedor.combustible },
    { producto: "Urea", ...proveedor.urea },
  ];
  return (
    <div className="space-y-5">
      <button
        onClick={onVolver}
        className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft size={16} /> Volver al directorio
      </button>
      <header className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-xl bg-[#0A1014] text-[#BADC1E] grid place-items-center font-semibold text-lg">
          {iniciales(proveedor.nombre)}
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 flex flex-wrap items-center gap-3">
            {proveedor.nombre} <Estado activo={proveedor.activo} />
          </h1>
          <p className="text-sm text-slate-500">
            {proveedor.codigo} · {proveedor.ruc ? `RUC ${proveedor.ruc}` : "Sin RUC"}
          </p>
        </div>
        {onEditar && (
          <button
            onClick={onEditar}
            className="ml-auto flex items-center gap-2 h-10 px-4 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Pencil size={16} /> Editar
          </button>
        )}
      </header>

      <div
        role="tablist"
        aria-label="Secciones de la ficha"
        className="flex gap-1 border-b border-slate-200"
      >
        {pestanas.map((p) => (
          <button
            key={p}
            role="tab"
            aria-selected={pestana === p}
            onClick={() => {
              setPestana(p);
              onPestana?.(p);
            }}
            className={`px-4 py-2.5 text-sm -mb-px border-b-2 ${
              pestana === p
                ? "border-[#84cc16] font-semibold text-[#3f6212]"
                : "border-transparent text-slate-500 hover:text-slate-900"
            }`}
          >
            {ETIQUETA_PESTANA[p]}
          </button>
        ))}
      </div>

      {pestana === "contactos" && <ContactosDeProveedor proveedorId={proveedor.id} />}
      {pestana === "cuentas" && <CuentasDeProveedor proveedorId={proveedor.id} />}
      {pestana === "comercial" && <ComercialDeProveedor proveedorId={proveedor.id} />}
      {pestana === "compras" && <ComprasDeProveedor proveedorId={proveedor.id} />}

      {pestana === "resumen" && (
        <>
          <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
            <h2 className="px-5 pt-4 text-base font-semibold text-slate-900">Qué abastece</h2>
            <table className="w-full text-sm mt-2">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                  <th className="px-5 py-2">Producto</th>
                  <th className="px-5 py-2">Interno (planta)</th>
                  <th className="px-5 py-2">Externo (ruta)</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr key={f.producto} className="border-b border-slate-100 last:border-0">
                    <td className="px-5 py-3 font-medium text-slate-800">{f.producto}</td>
                    <td className="px-5 py-3">{f.interno ? "Sí" : "No"}</td>
                    <td className="px-5 py-3">{f.externo ? "Sí" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <DatosDeProveedor proveedorId={proveedor.id} />
        </>
      )}
    </div>
  );
}

export default function DirectorioProveedores({
  apertura,
  onFicha,
}: {
  /** Abrir directo la ficha de un proveedor (p. ej. desde Gestión comercial o desde una dirección).
   *  `id: null` = la lista. */
  apertura?: { id: number | null; pestana: PestanaFicha };
  /** Avisa qué ficha y pestaña hay abiertas (o `null` = la lista), para reflejarlo en la dirección. Con
   *  `reemplazar` la dirección se corrige sin sumar un paso al historial (un enlace a un proveedor que no
   *  existe). */
  onFicha?: (
    ficha: { id: number; pestana: PestanaFicha } | null,
    opciones?: { reemplazar?: boolean }
  ) => void;
}) {
  const { usuario } = useAuth();
  const verPrecios = puedeVerPreciosDeProveedores(usuario);
  const verCompras = puedeVerComprasDeProveedores(usuario);
  const verCuentas = puedeVerCuentasDeProveedores(usuario);
  const [lista, setLista] = useState<ProveedorEnDirectorio[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [tipo, setTipo] = useState<"todos" | TipoProveedor>("todos");
  const [abastece, setAbastece] = useState<FiltroAbastece>("todos");
  const [estado, setEstado] = useState<FiltroEstado>("todos");
  const [abierto, setAbierto] = useState<number | null>(apertura?.id ?? null);
  const puedeEscribir = usePuedeEscribir("proveedores");
  // `null` = cerrado; `"nuevo"` = registrar; un proveedor = editarlo.
  const [formulario, setFormulario] = useState<null | "nuevo" | Proveedor>(null);

  useEffect(() => {
    let vigente = true;
    listarProveedores()
      .then((r) => vigente && setLista(r))
      .catch((e: Error) => vigente && setError(e.message));
    return () => {
      vigente = false;
    };
  }, []);

  const filtrados = useMemo(
    () => filtrarDirectorio(lista ?? [], { busqueda, tipo, abastece, estado }),
    [lista, busqueda, tipo, abastece, estado]
  );
  const resumen = useMemo(() => resumenDelDirectorio(lista ?? []), [lista]);

  // Al guardar se vuelve a pedir la lista: el servidor es quien calcula la ciudad, la ficha completa y el precio.
  const alGuardar = () => {
    setFormulario(null);
    listarProveedores()
      .then(setLista)
      .catch((e: Error) => setError(e.message));
  };
  const modal = formulario && (
    <FormularioProveedor
      proveedor={formulario === "nuevo" ? undefined : formulario}
      onGuardado={alGuardar}
      onCerrar={() => setFormulario(null)}
    />
  );

  const seleccionado = lista?.find((p) => p.id === abierto);
  // Un enlace a un proveedor que no existe (o ya no): se muestra la lista y la dirección se corrige.
  useEffect(() => {
    if (lista && abierto !== null && !lista.some((p) => p.id === abierto)) {
      onFicha?.(null, { reemplazar: true });
    }
  }, [lista, abierto, onFicha]);
  if (seleccionado)
    return (
      <>
        <Ficha
          proveedor={seleccionado}
          onVolver={() => {
            setAbierto(null);
            onFicha?.(null);
          }}
          onPestana={(pestana) => onFicha?.({ id: seleccionado.id, pestana })}
          onEditar={puedeEscribir ? () => setFormulario(seleccionado) : undefined}
          verPrecios={verPrecios}
          verCompras={verCompras}
          verCuentas={verCuentas}
          pestanaInicial={apertura?.id === seleccionado.id ? apertura.pestana : "resumen"}
        />
        {modal}
      </>
    );

  const control =
    "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#84cc16]";
  const tarjetas: { etiqueta: string; valor: number; nota: string }[] = [
    { etiqueta: "Total registrados", valor: resumen.total, nota: "En el directorio" },
    { etiqueta: "Activos", valor: resumen.activos, nota: "Reciben pedidos" },
    { etiqueta: "Combustible", valor: resumen.combustible, nota: "Proveedores" },
    { etiqueta: "Urea", valor: resumen.urea, nota: "Proveedores" },
  ];
  // Los precios solo se piden (y se muestran) si esta persona los ve.
  const columnas = verPrecios ? 7 : 6;
  return (
    <div className="space-y-5">
      {modal}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            Empresas / Directorio
          </p>
          <h1 className="text-3xl font-semibold text-slate-900 mt-1">Directorio de proveedores</h1>
          <p className="text-sm text-slate-500 mt-1">
            Todos los proveedores que nos abastecen de combustible y urea.
          </p>
        </div>
        {puedeEscribir && (
          <button
            onClick={() => setFormulario("nuevo")}
            className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
          >
            <Plus size={16} /> Registrar proveedor
          </button>
        )}
      </header>

      <section
        aria-label="Resumen del directorio"
        className="grid grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-xl shadow-sm"
      >
        {tarjetas.map((t) => (
          <div
            key={t.etiqueta}
            className="grid grid-cols-[1fr_auto] px-5 py-4 border-slate-200 border-r last:border-r-0 [&:nth-child(2)]:border-r-0 lg:[&:nth-child(2)]:border-r"
          >
            <span className="text-[11px] font-semibold text-slate-500">{t.etiqueta}</span>
            <b className="row-span-2 col-start-2 text-[22px] font-extrabold text-slate-900">
              {lista === null ? "—" : t.valor}
            </b>
            <small className="text-[10px] text-slate-500 mt-1">{t.nota}</small>
          </div>
        ))}
      </section>

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-slate-200">
          <label className="relative flex-1 min-w-56 max-w-md">
            <span className="sr-only">Buscar proveedor</span>
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por razón social, RUC, código o ciudad..."
              className={`${control} w-full pl-9`}
            />
          </label>
          <select
            aria-label="Tipo"
            className={control}
            value={tipo}
            onChange={(e) => setTipo(e.target.value as typeof tipo)}
          >
            <option value="todos">Todos los tipos</option>
            <option value="Combustible">Combustible</option>
            <option value="Urea">Urea</option>
          </select>
          <select
            aria-label="Abastece a"
            className={control}
            value={abastece}
            onChange={(e) => setAbastece(e.target.value as FiltroAbastece)}
          >
            <option value="todos">Abastece a: todos</option>
            <option value="interno">Interno</option>
            <option value="externo">Externo</option>
          </select>
          <select
            aria-label="Estado"
            className={control}
            value={estado}
            onChange={(e) => setEstado(e.target.value as FiltroEstado)}
          >
            <option value="todos">Todos los estados</option>
            <option value="activos">Activo</option>
            <option value="inactivos">Inactivo</option>
          </select>
        </div>

        {error && (
          <p
            role="alert"
            className="m-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
          >
            {error}
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b border-slate-200">
                <th className="px-4 py-3">Proveedor</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Abastece a</th>
                <th className="px-4 py-3">Lugar</th>
                {verPrecios && <th className="px-4 py-3">Precio vigente</th>}
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Ficha completa</th>
              </tr>
            </thead>
            <tbody>
              {lista === null && !error && (
                <tr>
                  <td colSpan={columnas} className="px-4 py-8 text-center text-slate-500">
                    Cargando…
                  </td>
                </tr>
              )}
              {lista !== null && filtrados.length === 0 && (
                <tr>
                  <td colSpan={columnas} className="px-4 py-8 text-center text-slate-500">
                    {lista.length === 0
                      ? "Todavía no hay proveedores registrados."
                      : "Sin resultados"}
                  </td>
                </tr>
              )}
              {filtrados.map((p) => (
                <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <button
                      onClick={() => {
                        setAbierto(p.id);
                        onFicha?.({ id: p.id, pestana: "resumen" });
                      }}
                      className="flex items-center gap-3 text-left"
                    >
                      <span className="w-9 h-9 rounded-lg bg-slate-100 text-[#4d7c0f] grid place-items-center text-xs font-bold shrink-0">
                        {iniciales(p.nombre)}
                      </span>
                      <span>
                        <span className="block font-semibold text-slate-900">{p.nombre}</span>
                        <span className="block text-xs text-slate-500">
                          {p.codigo} · {p.ruc ? `RUC ${p.ruc}` : "Sin RUC"}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{p.tipos.join(", ") || "—"}</td>
                  <td className="px-4 py-3">
                    <Uso {...abasteceA(p)} />
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {p.ciudad ?? <span className="text-slate-400">—</span>}
                  </td>
                  {verPrecios && (
                    <td className="px-4 py-3">
                      {p.precioVigente ? (
                        <>
                          <b className="block text-slate-900">
                            {dineroDelDirectorio(p.precioVigente.precio)}
                          </b>
                          <small className="block text-xs text-slate-500">
                            {p.precioVigente.producto}
                          </small>
                        </>
                      ) : (
                        <span className="font-semibold text-amber-600">Sin precio</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <Estado activo={p.activo} />
                  </td>
                  <td className="px-4 py-3 w-36">
                    <span
                      role="progressbar"
                      aria-label={`Ficha completa de ${p.nombre}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={p.fichaCompleta.porcentaje}
                      title={
                        p.fichaCompleta.faltan.length
                          ? `Falta: ${p.fichaCompleta.faltan.join(", ")}`
                          : "Ficha completa"
                      }
                      className="block h-1.5 rounded-full bg-slate-100 overflow-hidden"
                    >
                      <em
                        className={`block h-full rounded-full ${
                          fichaIncompleta(p.fichaCompleta.porcentaje)
                            ? "bg-amber-500"
                            : "bg-[#84cc16]"
                        }`}
                        style={{ width: `${p.fichaCompleta.porcentaje}%` }}
                      />
                    </span>
                    <small className="block text-xs text-slate-500 mt-1">
                      {p.fichaCompleta.porcentaje} % completa
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-xs text-slate-500">
          {lista === null ? "" : `Mostrando ${filtrados.length} de ${lista.length} proveedores`}
        </p>
      </section>
    </div>
  );
}
