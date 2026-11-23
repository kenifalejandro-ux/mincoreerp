// client/src/components/proveedores/DirectorioProveedores.tsx
//
// Directorio de los proveedores (la lista). La ficha se abre en el panel lateral (PanelDeProveedor). INTERNO es la
// compra para despachar desde la planta y EXTERNO la que se hace en el recorrido de ruta: las mismas palabras
// que la pestaña Proveedores de Combustible.
import { Download, Plus, Search } from "lucide-react";
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
import { exportarProveedoresExcel, leerProveedoresParaExportar } from "./exportarProveedores";
import { inicialesDeProveedor } from "./fichaProveedor";
import FormularioProveedor from "./FormularioProveedor";
import MasAcciones from "./MasAcciones";
import { puedeVerPreciosDeProveedores } from "./proveedoresAcceso";
import {
  listarProveedores,
  type ProveedorEnDirectorio,
  type TipoProveedor,
} from "./proveedoresApi";
import { useAccionesDeProveedor } from "./useAccionesDeProveedor";
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

export default function DirectorioProveedores({
  onAbrirProveedor,
  refresco = 0,
}: {
  /** Abre la ficha del proveedor en el panel lateral (la lista queda donde está). */
  onAbrirProveedor: (proveedorId: number) => void;
  /** Cambia cada vez que algo editado afuera (la ficha del panel) obliga a volver a leer la lista. */
  refresco?: number;
}) {
  const [lista, setLista] = useState<ProveedorEnDirectorio[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [tipo, setTipo] = useState<"todos" | TipoProveedor>("todos");
  const [abastece, setAbastece] = useState<FiltroAbastece>("todos");
  const [estado, setEstado] = useState<FiltroEstado>("todos");
  const puedeEscribir = usePuedeEscribir("proveedores");
  const { usuario } = useAuth();
  const verPrecios = puedeVerPreciosDeProveedores(usuario);
  const [registrando, setRegistrando] = useState(false);
  const [exportando, setExportando] = useState(false);
  const [falloExportar, setFalloExportar] = useState<string | null>(null);
  // Se lee al abrir y cada vez que cambia `refresco` (se editó algo en el panel) o se registra uno nuevo: el
  // servidor calcula la ciudad, la ficha completa y el precio. La lista anterior no se borra mientras tanto.
  const [versionPropia, setVersionPropia] = useState(0);

  useEffect(() => {
    let vigente = true;
    listarProveedores()
      .then((r) => {
        if (!vigente) return;
        setLista(r);
        setError(null);
      })
      .catch((e: Error) => vigente && setError(e.message));
    return () => {
      vigente = false;
    };
  }, [refresco, versionPropia]);

  const filtrados = useMemo(
    () => filtrarDirectorio(lista ?? [], { busqueda, tipo, abastece, estado }),
    [lista, busqueda, tipo, abastece, estado]
  );
  const resumen = useMemo(() => resumenDelDirectorio(lista ?? []), [lista]);

  // Las acciones de cada fila (editar, desactivar, eliminar): al terminar se vuelve a leer la lista.
  const { acciones, dialogos } = useAccionesDeProveedor({
    onCambio: () => setVersionPropia((v) => v + 1),
  });
  const hayAcciones = (lista ?? []).some((p) => acciones(p).length > 0);

  // Exporta lo que se ve en la tabla (con la búsqueda y los filtros): el servidor arma las filas y la bitácora
  // anota quién exportó y cuántos.
  const exportar = async () => {
    if (exportando || filtrados.length === 0) return;
    setExportando(true);
    setFalloExportar(null);
    try {
      const hayFiltro = filtrados.length !== (lista?.length ?? 0);
      await exportarProveedoresExcel(
        await leerProveedoresParaExportar(hayFiltro ? filtrados.map((p) => p.id) : undefined)
      );
    } catch (e) {
      setFalloExportar(e instanceof Error ? e.message : "No se pudo exportar.");
    } finally {
      setExportando(false);
    }
  };

  const modal = registrando && (
    <FormularioProveedor
      onGuardado={() => {
        setRegistrando(false);
        setVersionPropia((v) => v + 1);
      }}
      onCerrar={() => setRegistrando(false)}
    />
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
  const columnas = (verPrecios ? 7 : 6) + (hayAcciones ? 1 : 0);
  return (
    <div className="space-y-5">
      {modal}
      {dialogos}
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
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={exportar}
            disabled={exportando || filtrados.length === 0}
            className="flex items-center gap-2 h-10 px-4 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            <Download size={16} /> {exportando ? "Exportando…" : "Exportar a Excel"}
          </button>
          {puedeEscribir && (
            <button
              onClick={() => setRegistrando(true)}
              className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
            >
              <Plus size={16} /> Registrar proveedor
            </button>
          )}
        </div>
      </header>

      {falloExportar && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {falloExportar}
        </p>
      )}

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

        {/* `relative`: el «sr-only» de la columna de acciones es `position:absolute`; sin un ancestro posicionado
            no lo recorta este contenedor y ensancha la PÁGINA (877 px en un celular de 393). */}
        <div className="relative overflow-x-auto">
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
                {hayAcciones && (
                  <th className="px-2 py-3">
                    <span className="sr-only">Acciones</span>
                  </th>
                )}
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
                      onClick={() => onAbrirProveedor(p.id)}
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
                  {hayAcciones && (
                    <td className="px-2 py-3 text-right">
                      <MasAcciones
                        soloIcono
                        etiqueta="Acciones del proveedor"
                        acciones={acciones(p)}
                      />
                    </td>
                  )}
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
