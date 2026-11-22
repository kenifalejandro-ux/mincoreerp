// client/src/components/proveedores/DirectorioProveedores.tsx
//
// Directorio de los proveedores (la lista) y la ficha que se abre desde ella (FichaDeProveedor). INTERNO es la
// compra para despachar desde la planta y EXTERNO la que se hace en el recorrido de ruta: las mismas palabras
// que la pestaña Proveedores de Combustible.
import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  abasteceA,
  dineroDelDirectorio,
  fichaIncompleta,
  filtrarDirectorio,
  resumenDelDirectorio,
  type FiltroAbastece,
  type FiltroEstado,
} from "./directorioProveedores";
import EstadoDeProveedor from "./EstadoDeProveedor";
import FichaDeProveedor from "./FichaDeProveedor";
import { inicialesDeProveedor, type PestanaFicha } from "./fichaProveedor";
import FormularioProveedor from "./FormularioProveedor";
import { puedeVerHistorialDeProveedores } from "./historialProveedores";
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

export type { PestanaFicha };

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
  const verHistorial = puedeVerHistorialDeProveedores(usuario);
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
  const recargarLista = () =>
    listarProveedores()
      .then(setLista)
      .catch((e: Error) => setError(e.message));
  const alGuardar = () => {
    setFormulario(null);
    void recargarLista();
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
        <FichaDeProveedor
          proveedor={seleccionado}
          acceso={{ verPrecios, verCompras, verCuentas, verHistorial }}
          pestanaInicial={apertura?.id === seleccionado.id ? apertura.pestana : "resumen"}
          onVolver={() => {
            setAbierto(null);
            onFicha?.(null);
            // Lo que se editó en la ficha (ciudad, datos, contactos) cambia el % de la lista.
            void recargarLista();
          }}
          onPestana={(pestana) => onFicha?.({ id: seleccionado.id, pestana })}
          onEditar={puedeEscribir ? () => setFormulario(seleccionado) : undefined}
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
                        {inicialesDeProveedor(p.nombre)}
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
                    <EstadoDeProveedor activo={p.activo} />
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
