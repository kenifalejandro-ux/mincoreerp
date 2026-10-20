// client/src/components/UreaPanel.tsx
//
// La pestaña "Urea" dentro de Combustible (migración 0092, decisión de
// Kenif 2026-09-10: pestaña propia, mismas tablas de combustible_despachos
// -- no un módulo nuevo). CombustiblePanel la monta cuando
// pestanaCombustible === "urea", mismo patrón que HistoricoCliente.tsx.
//
// Tres acciones (los tres actos que confirmó el cliente):
//   - Registrar VALE: la urea sale a una unidad (POST /despachos,
//     producto='urea'). El servidor resuelve el factor de conversión --
//     este formulario solo manda presentación + bultos.
//   - Registrar ENTRADA: llega la compra del proveedor (POST /recepciones,
//     producto='urea'). Sin tanque, sin varilla previa que exigir.
//   - Registrar CONTEO FÍSICO: el reemplazo de la varilla -- lo que queda
//     en almacén, contado a mano (POST /urea/conteos).
//
// El banner de arriba avisa si hace mucho que nadie hace el conteo
// (GET /urea/estado) -- mismo criterio que "el tanque opera ciego" de
// combustible (migración 0082), pero para la urea.
//
// Define sus propios tipos locales, no los importa de CombustiblePanel --
// mismo criterio que HistoricoCliente: este componente no debe depender de
// las ~7000 líneas de al lado.

import {
  BookOpen,
  ClipboardList,
  Download,
  Droplets,
  Package,
  PackagePlus,
  Paperclip,
  Plus,
  Receipt,
  Settings,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "../context/AuthContext";
import { comprimirImagen } from "./combustible/comprimirImagen";
import { EVENTO_UREA_EN_WINDOW, planDeRefresco } from "./combustible/eventosUrea";
import ConsumoPorViaje from "./combustible/ConsumoPorViaje";
import VentanaFlotante from "./comunes/VentanaFlotante";
import { AlmacenUrea, ModalCorregirLitros, ResumenUrea, type EstadoStockUrea } from "./UreaAlmacen";
import { apiFetch } from "../services/apiClient";
import {
  ahoraParaInputLocal,
  estadoRenglones,
  nuevoRenglon,
  precioVigenteUrea,
  presentacionPorDefecto,
  presentacionesActivas,
} from "./ureaCompartido";

/** Los envases ya NO son una constante del cliente (migración 0116): los
 *  litros que trae cada uno son un dato de la empresa y se editan desde
 *  "Configuración de envases". `Presentacion` es el CÓDIGO del envase, un
 *  string libre -- un union cerrado acá volvería a hacer imposible que el
 *  cliente dé de alta un bidón sin un deploy. */
type Presentacion = string;

export interface PresentacionFila {
  id: number;
  codigo: string;
  nombre: string;
  litros: string;
  es_referencia: boolean;
  activa: boolean;
  /** Filas que ya congelaron sus litros: con > 0 los litros no se cambian. */
  movimientos?: number;
  /** Registros de CUALQUIER tabla que apuntan al envase (precios y
   *  correcciones incluidos). Con 0 se puede eliminar; con > 0 solo darlo de
   *  baja. No es `movimientos`: ese decide si los litros se pueden cambiar. */
  usos?: number;
}

/** "Caja (20 L)". El nombre NO lleva los litros escritos adentro (ver el
 *  comentario de la columna en 0116): la etiqueta se arma acá, así cambiar
 *  el factor no deja un texto mintiendo. */
function etiquetaPresentacion(p: PresentacionFila): string {
  return `${p.nombre} (${formatearNumero(p.litros)} L)`;
}

/** Un formulario de carga sin ningún envase activo no puede enviarse: el
 *  servidor rechazaría el movimiento igual (la FK compuesta no tendría
 *  contra qué validar). Decirlo acá, y por qué, es mejor que un desplegable
 *  vacío y un 400 después de llenar todo lo demás. */
export function AvisoSinEnvases() {
  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      No hay ningún envase de urea activo en esta empresa. Dalos de alta en{" "}
      <strong>Urea → Configuración de envases</strong> (o reactivá uno) antes de cargar movimientos.
    </div>
  );
}

/** El desplegable de proveedores vacío necesita decir POR QUÉ (0119). La
 *  causa casi siempre es la misma: el proveedor existe, pero no está marcado
 *  como "abastece urea" -- los de combustible (PRIMAX, etc.) nacen marcados
 *  para ruta o para el tanque. Un desplegable mudo hace pensar que el sistema
 *  perdió los proveedores. */
function AvisoSinProveedores() {
  return (
    <span className="text-xs text-amber-700">
      No hay proveedores marcados para esto. Un admin los marca en Combustible → Proveedores, en las
      columnas <strong>&quot;Urea&quot;</strong> (interno para la planta, externo para compras en
      ruta). El mismo proveedor puede venderte diésel y urea a la vez.
    </span>
  );
}

const COLOR_TIPO_MOVIMIENTO: Record<string, string> = {
  entrada: "bg-emerald-500",
  vale: "bg-[#4f8fdc]",
  conteo: "bg-[#a3e635]",
};

/** El marco de VentanaFlotante es overflow-hidden: el contenido tiene que
 *  traer su propia zona con scroll o lo que no entra se corta y los botones
 *  de abajo (Guardar) quedan inalcanzables. */
function CuerpoVentana({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

function TipoMovimiento({ tipo }: { tipo: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-medium capitalize">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${COLOR_TIPO_MOVIMIENTO[tipo] ?? "bg-slate-400"}`}
      />
      {tipo}
    </span>
  );
}

/** Un renglón de urea tal como lo devuelve la API (0131). */
interface RenglonApi {
  presentacion: string;
  nombre: string | null;
  cantidad_bultos: number;
  factor_litros: string;
  litros: string;
  costo_por_bulto: string | null;
}

/** "1× Caja (20 L) + 2× Bolsa (4 L)": de qué está hecho un vale o una
 *  entrada, con los litros por bulto CONGELADOS en cada renglón (no los del
 *  catálogo de hoy). */
function etiquetaRenglones(renglones: RenglonApi[] | undefined): string {
  return (renglones ?? [])
    .map(
      (r) =>
        `${formatearNumero(String(r.cantidad_bultos), 0)}× ${r.nombre ?? r.presentacion} (${formatearNumero(r.factor_litros)} L)`
    )
    .join(" + ");
}

type Vista =
  | "vales"
  | "compras"
  | "entradas"
  | "conteos"
  | "por_conductor"
  | "por_vehiculo"
  | "por_viaje"
  | "kardex"
  | "precios"
  | "presentaciones";

const VISTAS: { valor: Vista; etiqueta: string }[] = [
  { valor: "vales", etiqueta: "Vales del almacén" },
  { valor: "compras", etiqueta: "Compras en ruta" },
  { valor: "entradas", etiqueta: "Entradas" },
  { valor: "conteos", etiqueta: "Conteos físicos" },
  { valor: "por_conductor", etiqueta: "Por conductor" },
  { valor: "por_vehiculo", etiqueta: "Por vehículo" },
  { valor: "por_viaje", etiqueta: "Por viaje" },
];

/** Fuera de VISTAS: no es una consulta del historial, es la configuración
 *  del catálogo. Se agrega al desplegable solo si el usuario tiene la
 *  pestaña `urea:configuracion` (admin por defecto). */
/** Todas las vistas menos "Conteos" aceptan filtrar por fecha (los mismos
 *  endpoints que ya usa Histórico de combustible, con ?producto=urea) --
 *  sin fechas, cargan el período completo. "Conteos" queda afuera porque
 *  `GET /urea/conteos` todavía no acepta un rango, y "Configuración de
 *  envases" porque es el catálogo vigente, no un histórico. */
const VISTAS_SIN_PERIODO: ReadonlySet<Vista> = new Set(["conteos", "presentaciones", "precios"]);

export interface Equipo {
  id: number;
  placa_codigo: string;
  tipo: string;
  usa_urea: boolean;
  // El conductor asignado en Equipos (0083). El servidor lo COPIA al vale en
  // el momento de registrarlo; el formulario solo lo muestra antes, para que
  // quien carga sepa a quién se le va a asignar.
  conductor_nombre?: string | null;
}

/** "Conductor: Juan Pérez (de Equipos)" debajo de la unidad elegida. Si la
 *  unidad no tiene conductor cargado, se dice: el vale va a quedar sin
 *  conductor, y el ranking por conductor no lo va a contar. */
export function ConductorDeLaUnidad({ equipo }: { equipo: Equipo | undefined }) {
  if (!equipo) return null;
  return equipo.conductor_nombre ? (
    <span className="text-xs text-slate-500">
      Conductor: <strong>{equipo.conductor_nombre}</strong> (de Equipos; se guarda en el vale)
    </span>
  ) : (
    <span className="text-xs text-amber-700">
      Esta unidad no tiene conductor cargado en Equipos: el vale va a quedar sin conductor.
    </span>
  );
}

/** El botón de elegir archivo. El <input type="file"> nativo se ve como texto
 *  plano en el tema oscuro ("Seleccionar archivo Ningún archivo
 *  seleccionado") y no parece un botón -- Kenif no lo vio. */
export function BotonArchivo({
  archivo,
  onElegir,
  texto,
  destacado = false,
}: {
  archivo: File | null;
  onElegir: (archivo: File | undefined) => void;
  texto: string;
  /** Lima, como el resto de los botones de acción del ERP. */
  destacado?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label
        className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium ${
          destacado
            ? "border-[#BADC1E] bg-[#BADC1E] font-semibold text-[#0A1014] hover:brightness-105"
            : "border-slate-300 text-slate-700 hover:bg-slate-50"
        }`}
      >
        <Paperclip className="h-4 w-4 shrink-0" />
        {archivo ? "Cambiar archivo" : texto}
        <input
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          capture="environment"
          onChange={(e) => onElegir(e.target.files?.[0])}
          className="sr-only"
        />
      </label>
      {archivo ? (
        <span className="text-xs text-emerald-700">
          {archivo.name} ({Math.max(1, Math.round(archivo.size / 1024))} kB)
        </span>
      ) : (
        <span className="text-xs text-slate-400">Ningún archivo elegido</span>
      )}
    </div>
  );
}

interface Grifo {
  id: number;
  nombre: string;
  activo: boolean;
  // 0133: interna = la que se recibe en la planta; externa = la que se compra
  // en ruta. El vale de almacén y la entrada usan las internas; la compra en
  // ruta, las externas; los precios, cualquiera de las dos.
  abastece_urea: boolean;
  abastece_urea_ruta: boolean;
}

interface ValeFila {
  id: number;
  // 0119: 'almacen' (vale del talonario, baja el stock) o 'compra_externa'
  // (compra en ruta con boleta/factura, no toca el almacén).
  origen: "almacen" | "compra_externa";
  serie_talonario: string | null;
  n_vale: number | null;
  comprobante_tipo: string | null;
  comprobante_numero: string | null;
  comprobante_subido_en: string | null;
  equipo_id: number | null;
  // De qué está hecho el vale (0131), con los litros por bulto VIGENTES
  // cuando se cargó. La pantalla muestra estos, no los del catálogo de hoy.
  renglones: RenglonApi[];
  cantidad: string;
  costo_total: string;
  conductor_nombre: string | null;
  observaciones: string | null;
  despachado_en: string;
  anulada_en: string | null;
}

interface EntradaFila {
  id: number;
  grifo_nombre: string;
  renglones: RenglonApi[];
  cantidad: string;
  costo_total: string;
  tipo_documento: string | null;
  numero_documento: string | null;
  recibido_en: string;
  anulada_en: string | null;
}

interface ConteoFila {
  id: number;
  cantidad_litros: string;
  contado_en: string;
  registrado_por_nombre: string | null;
  observaciones: string | null;
  anulada_en: string | null;
  motivo_anulacion: string | null;
  /** 0130: qué se contó por envase. Vacío en los conteos de antes. */
  renglones?: RenglonApi[];
  /** 0132: lo que no estaba en un envase entero, ya sumado en cantidad_litros. */
  suelto_litros?: string | null;
}

interface ConductorFila {
  conductor_nombre: string;
  conductor_dni: string | null;
  cantidad_vales: string;
  total_cantidad: string;
  total_costo: string;
  primer_despacho: string;
  ultimo_despacho: string;
}

interface VehiculoFila {
  equipo_id: number;
  placa_codigo: string | null;
  equipo_tipo: string | null;
  cantidad_vales: string;
  total_cantidad: string;
  total_costo: string;
  primer_despacho: string;
  ultimo_despacho: string;
}

interface KardexFila {
  ocurrido_en: string;
  tipo: "entrada" | "vale" | "conteo";
  referencia_id: number;
  documento: string;
  detalle: string;
  entrada: number;
  salida: number;
  /** De qué está hecho el movimiento (0131). */
  renglones: {
    presentacion: string;
    nombre: string;
    bultos: number;
    factor_litros: number;
    litros: number;
  }[];
  saldo_teorico: number | null;
  contado: number | null;
  diferencia: number | null;
  usuario: string;
  anulada: boolean;
  motivo_anulacion: string | null;
}

interface KardexUrea {
  saldo_inicial: number;
  filas: KardexFila[];
  resumen: {
    entradas: number;
    salidas: number;
    saldo_final: number;
    conteos: number;
    anulados: number;
    diferencia_final: number | null;
  };
}

interface HallazgoUrea {
  id: number;
  tipo: string;
  detalle: Record<string, unknown>;
  creado_en: string;
  congelada: boolean;
  vale: string | null;
}

interface HallazgosUrea {
  total: number;
  hallazgos: HallazgoUrea[];
}

interface EstadoUrea {
  sinConteo: { diasSinConteo: number | null; limiteDias: number } | null;
  // 0117: el stock derivado y contra qué se compara. `stockMinimoL` /
  // `stockMaximoL` en null significa "ese control está apagado", NO "el
  // límite es cero" -- la barra lo tiene que distinguir.
  stock: EstadoStockUrea;
}

function formatearFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatearNumero(valor: string, decimales = 1): string {
  const n = Number(valor);
  return Number.isFinite(n)
    ? n.toLocaleString("es-PE", { maximumFractionDigits: decimales })
    : valor;
}

/** Exporta la vista actual a CSV -- mismo mecanismo que HistoricoCliente.tsx
 *  y CombustiblePanel.tsx, duplicado y no importado (no se comparte código
 *  entre hermanos, ver el comentario de VentanaFlotante). NO hay
 *  "Importar Excel" para urea, a diferencia de la carga masiva de tanques:
 *  un vale/entrada/conteo necesita validación del servidor fila por fila
 *  (talonario, factor de conversión, rol del grifo) que un bulk insert no
 *  puede replicar sin reescribir esa lógica del lado del cliente -- mismo
 *  motivo por el que combustible tampoco tiene "importar despachos". */
function exportarCsvUrea(filas: Record<string, unknown>[], nombreArchivo: string) {
  if (filas.length === 0) return;
  const columnas = Object.keys(filas[0]);
  const escapar = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [
    columnas.join(","),
    ...filas.map((f) => columnas.map((c) => escapar(f[c])).join(",")),
  ];
  const blob = new Blob([lineas.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombreArchivo;
  a.click();
  URL.revokeObjectURL(url);
}

/** Baja el kardex en .xlsx. Va por apiFetch + blob y no por un <a href>:
 *  la sesión viaja en cookie y el CSRF/origin guard necesita pasar por el
 *  cliente. El nombre lo manda el servidor en Content-Disposition. */
async function descargarKardexXlsx(query: string) {
  const res = await apiFetch(`/api/erp/combustible/urea/kardex/xlsx?${query}`);
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kardex-urea-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Un precio del catálogo (0121): por proveedor y presentación, apilado con
 *  su vigencia. Los anulados vienen también, para mostrar la historia. */
export interface PrecioUrea {
  id: number;
  grifo_id: number;
  proveedor: string | null;
  presentacion: string;
  presentacion_nombre: string | null;
  presentacion_litros: string | null;
  marca: string | null;
  precio_por_bulto: string;
  vigente_desde: string;
  cargado_por: string | null;
  anulada_en: string | null;
  motivo_anulacion: string | null;
}

/** "Catálogo: S/ 50,00 (Green 32)" y, si el precio tipeado difiere, cuánto.
 *  No dice si va a alertar: eso depende de la tolerancia configurada, y la
 *  decide el servidor. */
function PistaPrecioCatalogo({
  vigente,
  precioTipeado,
}: {
  vigente: PrecioUrea | null;
  precioTipeado: string;
}) {
  if (!vigente) return null;
  const catalogo = Number(vigente.precio_por_bulto);
  const tipeado = Number(precioTipeado);
  const desvio =
    precioTipeado && tipeado > 0 && tipeado !== catalogo
      ? ((tipeado - catalogo) / catalogo) * 100
      : null;
  return (
    <span className="text-xs text-slate-500">
      Catálogo: S/ {formatearNumero(vigente.precio_por_bulto, 2)}
      {vigente.marca && <> ({vigente.marca})</>}
      {desvio !== null && (
        <span className="ml-1 font-semibold text-amber-700">
          · {desvio > 0 ? "+" : ""}
          {formatearNumero(String(desvio), 1)}% del catálogo
        </span>
      )}
    </span>
  );
}

interface CompraUreaFila {
  id: number;
  despachado_en: string;
  comprobante_tipo: string;
  comprobante_numero: string;
  comprobante_nombre: string | null;
  comprobante_subido_en: string | null;
  cantidad: string;
  costo_total: string;
  conductor_nombre: string | null;
  observaciones: string | null;
  anulada_en: string | null;
  motivo_anulacion: string | null;
  proveedor: string | null;
  placa_codigo: string | null;
  equipo_tipo: string | null;
  registrado_por: string | null;
  lineas: {
    presentacion: string;
    nombre: string | null;
    factor_litros: string;
    cantidad_bultos: number;
    litros: string;
    costo_por_bulto: string;
  }[];
}

/** HISTORIAL DE COMPRAS EN RUTA (0120) -- el calco del "Historial de compras
 *  externas" de combustible: el comprobante con su foto, de qué estuvo hecha
 *  la compra, y las dos acciones correctivas.
 *
 *  REEMPLAZAR el comprobante (foto equivocada, la de otra boleta) pide motivo
 *  y queda en la bitácora: cambiar el respaldo de una compra ya registrada es
 *  justo lo que haría quien quiere taparla. ADJUNTAR, cuando no tenía foto, no
 *  lo pide -- es terminar de registrarla.
 *
 *  ANULAR, solo admin y operador (la ruta lo exige): mismo reparto que en
 *  combustible, el que compra no anula sus compras. */
function TablaComprasUrea({
  filas,
  puedeAnular,
  puedeReemplazar,
  onCambio,
}: {
  filas: CompraUreaFila[];
  puedeAnular: boolean;
  puedeReemplazar: boolean;
  onCambio: () => void;
}) {
  const [anulando, setAnulando] = useState<CompraUreaFila | null>(null);
  const [reemplazando, setReemplazando] = useState<CompraUreaFila | null>(null);
  if (filas.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500">
        Todavía no hay compras de urea en ruta en este período.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-2">Comprobante</th>
            <th className="text-left px-4 py-2">Fecha</th>
            <th className="text-left px-4 py-2">Proveedor</th>
            <th className="text-left px-4 py-2">Unidad</th>
            <th className="text-left px-4 py-2">Qué se compró</th>
            <th className="text-right px-4 py-2">Litros</th>
            <th className="text-right px-4 py-2">Total</th>
            <th className="text-left px-4 py-2">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas.map((f) => (
            <tr key={f.id} className={f.anulada_en ? "opacity-50" : ""}>
              <td className="px-4 py-2">
                <div className="font-mono text-xs capitalize">
                  {f.comprobante_tipo} {f.comprobante_numero}
                </div>
                {f.comprobante_subido_en ? (
                  <button
                    type="button"
                    onClick={() => verComprobanteUrea(f.id)}
                    className="text-xs text-sky-600 underline hover:text-sky-800"
                  >
                    Ver comprobante
                  </button>
                ) : (
                  <span className="text-xs font-semibold text-red-600">sin foto</span>
                )}
              </td>
              <td className="px-4 py-2 whitespace-nowrap">{formatearFecha(f.despachado_en)}</td>
              <td className="px-4 py-2">{f.proveedor ?? "—"}</td>
              <td className="px-4 py-2">
                {f.placa_codigo ?? "—"}
                {f.conductor_nombre && (
                  <span className="block text-xs text-slate-500">{f.conductor_nombre}</span>
                )}
              </td>
              <td className="px-4 py-2">
                {f.lineas.map((l) => (
                  <div key={l.presentacion} className="text-xs">
                    {l.cantidad_bultos}× {l.nombre ?? l.presentacion} (
                    {formatearNumero(l.factor_litros)} L) a S/{" "}
                    {formatearNumero(l.costo_por_bulto, 2)}
                  </div>
                ))}
              </td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.cantidad)} L</td>
              <td className="px-4 py-2 text-right">S/ {formatearNumero(f.costo_total, 2)}</td>
              <td className="px-4 py-2 whitespace-nowrap">
                {f.anulada_en ? (
                  <span className="text-xs text-red-500" title={f.motivo_anulacion ?? undefined}>
                    anulada
                  </span>
                ) : (
                  <div className="flex gap-3 text-xs">
                    {puedeReemplazar && (
                      <button
                        type="button"
                        onClick={() => setReemplazando(f)}
                        className="text-sky-600 hover:text-sky-800"
                      >
                        {f.comprobante_subido_en ? "Reemplazar" : "Adjuntar"}
                      </button>
                    )}
                    {puedeAnular && (
                      <button
                        type="button"
                        onClick={() => setAnulando(f)}
                        className="text-red-500 hover:text-red-700"
                      >
                        Anular
                      </button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {anulando && (
        <ModalAnular
          titulo={`Anular la compra (${anulando.comprobante_tipo} ${anulando.comprobante_numero})`}
          onCerrar={() => setAnulando(null)}
          onConfirmar={async (motivo) => {
            await apiFetch(`/api/erp/combustible/despachos/${anulando.id}/anular`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ motivo }),
            });
            setAnulando(null);
            onCambio();
          }}
        />
      )}
      {reemplazando && (
        <ModalReemplazarComprobante
          compra={reemplazando}
          onCerrar={() => setReemplazando(null)}
          onHecho={() => {
            setReemplazando(null);
            onCambio();
          }}
        />
      )}
    </div>
  );
}

/** Adjuntar (si no tenía) o reemplazar (con motivo) la foto de una compra
 *  ya registrada. Va por id y online: la compra ya existe en el servidor. */
function ModalReemplazarComprobante({
  compra,
  onCerrar,
  onHecho,
}: {
  compra: CompraUreaFila;
  onCerrar: () => void;
  onHecho: () => void;
}) {
  const esReemplazo = compra.comprobante_subido_en !== null;
  const [archivo, setArchivo] = useState<File | null>(null);
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const elegir = async (a: File | undefined) => {
    setError(null);
    if (!a) return setArchivo(null);
    if (!["image/jpeg", "image/png", "application/pdf"].includes(a.type)) {
      setError("Solo se acepta foto (JPG/PNG) o PDF.");
      return setArchivo(null);
    }
    const lista = await comprimirImagen(a);
    if (lista.size > 6 * 1024 * 1024) {
      setError("El archivo supera el máximo de 6 MB.");
      return setArchivo(null);
    }
    setArchivo(lista);
  };

  const enviar = async () => {
    if (!archivo) return;
    setEnviando(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("archivo", archivo);
      if (esReemplazo) fd.append("motivo", motivo.trim());
      const res = await apiFetch(`/api/erp/combustible/urea/compras/${compra.id}/comprobante`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo subir el comprobante.");
        return;
      }
      onHecho();
    } catch {
      setError("Sin conexión: intentalo cuando vuelva la señal.");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">
          {esReemplazo ? "Reemplazar comprobante" : "Adjuntar comprobante"}
        </h3>
        <p className="-mt-2 text-sm text-slate-500">
          <span className="capitalize">{compra.comprobante_tipo}</span> {compra.comprobante_numero}
          {compra.proveedor && <> · {compra.proveedor}</>}
          {esReemplazo && (
            <>
              . Reemplazar el respaldo de una compra ya registrada pide un motivo y queda en la
              bitácora con tu nombre.
            </>
          )}
        </p>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}
        <BotonArchivo archivo={archivo} onElegir={elegir} texto="Elegir foto o PDF" />
        {esReemplazo && (
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Motivo del reemplazo</span>
            <input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="La foto anterior era de otra boleta"
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!archivo || (esReemplazo && !motivo.trim()) || enviando}
            onClick={enviar}
            className="px-4 py-2 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d] rounded-xl text-sm font-semibold disabled:cursor-not-allowed"
          >
            {enviando ? "Subiendo…" : esReemplazo ? "Reemplazar" : "Adjuntar"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

/** Abre la foto o el PDF del comprobante de una compra de urea en ruta. Por
 *  apiFetch + blob y no por un <a href>: la descarga pasa por los permisos
 *  (urea:vista) y la sesión viaja en cookie. Si el storage responde con un
 *  redirect (S3), el navegador lo sigue solo. */
async function verComprobanteUrea(despachoId: number) {
  const res = await apiFetch(`/api/erp/combustible/urea/compras/${despachoId}/comprobante`);
  if (!res.ok) {
    alert("No se pudo abrir el comprobante.");
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** El kardex con su propio período, dentro del panel flotante. Sin fechas,
 *  los últimos 30 días -- y lo dice. */
function PanelKardexUrea({ puedeExportar, clave }: { puedeExportar: boolean; clave: number }) {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  // Lo que está en pantalla se pidió con ESTE período, no con lo que hay
  // escrito en los campos: un refresco en vivo no debe aplicar fechas que la
  // persona todavía no consultó. Cambia solo con "Consultar".
  const [aplicado, setAplicado] = useState({ desde: "", hasta: "" });
  const [kardex, setKardex] = useState<KardexUrea | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const periodo = (p: { desde: string; hasta: string }) => {
    const fin = p.hasta ? new Date(`${p.hasta}T23:59:59.999`) : new Date();
    const ini = p.desde ? new Date(`${p.desde}T00:00:00`) : new Date(fin.getTime() - 30 * 86400000);
    return new URLSearchParams({ desde: ini.toISOString(), hasta: fin.toISOString() }).toString();
  };

  /** `silencioso` es el refresco en vivo: sin spinner, y si falla se deja lo
   *  que ya había en pantalla en vez de vaciarlo. */
  // Solo la última petición pinta: con el refresco en vivo, un "Consultar"
  // y un evento pueden cruzarse, y la respuesta que llega tarde no debe pisar
  // a la más nueva.
  const ultimaPeticion = useRef(0);
  const cargar = useCallback(
    async (silencioso = false, p = aplicado) => {
      const n = ++ultimaPeticion.current;
      const vigente = () => n === ultimaPeticion.current;
      if (!silencioso) {
        setCargando(true);
        setError(null);
      }
      try {
        const res = await apiFetch(`/api/erp/combustible/urea/kardex?${periodo(p)}`);
        if (silencioso && !res.ok) return;
        const body = await res.json().catch(() => null);
        if (!vigente()) return;
        setKardex(res.ok ? body : null);
        // Éxito limpia el aviso: el refresco en vivo no lo limpia al empezar.
        setError(res.ok ? null : (body?.error ?? "No se pudo cargar el kardex."));
      } catch {
        if (!silencioso && vigente()) setError("No se pudo cargar el kardex.");
      } finally {
        // La vigente apaga el spinner, sea silenciosa o no: si un refresco en
        // vivo dejó vieja a una carga con spinner, nadie más lo apagaría.
        if (vigente()) setCargando(false);
      }
    },
    [aplicado]
  );

  const primeraCarga = useRef(true);
  useEffect(() => {
    // Carga inicial al abrir (últimos 30 días) y, después, un refresco
    // silencioso cada vez que `clave` sube (un evento en vivo). Las fechas se
    // aplican con "Consultar".
    const silencioso = !primeraCarga.current;
    primeraCarga.current = false;
    cargar(silencioso);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-4">
        <label className="flex flex-col text-sm">
          <span className="text-gray-600">Desde</span>
          <input
            type="date"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-gray-600">Hasta</span>
          <input
            type="date"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            const escrito = { desde, hasta };
            setAplicado(escrito);
            cargar(false, escrito);
          }}
          disabled={cargando}
          className="px-4 py-2 bg-slate-900 text-white text-sm font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50"
        >
          {cargando ? "Cargando…" : "Consultar"}
        </button>
        {puedeExportar && (
          <button
            type="button"
            onClick={() => descargarKardexXlsx(periodo(aplicado))}
            disabled={(kardex?.filas.length ?? 0) === 0}
            className="ml-auto flex items-center gap-2 px-4 py-2 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl text-sm disabled:opacity-40"
            title="Descargar el kardex en Excel (.xlsx)"
          >
            <Download className="w-4 h-4 shrink-0" />
            Excel
          </button>
        )}
      </div>
      {error && <div className="p-4 text-sm text-red-600">{error}</div>}
      {!cargando && <TablaKardex kardex={kardex} sinFechas={!aplicado.desde && !aplicado.hasta} />}
    </div>
  );
}

/** El panel a primera vista: los últimos movimientos del ALMACÉN (entradas,
 *  vales, conteos) con su saldo, como la tabla de Tanques. Lo más reciente
 *  arriba. El kardex completo, con período y Excel, está en "Kardex". */
function MovimientosRecientes({ clave, onVerKardex }: { clave: number; onVerKardex: () => void }) {
  const [filas, setFilas] = useState<KardexFila[]>([]);

  useEffect(() => {
    let vigente = true;
    const fin = new Date();
    const ini = new Date(fin.getTime() - 30 * 86400000);
    const q = new URLSearchParams({ desde: ini.toISOString(), hasta: fin.toISOString() });
    apiFetch(`/api/erp/combustible/urea/kardex?${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: KardexUrea | null) => {
        // Si el pedido falla se deja lo que ya había: este panel se vuelve a
        // pedir con cada evento en vivo y un 5xx pasajero no debe vaciarlo.
        if (vigente && body) setFilas([...body.filas].reverse().slice(0, 10));
      })
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, [clave]);

  const n = (v: number | null) =>
    v === null ? "" : v.toLocaleString("es-PE", { maximumFractionDigits: 2 });

  return (
    <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-slate-800">Movimientos del almacén</div>
          <div className="text-xs text-slate-500">Últimos 30 días, lo más reciente arriba</div>
        </div>
        <button
          type="button"
          onClick={onVerKardex}
          className="text-xs font-semibold text-slate-600 underline hover:text-white"
        >
          Ver kardex completo
        </button>
      </div>
      {filas.length === 0 ? (
        <div className="p-6 text-sm text-slate-500">
          Sin movimientos en el almacén en los últimos 30 días.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2">Fecha</th>
                <th className="text-left px-4 py-2">Movimiento</th>
                <th className="text-left px-4 py-2">Documento</th>
                <th className="text-left px-4 py-2">Detalle</th>
                <th className="text-right px-4 py-2">Entrada (L)</th>
                <th className="text-right px-4 py-2">Salida (L)</th>
                <th className="text-right px-4 py-2">Saldo (L)</th>
                <th className="text-right px-4 py-2">Contado (L)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filas.map((f) => (
                <tr key={`${f.tipo}-${f.referencia_id}`} className={f.anulada ? "opacity-50" : ""}>
                  <td className="px-4 py-2 whitespace-nowrap">{formatearFecha(f.ocurrido_en)}</td>
                  <td className="px-4 py-2">
                    <TipoMovimiento tipo={f.tipo} />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{f.documento}</td>
                  <td className="px-4 py-2">{f.detalle}</td>
                  <td className="px-4 py-2 text-right">{f.entrada ? n(f.entrada) : ""}</td>
                  <td className="px-4 py-2 text-right">{f.salida ? n(f.salida) : ""}</td>
                  <td className="px-4 py-2 text-right">{n(f.saldo_teorico)}</td>
                  <td className="px-4 py-2 text-right">{n(f.contado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TablaKardex({ kardex, sinFechas }: { kardex: KardexUrea | null; sinFechas: boolean }) {
  if (!kardex) return null;
  const n = (v: number | null) =>
    v === null ? "" : v.toLocaleString("es-PE", { maximumFractionDigits: 2 });
  return (
    <div>
      {sinFechas && (
        <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-2 text-xs text-slate-500">
          Sin fechas elegidas se muestran los últimos 30 días.
        </div>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-slate-100 px-4 py-3 text-xs text-slate-600">
        <span>Saldo inicial: {n(kardex.saldo_inicial)} L</span>
        <span>Entradas: {n(kardex.resumen.entradas)} L</span>
        <span>Salidas: {n(kardex.resumen.salidas)} L</span>
        <span className="font-semibold">Saldo final: {n(kardex.resumen.saldo_final)} L</span>
        <span>
          Último conteo:{" "}
          {kardex.resumen.diferencia_final === null
            ? "no hubo conteo en el período"
            : `diferencia ${n(kardex.resumen.diferencia_final)} L`}
        </span>
      </div>
      {kardex.filas.length === 0 ? (
        <div className="p-6 text-sm text-slate-500">No hubo movimientos en este período.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2">Fecha</th>
                <th className="text-left px-4 py-2">Movimiento</th>
                <th className="text-left px-4 py-2">Documento</th>
                <th className="text-left px-4 py-2">Detalle</th>
                <th className="text-right px-4 py-2">Entrada (L)</th>
                <th className="text-right px-4 py-2">Salida (L)</th>
                <th className="text-right px-4 py-2">Saldo (L)</th>
                <th className="text-right px-4 py-2">Contado (L)</th>
                <th className="text-right px-4 py-2">Diferencia (L)</th>
                <th className="text-left px-4 py-2">Quién</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {kardex.filas.map((f) => (
                <tr key={`${f.tipo}-${f.referencia_id}`} className={f.anulada ? "opacity-50" : ""}>
                  <td className="px-4 py-2 whitespace-nowrap">{formatearFecha(f.ocurrido_en)}</td>
                  <td className="px-4 py-2">
                    <TipoMovimiento tipo={f.tipo} />
                  </td>
                  <td className="px-4 py-2">{f.documento}</td>
                  <td className="px-4 py-2">
                    {f.detalle}
                    {f.renglones.length > 0 && (
                      <span className="block text-xs text-slate-400">
                        {f.renglones
                          .map((r) => `${n(r.bultos)} × ${r.nombre} (${n(r.factor_litros)} L)`)
                          .join(" + ")}
                      </span>
                    )}
                    {f.anulada && (
                      <span className="block text-xs text-red-600">
                        Anulado: {f.motivo_anulacion}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">{f.entrada ? n(f.entrada) : ""}</td>
                  <td className="px-4 py-2 text-right">{f.salida ? n(f.salida) : ""}</td>
                  <td className="px-4 py-2 text-right">{n(f.saldo_teorico)}</td>
                  <td className="px-4 py-2 text-right">{n(f.contado)}</td>
                  <td
                    className={`px-4 py-2 text-right ${f.diferencia ? "font-semibold text-amber-700" : ""}`}
                  >
                    {n(f.diferencia)}
                  </td>
                  <td className="px-4 py-2">{f.usuario}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function UreaPanel() {
  const { usuario } = useAuth();
  const esAdmin = usuario?.rol === "admin";
  // Operador parte con acceso amplio (matriz robusta de perfiles,
  // profile_user.xlsx): la empresa recorta desde Administración →
  // Configuración.
  const permiteUrea = (id: string) => {
    const clave = `combustible:urea:${id}`;
    const override = usuario?.permisosPestanas?.[clave];
    if (override !== undefined) return override;
    if (esAdmin || usuario?.rol === "encargado_urea") return true;
    if (usuario?.rol === "operador") return true;
    // Lectura (matriz robusta, actualizada 2026-10-01): nada de "Registrar
    // X" -- solo Vista y Exportar siguen siendo "Solo consulta".
    if (usuario?.rol === "lectura") return id === "vista" || id === "exportar" || id === "kardex";
    // El conductor (0119): la compra en ruta y su historial (para subir la
    // foto después), igual que en combustible.
    if (usuario?.rol === "conductor_ruta") {
      return id === "registrar_compra" || id === "historial_compras";
    }
    return false;
  };
  const puedeVerUrea = permiteUrea("vista");
  // Quien tiene solo el historial de compras en ruta (el conductor) ve esa
  // pestaña y nada más del panel: ni stock, ni conteos, ni los otros listados.
  const soloHistorialCompras = !puedeVerUrea && permiteUrea("historial_compras");
  const puedeVerHistorial = puedeVerUrea || soloHistorialCompras;
  // Configurar el catálogo es admin, igual que la config de combustible
  // (requireRole("admin") en las rutas de 0116): cambiar los litros de un
  // envase mueve el stock teórico de todo lo que se cargue después.
  const puedeConfigurar = esAdmin && permiteUrea("configuracion");
  // El selector "Vista" es SOLO historial y rankings, con su filtro de fechas
  // (pedido de Kenif, 2026-10-05: "vista solo es para histórico"). El kardex,
  // los precios y la configuración son herramientas: botones arriba, en panel
  // flotante, igual que "Precios" o "Historial de compras" en Tanques.
  const vistasVisibles = puedeVerUrea
    ? VISTAS
    : soloHistorialCompras
      ? VISTAS.filter((v) => v.valor === "compras")
      : [];
  const puedeVerKardex = permiteUrea("kardex");
  // Corregir los litros de un envase con historial (0130): SOLO con el check
  // explícito. Nace apagado para todos, admin incluido -- ni el rol ni el
  // default lo dan (ver NACEN_APAGADAS en permisosPestanas.service.ts).
  const puedeCorregirLitros =
    usuario?.permisosPestanas?.["combustible:urea:corregir_litros"] === true &&
    (esAdmin || usuario?.rol === "operador" || usuario?.rol === "encargado_urea");
  const [panelAbierto, setPanelAbierto] = useState<null | "kardex" | "envases" | "configuracion">(
    null
  );
  const [vista, setVista] = useState<Vista>(soloHistorialCompras ? "compras" : "vales");
  const [periodoViaje, setPeriodoViaje] = useState({ desde: "", hasta: "", n: 0 });
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  // El período con el que se pidió lo que se ve; ver PanelKardexUrea. Lo
  // escrito en los campos (`desde`/`hasta`) solo pasa a ser este con
  // "Consultar" o al cambiar de vista.
  const [aplicado, setAplicado] = useState({ desde: "", hasta: "" });
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [grifos, setGrifos] = useState<Grifo[]>([]);
  const [estado, setEstado] = useState<EstadoUrea | null>(null);
  const [presentaciones, setPresentaciones] = useState<PresentacionFila[]>([]);
  const [precios, setPrecios] = useState<PrecioUrea[]>([]);

  const [vales, setVales] = useState<ValeFila[]>([]);
  const [entradas, setEntradas] = useState<EntradaFila[]>([]);
  const [conteos, setConteos] = useState<ConteoFila[]>([]);
  const [porConductor, setPorConductor] = useState<ConductorFila[]>([]);
  const [porVehiculo, setPorVehiculo] = useState<VehiculoFila[]>([]);
  // Sube en cada recarga: el panel de movimientos recientes la usa para
  // volver a pedir sus datos después de un vale, una entrada o un conteo.
  const [recargas, setRecargas] = useState(0);
  const [compras, setCompras] = useState<CompraUreaFila[]>([]);
  const [hallazgos, setHallazgos] = useState<HallazgosUrea | null>(null);

  const [modalVale, setModalVale] = useState(false);
  const [modalEntrada, setModalEntrada] = useState(false);
  const [modalConteo, setModalConteo] = useState(false);
  const [modalCompra, setModalCompra] = useState(false);
  // El resultado de la compra en ruta: puede haber quedado en la cola del
  // dispositivo (sin señal), y el conductor tiene que saberlo.
  const [mensajeCompra, setMensajeCompra] = useState<string | null>(null);

  const cargarEquipos = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible/equipos-destino?pageSize=200");
    const body = await res.json().catch(() => null);
    setEquipos(Array.isArray(body?.data) ? body.data : []);
  }, []);

  // Los proveedores marcados para urea, desde su endpoint propio (0119). Antes
  // se pedía GET /grifos, que exige "tanques:proveedores": el encargado de
  // urea y el conductor recibían 403 y el desplegable salía vacío SIEMPRE,
  // aunque hubiera proveedores marcados. El servidor igual vuelve a validar
  // el rol del grifo (validarRolGrifo, "urea").
  const cargarGrifos = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible/urea/proveedores");
    const data = await res.json().catch(() => null);
    setGrifos(
      Array.isArray(data)
        ? data.map(
            (g: {
              id: number;
              nombre: string;
              abastece_urea: boolean;
              abastece_urea_ruta: boolean;
            }) => ({ ...g, activo: true })
          )
        : []
    );
  }, []);

  // Visibilidad de gerencia, como las alertas de combustible: admin y
  // operador. El encargado de urea no ve la franja -- son las alertas sobre su
  // propio trabajo (ver urea:hallazgos en permisosPestanas.service.ts).
  const puedeVerHallazgos = (esAdmin || usuario?.rol === "operador") && permiteUrea("hallazgos");

  // Las cuatro funciones de abajo (hallazgos, precios, estado, envases) tienen
  // dos modos. Normal: lo de siempre, un error deja la pantalla vacía. En vivo
  // (`silencioso`, un evento del stream): un 5xx pasajero o un corte de red
  // NO toca lo que ya está en pantalla -- vaciar el estado desmontaría el
  // almacén y, con él, el modal de corregir litros que alguien esté llenando.
  const cargarHallazgos = useCallback(async (silencioso = false) => {
    try {
      const res = await apiFetch("/api/erp/combustible/urea/hallazgos");
      if (silencioso && !res.ok) return;
      setHallazgos(res.ok ? ((await res.json()) as HallazgosUrea) : null);
    } catch (err) {
      if (!silencioso) throw err;
    }
  }, []);

  const cargarPrecios = useCallback(async (silencioso = false) => {
    try {
      const res = await apiFetch("/api/erp/combustible/urea/precios");
      if (silencioso && !res.ok) return;
      const body = await res.json().catch(() => null);
      setPrecios(Array.isArray(body) ? body : []);
    } catch (err) {
      if (!silencioso) throw err;
    }
  }, []);

  const cargarEstado = useCallback(async (silencioso = false) => {
    try {
      const res = await apiFetch("/api/erp/combustible/urea/estado");
      if (silencioso && !res.ok) return;
      const body = await res.json().catch(() => null);
      setEstado(body ?? null);
    } catch (err) {
      if (!silencioso) throw err;
    }
  }, []);

  /** El catálogo COMPLETO, activas e inactivas: las tablas de historial
   *  necesitan el nombre de un envase que ya se dio de baja, y la pantalla
   *  de configuración tiene que poder reactivarlo. Los desplegables de
   *  carga filtran `activa` por su cuenta. */
  const cargarPresentaciones = useCallback(async (silencioso = false) => {
    try {
      const res = await apiFetch("/api/erp/combustible/urea/presentaciones");
      if (silencioso && !res.ok) return;
      const body = await res.json().catch(() => null);
      setPresentaciones(Array.isArray(body) ? body : []);
    } catch (err) {
      if (!silencioso) throw err;
    }
  }, []);

  /** Arma el query string con el período, mismo criterio que
   *  HistoricoCliente.tsx: sin fecha puesta, no manda el parámetro (el
   *  backend interpreta "todo el rango"). */
  const paramsDePeriodo = useCallback(
    (extra: Record<string, string>, p = aplicado) => {
      const params = new URLSearchParams(extra);
      if (p.desde) params.set("desde", new Date(`${p.desde}T00:00:00`).toISOString());
      if (p.hasta) params.set("hasta", new Date(`${p.hasta}T23:59:59.999`).toISOString());
      return params;
    },
    [aplicado]
  );

  const ultimaPeticionVista = useRef(0);
  const cargarVista = useCallback(
    async (v: Vista, silencioso = false, p = aplicado) => {
      // `silencioso` es el refresco en vivo (un evento del stream): sin
      // spinner -- que escondería la tabla -- y, si falla, se deja lo que ya
      // estaba en pantalla en vez de vaciarlo.
      // Los catálogos no se cargan por acá: los traen cargarPresentaciones()
      // y cargarPrecios() al montar y después de cada guardado.
      if (v === "presentaciones" || v === "precios") return;
      // La vista por viaje trae sus datos sola con el período aplicado.
      if (v === "por_viaje") {
        const q = paramsDePeriodo({}, p);
        setPeriodoViaje((p) => ({
          desde: q.get("desde") ?? "",
          hasta: q.get("hasta") ?? "",
          n: p.n + 1,
        }));
        return;
      }
      // Solo la última petición pinta (mismo criterio que el kardex): un
      // refresco en vivo, un "Consultar" o un cambio de vista pueden cruzarse.
      const n = ++ultimaPeticionVista.current;
      const vigente = () => n === ultimaPeticionVista.current;
      if (!silencioso) {
        setCargando(true);
        setError(null);
      }
      try {
        if (v === "vales") {
          // Solo el almacén: las compras en ruta tienen su propia vista, con
          // los renglones y el comprobante (0120).
          const q = paramsDePeriodo({ producto: "urea", origen: "almacen", pageSize: "200" }, p);
          const res = await apiFetch(`/api/erp/combustible/despachos?${q}`);
          if (silencioso && !res.ok) return;
          const body = await res.json().catch(() => null);
          if (!vigente()) return;
          setVales(Array.isArray(body?.data) ? body.data : []);
        } else if (v === "entradas") {
          const q = paramsDePeriodo({ producto: "urea", pageSize: "200" }, p);
          const res = await apiFetch(`/api/erp/combustible/recepciones?${q}`);
          if (silencioso && !res.ok) return;
          const body = await res.json().catch(() => null);
          if (!vigente()) return;
          setEntradas(Array.isArray(body?.data) ? body.data : []);
        } else if (v === "por_conductor") {
          const q = paramsDePeriodo({ producto: "urea" }, p);
          const res = await apiFetch(`/api/erp/combustible/consumo-por-conductor?${q}`);
          if (silencioso && !res.ok) return;
          const body = await res.json().catch(() => null);
          if (!vigente()) return;
          setPorConductor(Array.isArray(body?.data) ? body.data : []);
        } else if (v === "compras") {
          const res = await apiFetch(`/api/erp/combustible/urea/compras?${paramsDePeriodo({}, p)}`);
          if (silencioso && !res.ok) return;
          const body = await res.json().catch(() => null);
          if (!vigente()) return;
          setCompras(Array.isArray(body) ? body : []);
        } else if (v === "por_vehiculo") {
          const q = paramsDePeriodo({ producto: "urea" }, p);
          const res = await apiFetch(`/api/erp/combustible/consumo-por-vehiculo?${q}`);
          if (silencioso && !res.ok) return;
          const body = await res.json().catch(() => null);
          if (!vigente()) return;
          setPorVehiculo(Array.isArray(body?.data) ? body.data : []);
        } else {
          const res = await apiFetch("/api/erp/combustible/urea/conteos?pageSize=200");
          if (silencioso && !res.ok) return;
          const body = await res.json().catch(() => null);
          if (!vigente()) return;
          setConteos(Array.isArray(body?.data) ? body.data : []);
        }
        // Llegó a pintar: un aviso de error anterior ya no describe lo que se
        // ve. Importa en el refresco en vivo, que no limpia el error al empezar.
        if (vigente()) setError(null);
      } catch {
        if (!silencioso && vigente()) setError("No se pudo cargar la información.");
      } finally {
        // La vigente apaga el spinner, sea silenciosa o no (ver el kardex).
        if (vigente()) setCargando(false);
      }
    },
    [paramsDePeriodo, aplicado]
  );

  useEffect(() => {
    // Patrón estándar de carga al montar -- ver IpercView.tsx /
    // CombustiblePanel.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarEquipos();
    cargarGrifos();
    // Sin condición de pestaña: los tres formularios lo necesitan para
    // llenar su desplegable, y el GET lo deja pasar cualquiera que tenga
    // algo de Urea (ver el comentario de la ruta).
    cargarPresentaciones();
    // El catálogo de precios (0121), por la misma razón: la compra y la
    // entrada autocompletan el precio desde acá.
    cargarPrecios();
    if (puedeVerUrea) cargarEstado();
    if (puedeVerHallazgos) cargarHallazgos();
  }, [
    cargarEquipos,
    cargarGrifos,
    cargarEstado,
    cargarPresentaciones,
    cargarPrecios,
    cargarHallazgos,
    puedeVerUrea,
    puedeVerHallazgos,
  ]);

  useEffect(() => {
    // Cambiar de vista aplica lo que haya escrito en las fechas, como antes.
    const escrito = { desde, hasta };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAplicado(escrito);
    if (puedeVerHistorial) cargarVista(vista, false, escrito);
    // Solo al cambiar de VISTA, no en cada tecla de las fechas -- esas se
    // aplican con el botón "Consultar" (mismo criterio que
    // HistoricoCliente.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vista, puedeVerHistorial]);

  const recargarTodo = useCallback(() => {
    setRecargas((n) => n + 1);
    if (puedeVerHallazgos) cargarHallazgos();
    if (!puedeVerHistorial) return;
    cargarVista(vista);
    if (puedeVerUrea) cargarEstado();
  }, [
    vista,
    cargarVista,
    cargarEstado,
    cargarHallazgos,
    puedeVerUrea,
    puedeVerHistorial,
    puedeVerHallazgos,
  ]);

  // ── En vivo: CombustiblePanel reenvía por window lo que el stream avisa de
  // urea (ver eventosUrea.ts). Se juntan los avisos de 300 ms en un solo
  // refresco, sin spinner, y solo de listas: los modales abiertos no se
  // tocan, para no pisar lo que alguien está escribiendo. ──
  const aplicarCambioEnVivo = (tipos: Set<string>) => {
    const plan = planDeRefresco(tipos);
    if (plan.presentaciones) cargarPresentaciones(true);
    if (plan.precios) cargarPrecios(true);
    if (plan.hallazgos && puedeVerHallazgos) cargarHallazgos(true);
    if (plan.estado && puedeVerUrea) cargarEstado(true);
    if (plan.vista) {
      setRecargas((n) => n + 1);
      if (puedeVerHistorial) cargarVista(vista, true);
    }
  };
  const aplicarCambioEnVivoRef = useRef(aplicarCambioEnVivo);
  useEffect(() => {
    aplicarCambioEnVivoRef.current = aplicarCambioEnVivo;
  });
  useEffect(() => {
    const pendientes = new Set<string>();
    let temporizador: number | undefined;
    const alAvisar = (e: Event) => {
      pendientes.add((e as CustomEvent<{ tipo: string }>).detail.tipo);
      if (temporizador !== undefined) window.clearTimeout(temporizador);
      temporizador = window.setTimeout(() => {
        const tipos = new Set(pendientes);
        pendientes.clear();
        aplicarCambioEnVivoRef.current(tipos);
      }, 300);
    };
    window.addEventListener(EVENTO_UREA_EN_WINDOW, alAvisar);
    return () => {
      window.removeEventListener(EVENTO_UREA_EN_WINDOW, alAvisar);
      if (temporizador !== undefined) window.clearTimeout(temporizador);
    };
  }, []);

  const botonAccion =
    "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all active:scale-95 bg-[#192526] text-white hover:bg-[#0D1719] border border-[#2a2e37] hover:border-[#a3e635]";
  const botonHerramienta =
    "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all active:scale-95 bg-[#192526] text-slate-500 hover:bg-[#1e2128] border border-[#2a2e37]";
  const hayRegistrar =
    permiteUrea("registrar_vale") ||
    permiteUrea("registrar_compra") ||
    permiteUrea("registrar_entrada") ||
    permiteUrea("registrar_conteo_fisico");
  const hayHerramientas = puedeVerKardex || puedeConfigurar;
  const etiquetaGrupo = "text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500";

  return (
    <div className="flex flex-col gap-4">
      {/* ── Encabezado y barra de acciones: lo que se REGISTRA a la izquierda,
          lo que se CONSULTA y se CONFIGURA a la derecha. ── */}
      <div>
        <h1 className="text-lg sm:text-xl lg:text-2xl font-extrabold text-white tracking-tight">
          Control de Urea
        </h1>
        <p className="text-xs sm:text-sm text-[#94a3b8]">
          Almacén, compras en ruta y consumo por unidad
        </p>
      </div>

      {(hayRegistrar || hayHerramientas) && (
        <div className="flex flex-wrap items-end justify-between gap-x-7 gap-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          {hayRegistrar && (
            <div className="flex min-w-0 flex-col gap-2">
              <span className={etiquetaGrupo}>Registrar</span>
              <div className="flex flex-wrap gap-2">
                {permiteUrea("registrar_vale") && (
                  <button
                    type="button"
                    onClick={() => setModalVale(true)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all active:scale-95 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d]"
                  >
                    <Droplets className="w-4 h-4 shrink-0" />
                    Vale del almacén
                  </button>
                )}
                {permiteUrea("registrar_compra") && (
                  <button
                    type="button"
                    onClick={() => {
                      setMensajeCompra(null);
                      setModalCompra(true);
                    }}
                    className={botonAccion}
                  >
                    <Receipt className="w-4 h-4 shrink-0" />
                    Compra en ruta
                  </button>
                )}
                {permiteUrea("registrar_entrada") && (
                  <button
                    type="button"
                    onClick={() => setModalEntrada(true)}
                    className={botonAccion}
                  >
                    <PackagePlus className="w-4 h-4 shrink-0" />
                    Entrada
                  </button>
                )}
                {permiteUrea("registrar_conteo_fisico") && (
                  <button
                    type="button"
                    onClick={() => setModalConteo(true)}
                    className={botonAccion}
                  >
                    <ClipboardList className="w-4 h-4 shrink-0" />
                    Conteo físico
                  </button>
                )}
              </div>
            </div>
          )}
          {hayHerramientas && (
            <div className="flex min-w-0 flex-col gap-2">
              <span className={etiquetaGrupo}>Herramientas</span>
              <div className="flex flex-wrap gap-2">
                {puedeVerKardex && (
                  <button
                    type="button"
                    onClick={() => setPanelAbierto("kardex")}
                    className={botonHerramienta}
                  >
                    <BookOpen className="w-4 h-4 shrink-0" />
                    Kardex
                  </button>
                )}
                {puedeConfigurar && (
                  <button
                    type="button"
                    onClick={() => setPanelAbierto("envases")}
                    className={botonHerramienta}
                  >
                    <Package className="w-4 h-4 shrink-0" />
                    Envases
                  </button>
                )}
                {puedeConfigurar && (
                  <button
                    type="button"
                    onClick={() => setPanelAbierto("configuracion")}
                    className={botonHerramienta}
                  >
                    <Settings className="w-4 h-4 shrink-0" />
                    Configuración
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {puedeVerHallazgos && hallazgos && <FranjaHallazgos datos={hallazgos} />}

      {puedeVerUrea && estado?.sinConteo && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {estado.sinConteo.diasSinConteo === null ? (
            <>
              <strong>Todavía no se hizo ningún conteo físico de urea.</strong> Es el reemplazo de
              la varilla del tanque: sin él, el stock de urea nunca se puede contrastar contra la
              realidad del almacén.
            </>
          ) : (
            <>
              <strong>Hace {estado.sinConteo.diasSinConteo} días</strong> que nadie cuenta la urea
              en almacén (el límite configurado es {estado.sinConteo.limiteDias} días).
            </>
          )}
        </div>
      )}

      {/* ── El panel a primera vista: el stock y lo último que pasó en el
          almacén, como el cilindro y la tabla de Tanques. ── */}
      {puedeVerUrea && estado?.stock && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
          <AlmacenUrea
            stock={estado.stock}
            puedeVerKardex={puedeVerKardex}
            puedeCorregirLitros={puedeCorregirLitros}
            onCorregido={() => {
              cargarEstado();
              cargarPresentaciones();
            }}
          />
          <ResumenUrea stock={estado.stock} />
        </div>
      )}
      {puedeVerUrea && puedeVerKardex && (
        <MovimientosRecientes clave={recargas} onVerKardex={() => setPanelAbierto("kardex")} />
      )}

      {mensajeCompra && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {mensajeCompra}
        </div>
      )}

      {puedeVerHistorial && (
        <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
          <div className="px-5 pt-4">
            <h2 className="text-base font-bold text-slate-800">Historial de urea</h2>
            <p className="text-xs text-slate-500">
              {soloHistorialCompras
                ? "Aquí están tus compras en ruta. Sube la foto del comprobante dentro de las 24 horas."
                : "Aquí están los historiales: vales, compras en ruta, entradas y conteos. En las compras en ruta se sube la foto del comprobante dentro de las 24 horas."}
            </p>
          </div>
          <div
            className="flex gap-1 overflow-x-auto border-b border-slate-200 px-3.5 pt-2.5"
            role="tablist"
            aria-label="Historial"
          >
            {vistasVisibles.map((v) => (
              <button
                key={v.valor}
                type="button"
                role="tab"
                aria-selected={vista === v.valor}
                onClick={() => setVista(v.valor)}
                className={`-mb-px whitespace-nowrap border-b-2 px-3.5 py-2 text-sm font-medium ${
                  vista === v.valor
                    ? "border-[#a3e635] text-slate-800"
                    : "border-transparent text-slate-500 hover:text-white"
                }`}
              >
                {v.etiqueta}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-4">
            {!VISTAS_SIN_PERIODO.has(vista) && (
              <>
                <label className="flex flex-col text-sm">
                  <span className="text-gray-600">Desde</span>
                  <input
                    type="date"
                    value={desde}
                    onChange={(e) => setDesde(e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm"
                  />
                </label>
                <label className="flex flex-col text-sm">
                  <span className="text-gray-600">Hasta</span>
                  <input
                    type="date"
                    value={hasta}
                    onChange={(e) => setHasta(e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const escrito = { desde, hasta };
                    setAplicado(escrito);
                    cargarVista(vista, false, escrito);
                  }}
                  disabled={cargando}
                  className="px-4 py-2 bg-slate-900 text-white text-sm font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50"
                >
                  {cargando ? "Cargando…" : "Consultar"}
                </button>
              </>
            )}
            {permiteUrea("exportar") && vista !== "por_viaje" && (
              <button
                type="button"
                onClick={() =>
                  exportarCsvUrea(
                    (vista === "vales"
                      ? vales
                      : vista === "compras"
                        ? compras.map((c) => ({
                            ...c,
                            lineas: c.lineas
                              .map((l) => `${l.cantidad_bultos}x ${l.nombre ?? l.presentacion}`)
                              .join(" + "),
                          }))
                        : vista === "entradas"
                          ? entradas
                          : vista === "por_conductor"
                            ? porConductor
                            : vista === "por_vehiculo"
                              ? porVehiculo
                              : conteos) as unknown as Record<string, unknown>[],
                    `urea-${vista}-${new Date().toISOString().slice(0, 10)}.csv`
                  )
                }
                disabled={
                  (vista === "vales" && vales.length === 0) ||
                  (vista === "compras" && compras.length === 0) ||
                  (vista === "entradas" && entradas.length === 0) ||
                  (vista === "conteos" && conteos.length === 0) ||
                  (vista === "por_conductor" && porConductor.length === 0) ||
                  (vista === "por_vehiculo" && porVehiculo.length === 0)
                }
                className="ml-auto flex items-center gap-2 px-4 py-2 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                title="Exportar este historial a CSV"
              >
                <Download className="w-4 h-4 shrink-0" />
                Exportar
              </button>
            )}
          </div>

          {error && <div className="p-4 text-sm text-red-600">{error}</div>}
          {cargando && <div className="p-4 text-sm text-slate-500">Cargando…</div>}

          {!cargando && vista === "vales" && (
            <TablaVales
              filas={vales}
              equipos={equipos}
              onAnulado={recargarTodo}
              puedeAnular={esAdmin}
            />
          )}
          {!cargando && vista === "compras" && (
            <TablaComprasUrea
              filas={compras}
              puedeAnular={esAdmin || usuario?.rol === "operador"}
              puedeReemplazar={
                usuario?.rol !== "lectura" &&
                (permiteUrea("registrar_compra") || permiteUrea("historial_compras"))
              }
              onCambio={recargarTodo}
            />
          )}
          {!cargando && vista === "entradas" && <TablaEntradas filas={entradas} />}
          {!cargando && vista === "conteos" && (
            <TablaConteos filas={conteos} onAnulado={recargarTodo} puedeAnular={esAdmin} />
          )}
          {!cargando && vista === "por_conductor" && <TablaPorConductor filas={porConductor} />}
          {!cargando && vista === "por_vehiculo" && <TablaPorVehiculo filas={porVehiculo} />}
          {vista === "por_viaje" && (
            <div className="p-4">
              <ConsumoPorViaje
                producto="urea"
                desde={periodoViaje.desde}
                hasta={periodoViaje.hasta}
                recargar={periodoViaje.n}
                puedeExportar={permiteUrea("exportar")}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Las herramientas, en panel flotante (mismo criterio que Tanques:
          consulta = panel, formulario = modal). ── */}
      {panelAbierto === "kardex" && (
        <VentanaFlotante
          id="urea-kardex"
          titulo="Kardex de urea"
          subtitulo="Entradas, vales y conteos del almacén con saldo corriente. Las compras en ruta no pasan por el almacén."
          onCerrar={() => setPanelAbierto(null)}
          anchoInicial={1000}
          altoInicial={560}
        >
          <CuerpoVentana>
            <PanelKardexUrea puedeExportar={permiteUrea("exportar")} clave={recargas} />
          </CuerpoVentana>
        </VentanaFlotante>
      )}
      {panelAbierto === "envases" && puedeConfigurar && (
        <VentanaFlotante
          id="urea-envases"
          titulo="Envases de urea"
          subtitulo="Qué envases usa la empresa y cuántos litros trae cada uno"
          onCerrar={() => setPanelAbierto(null)}
          anchoInicial={980}
          altoInicial={600}
        >
          <CuerpoVentana>
            <ConfiguracionPresentaciones
              filas={presentaciones}
              puedeCorregirLitros={puedeCorregirLitros}
              onCambio={() => {
                cargarPresentaciones();
                cargarEstado();
              }}
            />
          </CuerpoVentana>
        </VentanaFlotante>
      )}
      {panelAbierto === "configuracion" && puedeConfigurar && (
        <VentanaFlotante
          id="urea-configuracion"
          titulo="Configuración de urea"
          subtitulo="Umbrales de alerta"
          onCerrar={() => setPanelAbierto(null)}
          anchoInicial={980}
          altoInicial={640}
        >
          <CuerpoVentana>
            <UmbralesUrea
              onGuardado={() => {
                cargarEstado();
                setPanelAbierto(null);
              }}
            />
          </CuerpoVentana>
        </VentanaFlotante>
      )}

      {modalVale && (
        <ModalVale
          equipos={equipos}
          grifos={grifos.filter((g) => g.abastece_urea)}
          presentaciones={presentaciones}
          onCerrar={() => setModalVale(false)}
          onCreado={() => {
            setModalVale(false);
            setVista("vales");
            recargarTodo();
          }}
        />
      )}
      {modalEntrada && (
        <ModalEntrada
          grifos={grifos.filter((g) => g.abastece_urea)}
          presentaciones={presentaciones}
          precios={precios}
          onCerrar={() => setModalEntrada(false)}
          onCreado={() => {
            setModalEntrada(false);
            setVista("entradas");
            recargarTodo();
          }}
        />
      )}
      {modalCompra && (
        <ModalCompraUrea
          equipos={equipos}
          grifos={grifos.filter((g) => g.abastece_urea_ruta)}
          presentaciones={presentaciones}
          precios={precios}
          onCerrar={() => setModalCompra(false)}
          onCreado={(mensaje) => {
            setModalCompra(false);
            setMensajeCompra(mensaje);
            if (puedeVerUrea) setVista("compras");
            recargarTodo();
          }}
        />
      )}
      {modalConteo && (
        <ModalConteo
          presentaciones={presentaciones}
          onCerrar={() => setModalConteo(false)}
          onCreado={() => {
            setModalConteo(false);
            setVista("conteos");
            recargarTodo();
          }}
        />
      )}
    </div>
  );
}

// ── Tablas ──────────────────────────────────────────────────────────────

function TablaVales({
  filas,
  equipos,
  onAnulado,
  puedeAnular,
}: {
  filas: ValeFila[];
  equipos: Equipo[];
  onAnulado: () => void;
  puedeAnular: boolean;
}) {
  const [anulando, setAnulando] = useState<ValeFila | null>(null);
  if (filas.length === 0) {
    return <div className="p-6 text-sm text-slate-500">Todavía no hay vales de urea cargados.</div>;
  }
  const placaDe = (equipoId: number | null) =>
    equipos.find((e) => e.id === equipoId)?.placa_codigo ?? "—";
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-2">Documento</th>
            <th className="text-left px-4 py-2">Origen</th>
            <th className="text-left px-4 py-2">Fecha</th>
            <th className="text-left px-4 py-2">Unidad</th>
            <th className="text-left px-4 py-2">Presentación</th>
            <th className="text-right px-4 py-2">Litros</th>
            <th className="text-right px-4 py-2">Costo</th>
            <th className="text-left px-4 py-2">Conductor</th>
            <th className="text-left px-4 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas.map((f) => (
            <tr key={f.id} className={f.anulada_en ? "opacity-50" : ""}>
              <td className="px-4 py-2 font-mono text-xs">
                {f.origen === "compra_externa" ? (
                  <>
                    {f.comprobante_tipo} {f.comprobante_numero}
                    {f.comprobante_subido_en ? (
                      <button
                        type="button"
                        onClick={() => verComprobanteUrea(f.id)}
                        className="ml-2 font-sans text-xs text-slate-600 underline hover:text-slate-900"
                      >
                        ver foto
                      </button>
                    ) : (
                      // Una compra sin foto es una compra sin respaldo: el
                      // formulario la exige, pero la foto viaja aparte y pudo
                      // fallar o quedar en la cola de un teléfono.
                      <span className="ml-2 font-sans text-xs font-semibold text-red-600">
                        sin foto
                      </span>
                    )}
                  </>
                ) : (
                  `${f.serie_talonario}-${String(f.n_vale).padStart(5, "0")}`
                )}
              </td>
              <td className="px-4 py-2 text-xs">
                {f.origen === "compra_externa" ? (
                  <span className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-700">
                    Compra en ruta
                  </span>
                ) : (
                  <span className="text-slate-500">Almacén</span>
                )}
              </td>
              <td className="px-4 py-2">{formatearFecha(f.despachado_en)}</td>
              <td className="px-4 py-2">{placaDe(f.equipo_id)}</td>
              <td className="px-4 py-2">{etiquetaRenglones(f.renglones)}</td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.cantidad)} L</td>
              <td className="px-4 py-2 text-right">S/ {formatearNumero(f.costo_total, 2)}</td>
              <td className="px-4 py-2">{f.conductor_nombre ?? "—"}</td>
              <td className="px-4 py-2">
                {f.anulada_en ? (
                  <span className="text-xs text-red-500">anulado</span>
                ) : puedeAnular ? (
                  <button
                    type="button"
                    onClick={() => setAnulando(f)}
                    className="text-xs text-slate-400 hover:text-red-600"
                  >
                    Anular
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {anulando && (
        <ModalAnular
          titulo={
            anulando.origen === "compra_externa"
              ? `Anular la compra (${anulando.comprobante_tipo} ${anulando.comprobante_numero})`
              : `Anular el vale ${anulando.serie_talonario}-${anulando.n_vale}`
          }
          onCerrar={() => setAnulando(null)}
          onConfirmar={async (motivo) => {
            await apiFetch(`/api/erp/combustible/despachos/${anulando.id}/anular`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ motivo }),
            });
            setAnulando(null);
            onAnulado();
          }}
        />
      )}
    </div>
  );
}

function TablaEntradas({ filas }: { filas: EntradaFila[] }) {
  if (filas.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500">Todavía no hay entradas de urea cargadas.</div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-2">Fecha</th>
            <th className="text-left px-4 py-2">Proveedor</th>
            <th className="text-left px-4 py-2">Presentación</th>
            <th className="text-right px-4 py-2">Litros</th>
            <th className="text-right px-4 py-2">Costo</th>
            <th className="text-left px-4 py-2">Documento</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas.map((f) => (
            <tr key={f.id} className={f.anulada_en ? "opacity-50" : ""}>
              <td className="px-4 py-2">{formatearFecha(f.recibido_en)}</td>
              <td className="px-4 py-2">{f.grifo_nombre}</td>
              <td className="px-4 py-2">{etiquetaRenglones(f.renglones)}</td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.cantidad)} L</td>
              <td className="px-4 py-2 text-right">S/ {formatearNumero(f.costo_total, 2)}</td>
              <td className="px-4 py-2">
                {f.tipo_documento ? `${f.tipo_documento} ${f.numero_documento ?? ""}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Los dos rankings -- mismo endpoint que Histórico de combustible
 *  (GET /consumo-por-conductor, GET /consumo-por-vehiculo), filtrado con
 *  ?producto=urea. Sin paginar, mismo criterio que el original: es un
 *  ranking chico (un conductor/equipo por fila), no un listado que crezca
 *  sin límite. */
function TablaPorConductor({ filas }: { filas: ConductorFila[] }) {
  if (filas.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500">
        Sin vales de urea con conductor en el período elegido.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-2">Conductor</th>
            <th className="text-left px-4 py-2">DNI</th>
            <th className="text-right px-4 py-2">Vales</th>
            <th className="text-right px-4 py-2">Litros</th>
            <th className="text-right px-4 py-2">Costo</th>
            <th className="text-left px-4 py-2">Primer vale</th>
            <th className="text-left px-4 py-2">Último vale</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas.map((f, i) => (
            <tr key={i}>
              <td className="px-4 py-2">{f.conductor_nombre}</td>
              <td className="px-4 py-2">{f.conductor_dni ?? "—"}</td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.cantidad_vales, 0)}</td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.total_cantidad)} L</td>
              <td className="px-4 py-2 text-right">S/ {formatearNumero(f.total_costo, 2)}</td>
              <td className="px-4 py-2">{formatearFecha(f.primer_despacho)}</td>
              <td className="px-4 py-2">{formatearFecha(f.ultimo_despacho)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TablaPorVehiculo({ filas }: { filas: VehiculoFila[] }) {
  if (filas.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500">Sin vales de urea en el período elegido.</div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-2">Unidad</th>
            <th className="text-left px-4 py-2">Tipo</th>
            <th className="text-right px-4 py-2">Vales</th>
            <th className="text-right px-4 py-2">Litros</th>
            <th
              className="text-right px-4 py-2"
              title="Litros / vales. Supone un vale = una tanqueada (ver el ADR)."
            >
              Promedio por tanqueada
            </th>
            <th className="text-right px-4 py-2">Costo</th>
            <th className="text-left px-4 py-2">Primer vale</th>
            <th className="text-left px-4 py-2">Último vale</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas.map((f) => (
            <tr key={f.equipo_id}>
              <td className="px-4 py-2">{f.placa_codigo ?? "—"}</td>
              <td className="px-4 py-2">{f.equipo_tipo ?? "—"}</td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.cantidad_vales, 0)}</td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.total_cantidad)} L</td>
              <td className="px-4 py-2 text-right">
                {Number(f.cantidad_vales) > 0
                  ? `${formatearNumero(String(Number(f.total_cantidad) / Number(f.cantidad_vales)))} L`
                  : "—"}
              </td>
              <td className="px-4 py-2 text-right">S/ {formatearNumero(f.total_costo, 2)}</td>
              <td className="px-4 py-2">{formatearFecha(f.primer_despacho)}</td>
              <td className="px-4 py-2">{formatearFecha(f.ultimo_despacho)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TablaConteos({
  filas,
  onAnulado,
  puedeAnular,
}: {
  filas: ConteoFila[];
  onAnulado: () => void;
  puedeAnular: boolean;
}) {
  const [anulando, setAnulando] = useState<ConteoFila | null>(null);
  if (filas.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500">Todavía no se registró ningún conteo físico.</div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-2">Fecha</th>
            <th className="text-left px-4 py-2">Qué se contó</th>
            <th className="text-right px-4 py-2">Litros contados</th>
            <th className="text-left px-4 py-2">Registrado por</th>
            <th className="text-left px-4 py-2">Observaciones</th>
            <th className="text-left px-4 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas.map((f) => (
            <tr key={f.id} className={f.anulada_en ? "opacity-50" : ""}>
              <td className="px-4 py-2">{formatearFecha(f.contado_en)}</td>
              <td className="px-4 py-2">
                {[
                  etiquetaRenglones(f.renglones),
                  Number(f.suelto_litros ?? 0) > 0
                    ? `${formatearNumero(String(f.suelto_litros))} L suelto`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" + ") || "—"}
              </td>
              <td className="px-4 py-2 text-right">{formatearNumero(f.cantidad_litros)} L</td>
              <td className="px-4 py-2">{f.registrado_por_nombre ?? "—"}</td>
              <td className="px-4 py-2">{f.observaciones ?? "—"}</td>
              <td className="px-4 py-2">
                {f.anulada_en ? (
                  <span className="text-xs text-red-500" title={f.motivo_anulacion ?? ""}>
                    anulado
                  </span>
                ) : puedeAnular ? (
                  <button
                    type="button"
                    onClick={() => setAnulando(f)}
                    className="text-xs text-slate-400 hover:text-red-600"
                  >
                    Anular
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {anulando && (
        <ModalAnular
          titulo="Anular este conteo"
          onCerrar={() => setAnulando(null)}
          onConfirmar={async (motivo) => {
            await apiFetch(`/api/erp/combustible/urea/conteos/${anulando.id}/anular`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ motivo }),
            });
            setAnulando(null);
            onAnulado();
          }}
        />
      )}
    </div>
  );
}

// ── La franja de hallazgos (entrega 4) ──────────────────────────────────
//
// Lo de urea que sigue sin explicar, arriba de todo y en una línea por
// hallazgo. Solo lectura a propósito: el cierre necesita motivo y vive en
// Combustible → Alertas, donde ya están el flujo y la bitácora. Duplicarlo
// acá sería tener dos lugares donde se puede cerrar una alerta, y uno de los
// dos terminaría sin la validación del otro.

const NOMBRE_HALLAZGO: Record<string, string> = {
  urea_descuadre_conteo: "El conteo no cuadra",
  urea_conteo_recargado: "Conteo anulado y vuelto a cargar",
  urea_precio_fuera_de_catalogo: "Precio fuera del catálogo",
  urea_litros_corregidos: "Litros de un envase corregidos",
  urea_conteo_alterado: "Un conteo cambió de resultado",
  urea_stock_bajo: "Queda poca urea",
  urea_stock_excedido: "Depósito por encima del máximo",
  urea_equipo_no_habilitado: "Urea a una unidad que no usa",
  urea_ratio_excedido: "Urea/diésel fuera de rango",
  tope_diario_excedido: "Tope diario superado",
  hueco_detectado: "Falta un vale del talonario",
  vale_fuera_de_orden: "Vale fuera de orden",
  vale_recargado: "Vale anulado y vuelto a cargar",
  vale_anulado: "Vale anulado",
  despacho_tardio: "Vale que llegó tarde",
};

/** Una frase con el número que importa de cada hallazgo. Si el tipo no
 *  tiene frase propia, se muestra solo el nombre: nunca "undefined L". */
function resumirHallazgo(h: HallazgoUrea): string | null {
  const d = h.detalle;
  const n = (v: unknown) =>
    typeof v === "number" ? v.toLocaleString("es-PE", { maximumFractionDigits: 1 }) : null;
  switch (h.tipo) {
    case "urea_descuadre_conteo":
      return n(d.descuadreL) && `${n(d.contadoL)} L contados vs ${n(d.esperadoL)} L esperados`;
    case "urea_conteo_recargado":
      return (
        n(d.descuadreAnuladoL) &&
        `diferencia ${n(d.descuadreAnuladoL)} L → ${n(d.descuadreNuevoL)} L tras anular ("${String(d.motivoAnulacion ?? "")}")`
      );
    case "urea_stock_bajo":
      return n(d.stockL) && `${n(d.stockL)} L, mínimo ${n(d.stockMinimoL)} L`;
    case "urea_stock_excedido":
      return n(d.excesoL) && `${n(d.excesoL)} L por encima de ${n(d.stockMaximoL)} L`;
    case "urea_precio_fuera_de_catalogo": {
      const desvios = (d.desvios ?? []) as { presentacion: string; desvioPct: number }[];
      return desvios.length
        ? desvios
            .map((x) => `${x.presentacion} ${x.desvioPct > 0 ? "+" : ""}${x.desvioPct}%`)
            .join(", ") + (d.comprobanteNumero ? ` (${String(d.comprobanteNumero)})` : "")
        : null;
    }
    case "urea_litros_corregidos": {
      const envase = d.envase as { nombre?: string } | undefined;
      const stock = d.stockAlmacenL as { antes: number; despues: number } | undefined;
      return stock
        ? `${envase?.nombre ?? "Envase"} a ${n(d.litrosDespues)} L; stock ${stock.antes} → ${stock.despues} L`
        : null;
    }
    case "urea_conteo_alterado": {
      const causa = d.causa as { descripcion?: string } | undefined;
      return typeof d.antesL === "number"
        ? `${n(d.antesL)} L → ${n(d.despuesL)} L por ${causa?.descripcion ?? "un movimiento con fecha pasada"}`
        : null;
    }
    case "urea_ratio_excedido":
      return n(d.ratioPct) && `${n(d.ratioPct)}% (máximo ${n(d.maxPct)}%)`;
    default:
      return null;
  }
}

function FranjaHallazgos({ datos }: { datos: HallazgosUrea }) {
  if (datos.total === 0) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        Sin hallazgos de urea abiertos.
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <div className="text-sm font-semibold text-amber-900">
        {datos.total} hallazgo{datos.total === 1 ? "" : "s"} de urea sin explicar
      </div>
      <ul className="mt-2 space-y-1 text-sm text-amber-900">
        {datos.hallazgos.map((h) => {
          const resumen = resumirHallazgo(h);
          return (
            <li key={h.id} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{NOMBRE_HALLAZGO[h.tipo] ?? h.tipo}</span>
              {h.vale && <span className="text-amber-700">· vale {h.vale}</span>}
              {resumen && <span className="text-amber-800">· {resumen}</span>}
              <span className="text-amber-600">· {formatearFecha(h.creado_en)}</span>
              {h.congelada && (
                <span className="rounded bg-red-100 px-1.5 text-xs font-semibold text-red-700">
                  congelado
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {datos.total > datos.hallazgos.length && (
        <div className="mt-2 text-xs text-amber-700">
          Se muestran los {datos.hallazgos.length} más recientes de {datos.total}.
        </div>
      )}
      <div className="mt-2 text-xs text-amber-700">
        Se revisan y se cierran, con motivo, desde Combustible → Alertas.
      </div>
    </div>
  );
}

// ── Los cuatro umbrales de urea (migración 0117) ────────────────────────
//
// Dos por equipo (tope diario y ratio urea/diésel, de 0092) y dos globales
// del depósito (mínimo y máximo de stock, de 0117). Los cuatro arrancan
// VACÍOS y vacío significa "este control está apagado" -- no 0. Por eso el
// input manda `null` cuando está en blanco y nunca 0.
//
// ── Por qué este formulario manda la config ENTERA ─────────────────────
//
// `PUT /config` reemplaza la fila completa, no hace un patch. Si esta
// pantalla mandara solo los cuatro campos de urea, el resto de la config del
// módulo (ventana de gracia, días sin medir, topes de combustible...) se
// resetearía a los defaults del schema sin que nadie lo pidiera. Así que se
// lee la config completa con GET, se guarda en estado, y se la devuelve con
// solo los campos de urea cambiados.
//
// El backend igual protege ese error: apagar un control en silencio cuenta
// como aflojamiento y el PUT se rechaza sin motivo (evaluarAflojamientoConfig).
// Pero depender de eso sería depender de que la red de seguridad haga el
// trabajo del formulario.

interface ConfigCombustibleUrea {
  tope_diario_urea_l: number | null;
  ratio_urea_diesel_max_pct: number | null;
  stock_minimo_urea_l: number | null;
  stock_maximo_urea_l: number | null;
  tolerancia_precio_urea_pct: number | null;
}

/** El valor de un input numérico opcional: vacío = null = control apagado. */
function aNumeroOpcional(texto: string): number | null {
  const limpio = texto.trim();
  if (limpio === "") return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

function UmbralesUrea({ onGuardado }: { onGuardado: () => void }) {
  // La config completa tal como vino del servidor -- se devuelve igual salvo
  // los cuatro campos de urea. Ver el comentario de arriba.
  const [configCompleta, setConfigCompleta] = useState<Record<string, unknown> | null>(null);
  const [tope, setTope] = useState("");
  const [ratio, setRatio] = useState("");
  const [minimo, setMinimo] = useState("");
  const [maximo, setMaximo] = useState("");
  const [tolerancia, setTolerancia] = useState("");
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aflojados, setAflojados] = useState<{ control: string; de: string; a: string }[]>([]);
  const [ok, setOk] = useState(false);
  const [sugerencia, setSugerencia] = useState<SugerenciaUmbralesUrea | null>(null);
  const [cargandoSugerencia, setCargandoSugerencia] = useState(false);

  const cargar = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible/config");
    if (!res.ok) {
      setError("No se pudo cargar la configuración.");
      return;
    }
    const body = (await res.json()) as Record<string, unknown> & ConfigCombustibleUrea;
    setConfigCompleta(body);
    setTope(body.tope_diario_urea_l === null ? "" : String(body.tope_diario_urea_l));
    setRatio(body.ratio_urea_diesel_max_pct === null ? "" : String(body.ratio_urea_diesel_max_pct));
    setMinimo(body.stock_minimo_urea_l === null ? "" : String(body.stock_minimo_urea_l));
    setMaximo(body.stock_maximo_urea_l === null ? "" : String(body.stock_maximo_urea_l));
    setTolerancia(
      body.tolerancia_precio_urea_pct === null ? "" : String(body.tolerancia_precio_urea_pct)
    );
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar -- ver IpercView.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  const pedirSugerencia = async () => {
    setCargandoSugerencia(true);
    try {
      const res = await apiFetch("/api/erp/combustible/urea/sugerencia-umbrales");
      setSugerencia(res.ok ? ((await res.json()) as SugerenciaUmbralesUrea) : null);
    } finally {
      setCargandoSugerencia(false);
    }
  };

  const guardar = async () => {
    if (!configCompleta) return;
    setGuardando(true);
    setError(null);
    setAflojados([]);
    setOk(false);
    try {
      const res = await apiFetch("/api/erp/combustible/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...configCompleta,
          tope_diario_urea_l: aNumeroOpcional(tope),
          ratio_urea_diesel_max_pct: aNumeroOpcional(ratio),
          stock_minimo_urea_l: aNumeroOpcional(minimo),
          stock_maximo_urea_l: aNumeroOpcional(maximo),
          tolerancia_precio_urea_pct: aNumeroOpcional(tolerancia),
          ...(motivo.trim() ? { motivo_ajuste: motivo.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "No se pudo guardar.");
        // El backend dice QUÉ se está aflojando, no solo que falta un motivo:
        // es lo que convierte "poné algo acá" en una decisión informada.
        if (Array.isArray(body?.aflojados)) setAflojados(body.aflojados);
        return;
      }
      setOk(true);
      setMotivo("");
      await cargar();
      onGuardado();
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="border-b border-slate-200 p-4">
      <h3 className="text-sm font-bold text-slate-800">Umbrales de urea</h3>
      <p className="mt-1 text-sm text-slate-600">
        <strong>Ninguno de los cuatro bloquea nada:</strong> el vale, la compra o la entrada se
        registran siempre, y si pasan el umbral queda una alerta para revisar. Dejar un campo{" "}
        <strong>vacío</strong> apaga ese control. No se inventan números — un umbral puesto al azar
        avisa todos los días por trabajo normal (y se termina ignorando) o queda tan alto que no
        atrapa nada.
      </p>

      {error && <div className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {aflojados.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-red-700">
          {aflojados.map((a) => (
            <li key={a.control}>
              <strong>{a.control}</strong>: {a.de} → {a.a}
            </li>
          ))}
        </ul>
      )}
      {ok && (
        <div className="mt-3 rounded bg-emerald-50 p-3 text-sm text-emerald-700">
          Umbrales guardados.
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-700 font-medium">Tope diario por unidad (L)</span>
          <input
            type="number"
            step="0.01"
            min={0}
            value={tope}
            onChange={(e) => setTope(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
          <span className="text-xs text-slate-500">
            Si una unidad recibe más que esto en 24 horas (sumando vales del almacén y compras en
            ruta), queda una alerta. No se le niega la urea.
          </span>
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-700 font-medium">Ratio máximo urea/diésel (%)</span>
          <input
            type="number"
            step="0.1"
            min={0}
            max={100}
            value={ratio}
            onChange={(e) => setRatio(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
          <span className="text-xs text-slate-500">
            Un motor SCR consume urea en proporción estable al diésel (3-5% típico). Se mide por
            unidad, sobre los últimos 30 días: litros de urea ÷ litros de diésel. Si se dispara,
            queda una alerta.
          </span>
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-700 font-medium">Stock mínimo del depósito (L)</span>
          <input
            type="number"
            step="0.01"
            min={0}
            value={minimo}
            onChange={(e) => setMinimo(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
          <span className="text-xs text-slate-500">
            Cuando el almacén queda por debajo, avisa que hay que reabastecer. El aviso se cierra
            solo cuando entra la compra.
          </span>
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-700 font-medium">Stock máximo del depósito (L)</span>
          <input
            type="number"
            step="0.01"
            min={0}
            value={maximo}
            onChange={(e) => setMaximo(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
          <span className="text-xs text-slate-500">
            Al registrar una entrada al almacén, si el depósito queda por encima, avisa. Mira el
            total, no la compra sola, así que también atrapa comprar de a poco. La entrada se
            registra igual.
          </span>
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-700 font-medium">
            Tolerancia de precio contra el catálogo (%)
          </span>
          <input
            type="number"
            step="0.1"
            min={0}
            max={100}
            value={tolerancia}
            onChange={(e) => setTolerancia(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
          <span className="text-xs text-slate-500">
            Si una compra en ruta declara un precio por envase que se aparta del catálogo de ese
            proveedor más que esto (para arriba o para abajo), queda una alerta. La compra se
            registra igual. Sin precio de catálogo para ese envase, no se compara.
          </span>
        </label>
      </div>

      <label className="mt-4 flex flex-col text-sm gap-1">
        <span className="text-gray-700">Motivo del cambio</span>
        <input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Solo obligatorio si el cambio reduce la vigilancia"
          className="rounded border border-gray-300 px-3 py-2"
        />
        <span className="text-xs text-slate-500">
          Bajar el mínimo, subir el máximo o la tolerancia, o apagar cualquiera cuenta como aflojar:
          ahí el motivo es obligatorio y queda en la bitácora.
        </span>
      </label>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={guardar}
          disabled={guardando || !configCompleta}
          className="px-4 py-2 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d] rounded-xl text-sm font-semibold disabled:cursor-not-allowed"
        >
          {guardando ? "Guardando…" : "Guardar umbrales"}
        </button>
        <button
          type="button"
          onClick={pedirSugerencia}
          disabled={cargandoSugerencia}
          className="px-4 py-2 border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium rounded-xl text-sm disabled:opacity-50"
        >
          {cargandoSugerencia ? "Calculando…" : "Sugerir desde el historial"}
        </button>
      </div>

      {sugerencia && (
        <SugerenciaUrea
          sugerencia={sugerencia}
          onAplicar={(campos) => {
            // Rellena los inputs, NO guarda. El asistente sugiere; una
            // persona decide y aprieta Guardar -- regla del módulo desde el
            // asistente del tanque.
            if (campos.tope !== undefined) setTope(String(campos.tope));
            if (campos.ratio !== undefined) setRatio(String(campos.ratio));
            if (campos.minimo !== undefined) setMinimo(String(campos.minimo));
            if (campos.maximo !== undefined) setMaximo(String(campos.maximo));
          }}
        />
      )}
    </div>
  );
}

interface SugerenciaUmbralesUrea {
  diasHistorial: number;
  advertencia: string;
  topeDiario:
    | {
        muestraSuficiente: true;
        sugeridoL: number;
        formula: string;
        equipoQueLoDefine: string;
        nota: string | null;
      }
    | { muestraSuficiente: false; minimoRequerido: number; nota: string | null };
  ratio:
    | {
        muestraSuficiente: true;
        sugeridoPct: number;
        promedioPct: number;
        maximoObservadoPct: number;
        formula: string;
      }
    | { muestraSuficiente: false; equiposConLosDosProductos: number; nota: string | null };
  stock:
    | {
        muestraSuficiente: true;
        promedioDiarioL: number;
        diaMaximoL: number;
        peorSemanaL: number;
        minimoSugeridoL: number;
        minimoFormula: string;
        maximoSugeridoL: number;
        maximoFormula: string;
        nota: string | null;
      }
    | { muestraSuficiente: false; diasConConsumo: number; minimoRequerido: number; nota: string };
}

/** El asistente. Muestra la FÓRMULA y la muestra, no solo el número: un
 *  umbral que alguien acepta sin entender de dónde salió es un umbral que va
 *  a terminar ignorado. Y la advertencia de que la muestra puede contener
 *  justo el consumo que se quiere detectar va siempre. */
function SugerenciaUrea({
  sugerencia,
  onAplicar,
}: {
  sugerencia: SugerenciaUmbralesUrea;
  onAplicar: (campos: { tope?: number; ratio?: number; minimo?: number; maximo?: number }) => void;
}) {
  const { topeDiario, ratio, stock } = sugerencia;
  const nada =
    !topeDiario.muestraSuficiente && !ratio.muestraSuficiente && !stock.muestraSuficiente;

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 text-sm">
      <div className="font-semibold text-slate-800">
        Sugerencia desde los últimos {sugerencia.diasHistorial} días
      </div>

      {nada && (
        <p className="mt-2 text-slate-600">
          Todavía no hay historial suficiente para sugerir nada, y eso es lo esperado al arrancar:
          el sistema no inventa un número. A medida que se carguen vales y entradas de urea, este
          botón empieza a dar valores.
        </p>
      )}

      <ul className="mt-3 space-y-3">
        <li>
          <div className="font-medium text-slate-700">Tope diario por unidad</div>
          {topeDiario.muestraSuficiente ? (
            <div className="text-slate-600">
              <strong>{topeDiario.sugeridoL} L</strong> — {topeDiario.formula}. Lo define{" "}
              {topeDiario.equipoQueLoDefine}.
              {topeDiario.nota && (
                <div className="mt-1 text-xs text-amber-700">{topeDiario.nota}</div>
              )}
              <button
                type="button"
                onClick={() => onAplicar({ tope: topeDiario.sugeridoL })}
                className="mt-1 text-xs font-semibold text-slate-700 underline hover:text-slate-900"
              >
                Poner en el formulario
              </button>
            </div>
          ) : (
            <div className="text-slate-500">
              Muestra insuficiente ({topeDiario.minimoRequerido} días mínimo).
              {topeDiario.nota && <> {topeDiario.nota}</>}
            </div>
          )}
        </li>

        <li>
          <div className="font-medium text-slate-700">Ratio urea/diésel</div>
          {ratio.muestraSuficiente ? (
            <div className="text-slate-600">
              <strong>{ratio.sugeridoPct}%</strong> — {ratio.formula}. Promedio observado{" "}
              {ratio.promedioPct}%, máximo {ratio.maximoObservadoPct}%.
              <button
                type="button"
                onClick={() => onAplicar({ ratio: ratio.sugeridoPct })}
                className="mt-1 block text-xs font-semibold text-slate-700 underline hover:text-slate-900"
              >
                Poner en el formulario
              </button>
            </div>
          ) : (
            <div className="text-slate-500">
              {ratio.nota ??
                `Hacen falta equipos con vales de urea Y de diésel (hay ${ratio.equiposConLosDosProductos}).`}
            </div>
          )}
        </li>

        <li>
          <div className="font-medium text-slate-700">Stock mínimo y máximo</div>
          {stock.muestraSuficiente ? (
            <div className="text-slate-600">
              <div>
                Mínimo <strong>{stock.minimoSugeridoL} L</strong> — {stock.minimoFormula}.
              </div>
              <div>
                Máximo <strong>{stock.maximoSugeridoL} L</strong> — {stock.maximoFormula}.
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Consumo promedio {stock.promedioDiarioL} L/día · día más fuerte {stock.diaMaximoL} L
                · peor semana {stock.peorSemanaL} L
              </div>
              {stock.nota && <div className="mt-1 text-xs text-amber-700">{stock.nota}</div>}
              <button
                type="button"
                onClick={() =>
                  onAplicar({ minimo: stock.minimoSugeridoL, maximo: stock.maximoSugeridoL })
                }
                className="mt-1 text-xs font-semibold text-slate-700 underline hover:text-slate-900"
              >
                Poner los dos en el formulario
              </button>
            </div>
          ) : (
            <div className="text-slate-500">{stock.nota}</div>
          )}
        </li>
      </ul>

      <p className="mt-3 border-t border-slate-200 pt-3 text-xs text-amber-800">
        {sugerencia.advertencia}
      </p>
    </div>
  );
}

// ── Configuración de envases (migración 0116) ───────────────────────────
//
// Lo que antes era una constante del código (`FACTOR_LITROS_UREA`: bolsa 4,
// caja 16, balde 20) y obligaba a una migración y un deploy cada vez que el
// cliente cambiaba de proveedor. Ahora lo edita la empresa, con motivo
// obligatorio y registro en bitácora.
//
// Lo que esta pantalla NO hace, y por qué importa: cambiar los litros de un
// envase no toca ni un movimiento ya cargado. Cada vale y cada entrada
// guardaron su `factor_litros` al nacer (0092), así que el historial se lee
// siempre con el número que estaba vigente ese día. Lo que cambia es lo que
// van a declarar los movimientos NUEVOS -- y, por lo tanto, el stock teórico
// contra el que se compara el próximo conteo físico. De ahí el motivo
// obligatorio: es la única forma de distinguir después "corregimos el envase
// que vino distinto" de "alguien movió el número justo antes del conteo".

function ConfiguracionPresentaciones({
  filas,
  puedeCorregirLitros,
  onCambio,
}: {
  filas: PresentacionFila[];
  puedeCorregirLitros: boolean;
  onCambio: () => void;
}) {
  const [editando, setEditando] = useState<PresentacionFila | null>(null);
  const [corrigiendo, setCorrigiendo] = useState<PresentacionFila | null>(null);
  const [retirando, setRetirando] = useState<{
    fila: PresentacionFila;
    modo: "baja" | "eliminar";
  } | null>(null);
  const [creando, setCreando] = useState(false);
  const [reactivando, setReactivando] = useState<number | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  /** Reactivar no pide motivo: no afloja nada, solo vuelve a ofrecer el envase. */
  const reactivar = async (p: PresentacionFila) => {
    setReactivando(p.id);
    setErrorAccion(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/urea/presentaciones/${p.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: p.nombre,
          litros: Number(p.litros),
          es_referencia: p.es_referencia,
          activa: true,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setErrorAccion(body?.error ?? "No se pudo reactivar el envase.");
        return;
      }
      onCambio();
    } finally {
      setReactivando(null);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="border-b border-slate-100 bg-slate-50/60 p-4 text-sm text-slate-600">
        <p>
          Cuántos litros trae cada envase <strong>en esta empresa</strong>. Con ese número el
          sistema convierte &quot;3 cajas&quot; en litros al registrar un vale, una entrada o un
          conteo.
        </p>
        <p className="mt-2">
          Una vez que un envase tiene movimientos, <strong>sus litros quedan fijos</strong>: cada
          movimiento guardó los suyos, y cambiarlos dejaría el envase con tamaños mezclados. Si el
          proveedor cambió el tamaño, da de alta otro envase (por ejemplo &quot;Caja 20 L&quot;).
        </p>
        <p className="mt-2">
          Un envase que <strong>nunca se usó</strong> se puede eliminar. Uno que ya tiene historial
          se <strong>da de baja</strong>: deja de ofrecerse para cargar y conserva todo lo que ya se
          registró. El envase principal no se elimina ni se da de baja: primero elige otro.
        </p>
      </div>

      {errorAccion && (
        <div className="mx-4 mt-4 rounded bg-red-50 p-2 text-sm text-red-600">{errorAccion}</div>
      )}

      <div className="flex justify-end p-4 pb-0">
        <button
          type="button"
          onClick={() => setCreando(true)}
          className="flex items-center gap-2 px-4 py-2 border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium rounded-xl transition-all text-sm"
        >
          <PackagePlus className="w-4 h-4 shrink-0" />
          Agregar envase
        </button>
      </div>

      {filas.length === 0 ? (
        <div className="p-6 text-sm text-slate-500">
          Esta empresa no tiene envases de urea cargados. Agregá al menos uno para poder registrar
          movimientos.
        </div>
      ) : (
        <div className="overflow-x-auto p-4">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2">Envase</th>
                <th className="text-left px-4 py-2">Código</th>
                <th className="text-right px-4 py-2">Litros por bulto</th>
                <th className="text-left px-4 py-2">Principal</th>
                <th className="text-left px-4 py-2">Estado</th>
                <th className="text-left px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filas.map((p) => (
                <tr key={p.id} className={p.activa ? "" : "opacity-50"}>
                  <td className="px-4 py-2 font-medium text-slate-700">{p.nombre}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500">{p.codigo}</td>
                  <td className="px-4 py-2 text-right">
                    {formatearNumero(p.litros, 2)} L
                    {(p.movimientos ?? 0) > 0 && (
                      <span className="block text-[11px] text-slate-400">
                        fijo · {p.movimientos} {p.movimientos === 1 ? "movimiento" : "movimientos"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {p.es_referencia ? (
                      <span className="text-xs font-semibold text-slate-700">
                        Sí — se abre primero en la estantería
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {p.activa ? (
                      <span className="text-emerald-700">Activo</span>
                    ) : (
                      <span className="text-slate-500">De baja</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      onClick={() => setEditando(p)}
                      className="text-xs font-semibold text-slate-600 hover:text-slate-900 underline"
                    >
                      Editar
                    </button>
                    {puedeCorregirLitros && (p.movimientos ?? 0) > 0 && (
                      <button
                        type="button"
                        onClick={() => setCorrigiendo(p)}
                        className="ml-3 text-xs font-semibold text-slate-600 hover:text-slate-900 underline"
                      >
                        Corregir litros
                      </button>
                    )}
                    {!p.activa && (
                      <button
                        type="button"
                        disabled={reactivando === p.id}
                        onClick={() => reactivar(p)}
                        className="ml-3 text-xs font-semibold text-slate-600 hover:text-slate-900 underline disabled:opacity-50"
                      >
                        {reactivando === p.id ? "Reactivando…" : "Reactivar"}
                      </button>
                    )}
                    {p.activa && !p.es_referencia && (p.usos ?? 0) > 0 && (
                      <button
                        type="button"
                        onClick={() => setRetirando({ fila: p, modo: "baja" })}
                        className="ml-3 text-xs font-semibold text-slate-600 hover:text-slate-900 underline"
                      >
                        Dar de baja
                      </button>
                    )}
                    {!p.es_referencia && p.usos === 0 && (
                      <button
                        type="button"
                        onClick={() => setRetirando({ fila: p, modo: "eliminar" })}
                        className="ml-3 text-xs font-semibold text-slate-600 hover:text-slate-900 underline"
                      >
                        Eliminar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creando && (
        <ModalCrearPresentacion
          existentes={filas}
          onCerrar={() => setCreando(false)}
          onCreado={() => {
            setCreando(false);
            onCambio();
          }}
        />
      )}
      {corrigiendo && (
        <ModalCorregirLitros
          presentacionId={corrigiendo.id}
          nombre={corrigiendo.nombre}
          litrosRegistrados={[Number(corrigiendo.litros)]}
          onCerrar={() => setCorrigiendo(null)}
          onCorregido={() => {
            setCorrigiendo(null);
            onCambio();
          }}
        />
      )}
      {retirando && (
        <ModalRetirarEnvase
          fila={retirando.fila}
          modo={retirando.modo}
          onCerrar={() => setRetirando(null)}
          onListo={() => {
            setRetirando(null);
            onCambio();
          }}
        />
      )}
      {editando && (
        <ModalEditarPresentacion
          fila={editando}
          onCerrar={() => setEditando(null)}
          onGuardado={() => {
            setEditando(null);
            onCambio();
          }}
        />
      )}
    </div>
  );
}

// ── Modales (formularios -- backdrop, a diferencia de las ventanas
// flotantes de consulta: acá hay algo a medio cargar que se puede perder) ──

function Backdrop({ children, onCerrar }: { children: React.ReactNode; onCerrar: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onCerrar}
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function ModalAnular({
  titulo,
  onCerrar,
  onConfirmar,
}: {
  titulo: string;
  onCerrar: () => void;
  onConfirmar: (motivo: string) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">{titulo}</h3>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Motivo (obligatorio)</span>
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            className="rounded border border-gray-300 px-3 py-2"
            placeholder="Ej: se contó dos veces la misma caja"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!motivo.trim() || enviando}
            onClick={async () => {
              setEnviando(true);
              try {
                await onConfirmar(motivo.trim());
              } finally {
                setEnviando(false);
              }
            }}
            className="px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50"
          >
            {enviando ? "Anulando…" : "Confirmar anulación"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function ModalVale({
  equipos,
  grifos,
  presentaciones,
  onCerrar,
  onCreado,
}: {
  equipos: Equipo[];
  grifos: Grifo[];
  presentaciones: PresentacionFila[];
  onCerrar: () => void;
  onCreado: () => void;
}) {
  const [clienteUuid] = useState(() => crypto.randomUUID());
  const [serie, setSerie] = useState("");
  const [nVale, setNVale] = useState("");
  const [equipoId, setEquipoId] = useState("");
  const [grifoId, setGrifoId] = useState("");
  const activas = presentacionesActivas(presentaciones);
  // "1 caja + 2 bolsas" en un mismo vale (0131). Sin precio: el vale del
  // almacén toma el promedio de lo que la empresa pagó por la urea.
  const [renglones, setRenglones] = useState<RenglonCompra[]>(() => [
    nuevoRenglon(presentacionPorDefecto(presentaciones)),
  ]);
  const { listos: renglonesListos } = estadoRenglones(renglones, false);
  const [despachadoEn, setDespachadoEn] = useState(ahoraParaInputLocal());
  const [observaciones, setObservaciones] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const equipoElegido = equipos.find((e) => String(e.id) === equipoId);

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/despachos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuid,
          producto: "urea",
          // 0119: el reparto del almacén. La compra en ruta es 'compra_externa'
          // y tiene su propio formulario (ModalCompraUrea).
          origen: "almacen",
          grifo_id: Number(grifoId),
          tipo_destino: "equipo",
          equipo_id: Number(equipoId),
          serie_talonario: serie.trim(),
          n_vale: Number(nVale),
          lineas: renglones.map((r) => ({
            presentacion: r.presentacion,
            cantidad_bultos: Number(r.cantidad),
          })),
          despachado_en: new Date(despachadoEn).toISOString(),
          observaciones: observaciones.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo registrar el vale.");
        return;
      }
      onCreado();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">Registrar vale de urea</h3>
        <p className="-mt-2 text-sm text-slate-500">
          Urea que sale del almacén de la empresa, con vale del talonario. Si la unidad la compró en
          ruta, usá <strong>Compra en ruta</strong>: esa no baja el stock del almacén.
        </p>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}
        {activas.length === 0 && <AvisoSinEnvases />}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Serie del talonario</span>
            <input
              value={serie}
              onChange={(e) => setSerie(e.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
              placeholder="UREA-2026-01"
            />
          </label>
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">N° de vale</span>
            <input
              type="number"
              value={nVale}
              onChange={(e) => setNVale(e.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>
        </div>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Unidad</span>
          <select
            value={equipoId}
            onChange={(e) => setEquipoId(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          >
            <option value="">Elegir unidad…</option>
            {equipos.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.placa_codigo} ({eq.tipo}){eq.usa_urea ? "" : " -- NO usa urea"}
              </option>
            ))}
          </select>
          <ConductorDeLaUnidad equipo={equipoElegido} />
          {equipoElegido && !equipoElegido.usa_urea && (
            <span className="text-xs text-amber-600">
              Esta unidad está marcada como que no usa urea. Igual se puede registrar, pero va a
              quedar como alerta para revisión.
            </span>
          )}
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Proveedor</span>
          <select
            value={grifoId}
            onChange={(e) => setGrifoId(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          >
            <option value="">Elegir proveedor…</option>
            {grifos.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nombre}
              </option>
            ))}
          </select>
          {grifos.length === 0 && <AvisoSinProveedores />}
        </label>
        <RenglonesUrea
          renglones={renglones}
          setRenglones={setRenglones}
          activas={activas}
          conPrecio={false}
          titulo="Qué salió del almacén"
        />
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Fecha y hora del vale</span>
          <input
            type="datetime-local"
            value={despachadoEn}
            onChange={(e) => setDespachadoEn(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Observaciones</span>
          <input
            value={observaciones}
            onChange={(e) => setObservaciones(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={
              !renglonesListos || !serie.trim() || !nVale || !equipoId || !grifoId || enviando
            }
            onClick={enviar}
            className="px-4 py-2 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d] rounded-xl text-sm font-semibold disabled:cursor-not-allowed"
          >
            {enviando ? "Guardando…" : "Registrar vale"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

/** COMPRA DE UREA EN RUTA (0119/0120) -- la unidad para en un grifo y compra
 *  urea con boleta o factura. Formulario aparte del vale (decisión de Kenif):
 *  los campos son otros y así no se pueden mezclar los dos papeles.
 *
 *  Lo que la distingue del vale, y por qué importa: NO baja el stock del
 *  almacén -- esa urea nunca pasó por el depósito. Sí cuenta para el tope
 *  diario, el ratio urea/diésel y los rankings: es urea que recibió la unidad.
 *
 *  RENGLONES (0120): una boleta puede traer "2 cajas + 3 bolsas". Cada renglón
 *  con su presentación, su cantidad y su precio por bulto tal como figura en
 *  el papel; debajo, la suma en litros y en soles.
 *
 *  La foto del comprobante es OPCIONAL al registrar (Kenif, 2026-10-19: "igual
 *  que combustible"): el conductor tiene 24 horas para subirla desde el
 *  historial de compras en ruta; vencido el plazo, el worker de conciliación
 *  levanta la alerta comprobante_sin_foto. Cuando viene, va en una segunda
 *  petición, por el uuid de la compra, igual que en combustible (0109): si no
 *  hay señal, la compra y su foto quedan juntas en la cola del dispositivo y
 *  salen en orden cuando vuelve. */
export interface RenglonCompra {
  clave: string;
  presentacion: Presentacion;
  cantidad: string;
  precio: string;
  // true mientras el precio sea el que puso el catálogo (0121). Si la persona
  // lo tipea, deja de serlo y cambiar de proveedor ya no se lo pisa: manda lo
  // que dice la boleta.
  precioAuto: boolean;
}

/** "1 caja + 2 bolsas" (0120 la compra, 0131 el vale y la entrada): un
 *  renglón por envase, con su cantidad, su precio por bulto si el papel lo
 *  trae, y debajo la suma en litros (y en soles). El mismo bloque en los tres
 *  formularios, para que se lean igual. */
export function RenglonesUrea({
  renglones,
  setRenglones,
  activas,
  conPrecio,
  vigentePara,
  titulo,
}: {
  renglones: RenglonCompra[];
  setRenglones: React.Dispatch<React.SetStateAction<RenglonCompra[]>>;
  activas: PresentacionFila[];
  conPrecio: boolean;
  /** El precio de catálogo vigente para un envase (0121), si hay. */
  vigentePara?: (presentacion: string) => PrecioUrea | null;
  titulo: string;
}) {
  const envaseDe = (codigo: string) => activas.find((p) => p.codigo === codigo);
  const litrosDe = (r: RenglonCompra) => {
    const envase = envaseDe(r.presentacion);
    return envase && r.cantidad ? Number(r.cantidad) * Number(envase.litros) : 0;
  };
  const totalLitros = renglones.reduce((a, r) => a + litrosDe(r), 0);
  const totalSoles = renglones.reduce(
    (a, r) => a + (r.cantidad && r.precio ? Number(r.cantidad) * Number(r.precio) : 0),
    0
  );
  const codigosUsados = renglones.map((r) => r.presentacion);
  const { repetida } = estadoRenglones(renglones, conPrecio);
  const precioDe = (codigo: string) => {
    const v = vigentePara?.(codigo);
    return v ? String(Number(v.precio_por_bulto)) : "";
  };
  const actualizar = (clave: string, cambios: Partial<RenglonCompra>) =>
    setRenglones((rs) => rs.map((r) => (r.clave === clave ? { ...r, ...cambios } : r)));
  const agregar = () => {
    // Arranca en el primer envase que todavía no se usó: dos renglones del
    // mismo envase son uno solo.
    const libre = activas.find((p) => !codigosUsados.includes(p.codigo));
    setRenglones((rs) => [
      ...rs,
      nuevoRenglon(libre?.codigo ?? "", libre && conPrecio ? precioDe(libre.codigo) : ""),
    ]);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-gray-600">{titulo}</span>
      {renglones.map((r) => {
        const envase = envaseDe(r.presentacion);
        return (
          <div
            key={r.clave}
            className={`grid items-end gap-2 rounded-xl border border-slate-200 p-2 ${
              conPrecio
                ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_4.5rem_5.5rem_auto]"
                : "grid-cols-[minmax(0,1fr)_6rem_auto]"
            }`}
          >
            <label
              className={`flex flex-col text-xs gap-1 ${conPrecio ? "col-span-3 sm:col-span-1" : ""}`}
            >
              <span className="text-gray-500">Presentación</span>
              <select
                value={r.presentacion}
                onChange={(e) =>
                  actualizar(r.clave, {
                    presentacion: e.target.value,
                    ...(conPrecio && r.precioAuto ? { precio: precioDe(e.target.value) } : {}),
                  })
                }
                className="w-full min-w-0 rounded border border-gray-300 px-2 py-2 text-sm"
              >
                {activas.map((p) => (
                  <option key={p.codigo} value={p.codigo}>
                    {etiquetaPresentacion(p)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-xs gap-1">
              <span className="text-gray-500">Cantidad</span>
              <input
                type="number"
                min={1}
                value={r.cantidad}
                onChange={(e) => actualizar(r.clave, { cantidad: e.target.value })}
                className="w-full min-w-0 rounded border border-gray-300 px-2 py-2 text-sm"
              />
            </label>
            {conPrecio && (
              <label className="flex flex-col text-xs gap-1">
                <span className="text-gray-500">
                  S/ por {envase?.nombre.toLowerCase() ?? "bulto"}
                </span>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={r.precio}
                  onChange={(e) =>
                    actualizar(r.clave, { precio: e.target.value, precioAuto: false })
                  }
                  className="w-full min-w-0 rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
            )}
            <button
              type="button"
              onClick={() => setRenglones((rs) => rs.filter((x) => x.clave !== r.clave))}
              disabled={renglones.length === 1}
              title="Quitar renglón"
              aria-label="Quitar renglón"
              className="mb-1 p-2 text-slate-400 hover:text-red-600 disabled:opacity-30"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <div
              className={`${conPrecio ? "col-span-3 sm:col-span-4" : "col-span-3"} flex flex-wrap gap-x-3`}
            >
              {litrosDe(r) > 0 && (
                <span className="text-xs text-slate-500">
                  = {formatearNumero(String(litrosDe(r)))} L
                </span>
              )}
              {conPrecio && vigentePara && (
                <PistaPrecioCatalogo
                  vigente={vigentePara(r.presentacion)}
                  precioTipeado={r.precio}
                />
              )}
            </div>
          </div>
        );
      })}
      {renglones.length < Math.min(10, activas.length) && (
        <button
          type="button"
          onClick={agregar}
          className="inline-flex w-fit items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <Plus className="h-4 w-4" />
          Agregar otra presentación
        </button>
      )}
      {repetida && (
        <span className="text-xs text-red-600">
          La misma presentación está en dos renglones: súmalos en uno.
        </span>
      )}
      {totalLitros > 0 && (
        <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
          Total: <strong>{formatearNumero(String(totalLitros))} L</strong>
          {conPrecio && totalSoles > 0 && <> · S/ {formatearNumero(String(totalSoles), 2)}</>}
          {renglones.length > 1 && (
            <span className="block text-xs text-slate-500">
              {renglones
                .filter((r) => litrosDe(r) > 0)
                .map((r) => `${formatearNumero(String(litrosDe(r)))} L`)
                .join(" + ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ModalCompraUrea({
  equipos,
  grifos,
  presentaciones,
  precios,
  onCerrar,
  onCreado,
}: {
  equipos: Equipo[];
  grifos: Grifo[];
  presentaciones: PresentacionFila[];
  precios: PrecioUrea[];
  onCerrar: () => void;
  onCreado: (mensaje: string) => void;
}) {
  const [clienteUuid] = useState(() => crypto.randomUUID());
  const [equipoId, setEquipoId] = useState("");
  const [grifoId, setGrifoId] = useState("");
  const activas = presentacionesActivas(presentaciones);
  const [renglones, setRenglones] = useState<RenglonCompra[]>(() => [
    {
      clave: crypto.randomUUID(),
      presentacion: presentacionPorDefecto(presentaciones),
      cantidad: "",
      precio: "",
      precioAuto: true,
    },
  ]);
  const [comprobanteTipo, setComprobanteTipo] = useState<"boleta" | "factura">("boleta");
  const [comprobanteNumero, setComprobanteNumero] = useState("");
  const [foto, setFoto] = useState<File | null>(null);
  const [errorFoto, setErrorFoto] = useState<string | null>(null);
  const [despachadoEn, setDespachadoEn] = useState(ahoraParaInputLocal());
  const [observaciones, setObservaciones] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const equipoElegido = equipos.find((e) => String(e.id) === equipoId);
  const { listos: renglonesListos } = estadoRenglones(renglones, true);

  /** El precio de catálogo para un renglón, con el proveedor y la fecha que
   *  estén elegidos ahora. */
  const vigentePara = (presentacion: string, grifo = grifoId, fecha = despachadoEn) =>
    precioVigenteUrea(precios, grifo, presentacion, fecha);

  /** Rellena con el catálogo los renglones que todavía no se tocaron a mano.
   *  Se llama al cambiar el proveedor, la fecha o la presentación de un
   *  renglón -- nunca pisa un precio tipeado. */
  const autocompletar = (rs: RenglonCompra[], grifo: string, fecha: string) =>
    rs.map((r) => {
      if (!r.precioAuto) return r;
      const v = precioVigenteUrea(precios, grifo, r.presentacion, fecha);
      return { ...r, precio: v ? String(Number(v.precio_por_bulto)) : "" };
    });
  /** Mismo criterio que la foto de combustible: JPG/PNG o PDF, comprimida en
   *  el teléfono antes de subir (la señal en ruta es mala), máximo 6 MB. */
  const elegirFoto = async (archivo: File | undefined) => {
    setErrorFoto(null);
    if (!archivo) {
      setFoto(null);
      return;
    }
    if (!["image/jpeg", "image/png", "application/pdf"].includes(archivo.type)) {
      setErrorFoto("Solo se acepta foto (JPG/PNG) o PDF.");
      setFoto(null);
      return;
    }
    const lista = await comprimirImagen(archivo);
    if (lista.size > 6 * 1024 * 1024) {
      setErrorFoto("El archivo supera el máximo de 6 MB.");
      setFoto(null);
      return;
    }
    setFoto(lista);
  };

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/despachos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuid,
          producto: "urea",
          origen: "compra_externa",
          grifo_id: Number(grifoId),
          tipo_destino: "equipo",
          equipo_id: Number(equipoId),
          comprobante_tipo: comprobanteTipo,
          comprobante_numero: comprobanteNumero.trim(),
          // POR BULTO cada uno: el servidor resuelve el factor de cada
          // presentación, suma los litros y pasa el costo a por litro.
          lineas: renglones.map((r) => ({
            presentacion: r.presentacion,
            cantidad_bultos: Number(r.cantidad),
            costo_unitario: Number(r.precio),
          })),
          despachado_en: new Date(despachadoEn).toISOString(),
          observaciones: observaciones.trim() || undefined,
        }),
      });
      if (!res.ok && res.status !== 202) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo registrar la compra.");
        return;
      }

      // La foto, si la hay, va DESPUÉS y apunta a la compra por su uuid: sin
      // señal, la compra todavía no tiene id. La cola drena en orden.
      let resultadoFoto: "subida" | "encolada" | "fallo" | "sin_foto" = "sin_foto";
      if (foto) {
        const formData = new FormData();
        formData.append("archivo", foto);
        // El uuid de ESTA entrada de la cola, distinto al de la compra.
        formData.append("cliente_uuid", crypto.randomUUID());
        try {
          const rf = await apiFetch(
            `/api/erp/combustible/urea/compras/por-uuid/${clienteUuid}/comprobante`,
            { method: "POST", body: formData }
          );
          resultadoFoto = rf.status === 202 ? "encolada" : rf.ok ? "subida" : "fallo";
        } catch {
          resultadoFoto = "fallo";
        }
      }

      const papel = `la ${comprobanteTipo} ${comprobanteNumero.trim()}`;
      const mensaje =
        res.status === 202
          ? `Sin conexión: ${papel} quedó guardada en este equipo y se enviará sola${foto ? ", con su foto," : ""} cuando vuelva la señal.`
          : resultadoFoto === "sin_foto"
            ? `Compra registrada (${papel}). Tienes 24 horas para adjuntar la foto desde "Compras en ruta".`
            : resultadoFoto === "fallo"
              ? `Compra registrada (${papel}), pero la foto NO se pudo subir: adjuntala desde "Compras en ruta".`
              : resultadoFoto === "encolada"
                ? `Compra registrada (${papel}). La foto se enviará cuando vuelva la señal.`
                : `Compra registrada (${papel}), con su comprobante.`;
      onCreado(mensaje);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">Registrar compra de urea en ruta</h3>
        <p className="-mt-2 text-sm text-slate-500">
          Urea comprada en un grifo o proveedor durante el viaje, con boleta o factura.{" "}
          <strong>No baja el stock del almacén</strong>: nunca pasó por el depósito.
        </p>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}
        {activas.length === 0 && <AvisoSinEnvases />}

        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Unidad</span>
          <select
            value={equipoId}
            onChange={(e) => setEquipoId(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          >
            <option value="">Elegir unidad…</option>
            {equipos.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.placa_codigo} ({eq.tipo}){eq.usa_urea ? "" : " -- NO usa urea"}
              </option>
            ))}
          </select>
          <ConductorDeLaUnidad equipo={equipoElegido} />
          {equipoElegido && !equipoElegido.usa_urea && (
            <span className="text-xs text-amber-600">
              Esta unidad está marcada como que no usa urea. Igual se puede registrar, pero va a
              quedar como alerta para revisión.
            </span>
          )}
        </label>

        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Proveedor</span>
          <select
            value={grifoId}
            onChange={(e) => {
              setGrifoId(e.target.value);
              setRenglones((rs) => autocompletar(rs, e.target.value, despachadoEn));
            }}
            className="rounded border border-gray-300 px-3 py-2"
          >
            <option value="">Elegir proveedor…</option>
            {grifos.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nombre}
              </option>
            ))}
          </select>
          {grifos.length === 0 && <AvisoSinProveedores />}
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Comprobante</span>
            <select
              value={comprobanteTipo}
              onChange={(e) => setComprobanteTipo(e.target.value as "boleta" | "factura")}
              className="rounded border border-gray-300 px-3 py-2"
            >
              <option value="boleta">Boleta</option>
              <option value="factura">Factura</option>
            </select>
          </label>
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">N° de {comprobanteTipo}</span>
            <input
              value={comprobanteNumero}
              onChange={(e) => setComprobanteNumero(e.target.value)}
              placeholder="B001-00012345"
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>
        </div>

        <RenglonesUrea
          renglones={renglones}
          setRenglones={setRenglones}
          activas={activas}
          conPrecio
          vigentePara={(codigo) => vigentePara(codigo)}
          titulo="Qué se compró"
        />

        <div className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">
            Foto o PDF del comprobante (opcional ahora; tienes 24 horas para subirla)
          </span>
          <BotonArchivo archivo={foto} onElegir={elegirFoto} texto="Tomar o elegir foto" />
          {errorFoto && <span className="text-xs text-red-600">{errorFoto}</span>}
        </div>

        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Fecha y hora de la compra</span>
          <input
            type="datetime-local"
            value={despachadoEn}
            onChange={(e) => {
              setDespachadoEn(e.target.value);
              // El precio de catálogo es el de la fecha de la compra.
              setRenglones((rs) => autocompletar(rs, grifoId, e.target.value));
            }}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Observaciones</span>
          <input
            value={observaciones}
            onChange={(e) => setObservaciones(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={
              !equipoId || !grifoId || !renglonesListos || !comprobanteNumero.trim() || enviando
            }
            onClick={enviar}
            className="px-4 py-2 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d] rounded-xl text-sm font-semibold disabled:cursor-not-allowed"
          >
            {enviando ? "Guardando…" : "Registrar compra"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function ModalEntrada({
  grifos,
  presentaciones,
  precios,
  onCerrar,
  onCreado,
}: {
  grifos: Grifo[];
  presentaciones: PresentacionFila[];
  precios: PrecioUrea[];
  onCerrar: () => void;
  onCreado: () => void;
}) {
  const [clienteUuid] = useState(() => crypto.randomUUID());
  const [grifoId, setGrifoId] = useState("");
  const activas = presentacionesActivas(presentaciones);
  // Una factura con "20 cajas + 40 bolsas" es UNA entrada (0131), cada
  // renglón con su precio por bulto. Mismo criterio que la compra (0121): el
  // catálogo propone, la factura manda -- tipear un precio lo saca del
  // autocompletado.
  const [renglones, setRenglones] = useState<RenglonCompra[]>(() => [
    nuevoRenglon(presentacionPorDefecto(presentaciones)),
  ]);
  const { listos: renglonesListos } = estadoRenglones(renglones, true);
  const proponer = (grifo: string, fecha: string) =>
    setRenglones((rs) =>
      rs.map((r) => {
        if (!r.precioAuto) return r;
        const v = precioVigenteUrea(precios, grifo, r.presentacion, fecha);
        return { ...r, precio: v ? String(Number(v.precio_por_bulto)) : "" };
      })
    );
  const [tipoDocumento, setTipoDocumento] = useState<"" | "factura" | "guia_remision">("");
  const [numeroDocumento, setNumeroDocumento] = useState("");
  const [recibidoEn, setRecibidoEn] = useState(ahoraParaInputLocal());
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/recepciones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuid,
          producto: "urea",
          grifo_id: Number(grifoId),
          // POR BULTO cada uno: el servidor suma los litros y guarda el costo
          // por litro del total de la factura.
          lineas: renglones.map((r) => ({
            presentacion: r.presentacion,
            cantidad_bultos: Number(r.cantidad),
            costo_unitario: Number(r.precio),
          })),
          tipo_documento: tipoDocumento || undefined,
          numero_documento: numeroDocumento.trim() || undefined,
          recibido_en: new Date(recibidoEn).toISOString(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo registrar la entrada.");
        return;
      }
      onCreado();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">Registrar entrada de urea</h3>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}
        {activas.length === 0 && <AvisoSinEnvases />}
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Proveedor</span>
          <select
            value={grifoId}
            onChange={(e) => {
              setGrifoId(e.target.value);
              proponer(e.target.value, recibidoEn);
            }}
            className="rounded border border-gray-300 px-3 py-2"
          >
            <option value="">Elegir proveedor…</option>
            {grifos.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nombre}
              </option>
            ))}
          </select>
          {grifos.length === 0 && <AvisoSinProveedores />}
        </label>
        <RenglonesUrea
          renglones={renglones}
          setRenglones={setRenglones}
          activas={activas}
          conPrecio
          vigentePara={(codigo) => precioVigenteUrea(precios, grifoId, codigo, recibidoEn)}
          titulo="Qué llegó"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Documento</span>
            <select
              value={tipoDocumento}
              onChange={(e) => setTipoDocumento(e.target.value as typeof tipoDocumento)}
              className="rounded border border-gray-300 px-3 py-2"
            >
              <option value="">Sin documento</option>
              <option value="factura">Factura</option>
              <option value="guia_remision">Guía de remisión</option>
            </select>
          </label>
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">N° de documento</span>
            <input
              value={numeroDocumento}
              onChange={(e) => setNumeroDocumento(e.target.value)}
              disabled={!tipoDocumento}
              className="rounded border border-gray-300 px-3 py-2 disabled:bg-slate-50"
            />
          </label>
        </div>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Fecha y hora de la entrega</span>
          <input
            type="datetime-local"
            value={recibidoEn}
            onChange={(e) => {
              setRecibidoEn(e.target.value);
              // El precio de catálogo es el de la fecha de la entrega.
              proponer(grifoId, e.target.value);
            }}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={
              !renglonesListos ||
              !grifoId ||
              (!!tipoDocumento && !numeroDocumento.trim()) ||
              enviando
            }
            onClick={enviar}
            className="px-4 py-2 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d] rounded-xl text-sm font-semibold disabled:cursor-not-allowed"
          >
            {enviando ? "Guardando…" : "Registrar entrada"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function ModalConteo({
  presentaciones,
  onCerrar,
  onCreado,
}: {
  presentaciones: PresentacionFila[];
  onCerrar: () => void;
  onCreado: () => void;
}) {
  const [clienteUuid] = useState(() => crypto.randomUUID());
  const activas = presentacionesActivas(presentaciones);
  // Lo que hay en el almacén es "1 caja + 2 bolsas": un campo por presentación.
  // Vacío = no se contó esa presentación (cuenta como 0).
  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  const lineas = activas
    .filter((p) => cantidades[p.codigo] !== undefined && cantidades[p.codigo] !== "")
    .map((p) => ({ presentacion: p.codigo, cantidad_bultos: Number(cantidades[p.codigo]) }));
  // Lo que no está en un envase entero (una caja abierta, un balde a medias):
  // se anota en litros y suma al contado. Sin este campo, la caja abierta se
  // anotaba como entera o se perdía, y el conteo descuadraba por nada.
  const [suelto, setSuelto] = useState("");
  const sueltoL = suelto === "" ? 0 : Number(suelto);
  const sueltoValido = suelto === "" || (Number.isFinite(sueltoL) && sueltoL >= 0);
  const totalLitros =
    lineas.reduce(
      (t, l) =>
        t +
        l.cantidad_bultos * Number(activas.find((p) => p.codigo === l.presentacion)?.litros ?? 0),
      0
    ) + (sueltoValido ? sueltoL : 0);
  const [contadoEn, setContadoEn] = useState(ahoraParaInputLocal());
  const [observaciones, setObservaciones] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Solo suelto (todo lo que queda es una caja abierta): los envases enteros
  // van en cero -- vacío ya significa cero, esto solo lo dice explícito.
  const lineasAEnviar =
    lineas.length > 0 || sueltoL <= 0 || activas.length === 0
      ? lineas
      : [{ presentacion: activas[0].codigo, cantidad_bultos: 0 }];

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/urea/conteos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuid,
          lineas: lineasAEnviar,
          suelto_litros: sueltoL > 0 ? sueltoL : undefined,
          contado_en: new Date(contadoEn).toISOString(),
          observaciones: observaciones.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo registrar el conteo.");
        return;
      }
      onCreado();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">Registrar conteo físico de urea</h3>
        <p className="text-sm text-slate-500">
          Contá lo que queda en almacén AHORA MISMO, todas las presentaciones que haya (por ejemplo
          1 caja y 2 bolsas); las que no tengas, dejalas vacías. Es el reemplazo de la varilla del
          tanque: si no cuadra con lo que el sistema espera, va a quedar una alerta para revisar.
        </p>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}
        {activas.length === 0 && <AvisoSinEnvases />}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {activas.map((p) => (
            <label key={p.codigo} className="flex flex-col text-sm gap-1">
              <span className="text-gray-600">{etiquetaPresentacion(p)} contadas</span>
              <input
                type="number"
                min={0}
                step={1}
                value={cantidades[p.codigo] ?? ""}
                onChange={(e) => setCantidades((c) => ({ ...c, [p.codigo]: e.target.value }))}
                className="rounded border border-gray-300 px-3 py-2"
              />
            </label>
          ))}
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Suelto, en litros (caja abierta, balde a medias)</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={suelto}
              onChange={(e) => setSuelto(e.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>
        </div>
        <p className="text-sm text-slate-600">
          Total contado: <strong>{formatearNumero(String(totalLitros))} L</strong>
        </p>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Fecha y hora del conteo</span>
          <input
            type="datetime-local"
            value={contadoEn}
            onChange={(e) => setContadoEn(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Observaciones</span>
          <input
            value={observaciones}
            onChange={(e) => setObservaciones(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={lineasAEnviar.length === 0 || !sueltoValido || enviando}
            onClick={enviar}
            className="px-4 py-2 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d] rounded-xl text-sm font-semibold disabled:cursor-not-allowed"
          >
            {enviando ? "Guardando…" : "Registrar conteo"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

/** Alta de un envase. El `codigo` se pide acá y nunca más: es lo que queda
 *  escrito en cada movimiento y la mitad de la clave foránea, así que
 *  cambiarlo después rompería el vínculo con todo el historial que lo usa
 *  (ver el comentario de crearPresentacionUreaSchema). Se propone solo desde
 *  el nombre para que nadie tenga que entender qué es un código. */
function ModalCrearPresentacion({
  existentes,
  onCerrar,
  onCreado,
}: {
  existentes: PresentacionFila[];
  onCerrar: () => void;
  onCreado: () => void;
}) {
  const [nombre, setNombre] = useState("");
  const [codigo, setCodigo] = useState("");
  const [litros, setLitros] = useState("");
  const [esReferencia, setEsReferencia] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Minúsculas, sin espacios ni tildes -- el mismo regex que valida el
  // servidor (`^[a-z0-9_]{2,20}$`). Si el usuario no toca el campo, el
  // código sale del nombre; si lo toca, manda lo que escribió.
  const [codigoTocado, setCodigoTocado] = useState(false);
  const codigoSugerido = nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  const codigoFinal = codigoTocado ? codigo : codigoSugerido;

  const yaExiste = existentes.some((p) => p.codigo === codigoFinal);
  const referenciaActual = existentes.find((p) => p.es_referencia && p.activa);

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/urea/presentaciones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codigo: codigoFinal,
          nombre: nombre.trim(),
          litros: Number(litros),
          es_referencia: esReferencia,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo crear el envase.");
        return;
      }
      onCreado();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">Agregar envase de urea</h3>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Nombre</span>
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Bidón"
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Código interno</span>
          <input
            value={codigoFinal}
            onChange={(e) => {
              setCodigoTocado(true);
              setCodigo(e.target.value);
            }}
            placeholder="bidon"
            className="rounded border border-gray-300 px-3 py-2 font-mono text-sm"
          />
          <span className="text-xs text-slate-500">
            Minúsculas, sin espacios ni tildes. No se puede cambiar después: es lo que queda escrito
            en cada vale.
          </span>
          {yaExiste && (
            <span className="text-xs text-red-600">
              Ya hay un envase con este código en esta empresa.
            </span>
          )}
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Litros por bulto</span>
          <input
            type="number"
            step="0.01"
            min={0}
            value={litros}
            onChange={(e) => setLitros(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={esReferencia}
            onChange={(e) => setEsReferencia(e.target.checked)}
            className="mt-1"
          />
          <span className="text-gray-600">
            Envase principal: se abre primero en la estantería y viene elegido en los formularios
            {referenciaActual && (
              <>
                {" "}
                <strong>(hoy es {referenciaActual.nombre}; pasa a ser este)</strong>
              </>
            )}
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={
              !nombre.trim() ||
              codigoFinal.length < 2 ||
              yaExiste ||
              !litros ||
              Number(litros) <= 0 ||
              enviando
            }
            onClick={enviar}
            className="px-4 py-2 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d] rounded-xl text-sm font-semibold disabled:cursor-not-allowed"
          >
            {enviando ? "Guardando…" : "Agregar envase"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

/** Edición. El motivo es obligatorio siempre, no solo cuando cambian los
 *  litros: el nombre es lo que se lee en todo el historial y desactivar un
 *  envase saca movimientos nuevos de circulación -- las dos cosas merecen
 *  quedar explicadas en la bitácora. Cuando el cambio es de litros, el aviso
 *  de arriba dice exactamente qué se mueve y qué no. */
/** Dar de baja un envase con historial, o eliminar uno que nunca se usó. Los
 *  dos piden motivo (queda en la bitácora con el nombre de quien lo hizo): la
 *  baja saca el envase de los formularios de carga y eliminar borra la fila,
 *  así que ninguna de las dos pasa sin que alguien diga por qué. */
function ModalRetirarEnvase({
  fila,
  modo,
  onCerrar,
  onListo,
}: {
  fila: PresentacionFila;
  modo: "baja" | "eliminar";
  onCerrar: () => void;
  onListo: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esBaja = modo === "baja";

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const url = `/api/erp/combustible/urea/presentaciones/${fila.id}`;
      const res = esBaja
        ? await apiFetch(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              nombre: fila.nombre,
              litros: Number(fila.litros),
              es_referencia: fila.es_referencia,
              activa: false,
              motivo: motivo.trim(),
            }),
          })
        : await apiFetch(url, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ motivo: motivo.trim() }),
          });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          body?.error ??
            (esBaja ? "No se pudo dar de baja el envase." : "No se pudo eliminar el envase.")
        );
        return;
      }
      onListo();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">
          {esBaja ? "Dar de baja" : "Eliminar"} {fila.nombre}{" "}
          <span className="font-mono text-xs font-normal text-slate-400">({fila.codigo})</span>
        </h3>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {esBaja ? (
            <>
              Deja de ofrecerse en los formularios de carga. No borra nada: el historial que lo usó
              se sigue leyendo igual y se puede reactivar después. Solo se puede si no le quedan
              unidades en el almacén.
            </>
          ) : (
            <>
              Se elimina del catálogo. Es posible porque este envase nunca se usó: no hay ningún
              vale, entrada, conteo ni precio que lo mencione.
            </>
          )}
        </div>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Motivo</span>
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder={esBaja ? "Ya no se compra este envase" : "Se dio de alta por error"}
            className="rounded border border-gray-300 px-3 py-2"
          />
          <span className="text-xs text-slate-500">Queda en la bitácora con tu nombre.</span>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!motivo.trim() || enviando}
            onClick={enviar}
            className="px-4 py-2 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d] rounded-xl text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
          >
            {enviando
              ? esBaja
                ? "Dando de baja…"
                : "Eliminando…"
              : esBaja
                ? "Dar de baja"
                : "Eliminar envase"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function ModalEditarPresentacion({
  fila,
  onCerrar,
  onGuardado,
}: {
  fila: PresentacionFila;
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const [nombre, setNombre] = useState(fila.nombre);
  const [litros, setLitros] = useState(fila.litros);
  const [esReferencia, setEsReferencia] = useState(fila.es_referencia);
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Con movimientos, los litros quedan fijos (el servidor lo rechaza con 409):
  // la pantalla no ofrece un cambio que no se puede hacer.
  const litrosFijos = (fila.movimientos ?? 0) > 0;
  const litrosAntes = Number(fila.litros);
  const litrosAhora = Number(litros);
  const cambiaElFactor = Number.isFinite(litrosAhora) && litrosAhora !== litrosAntes;
  // El motivo solo se pide para lo que lo necesita: cambiar litros. La baja y
  // reactivar son acciones aparte, en la fila del envase.
  const pideMotivo = cambiaElFactor;

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/urea/presentaciones/${fila.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: nombre.trim(),
          litros: litrosAhora,
          es_referencia: esReferencia,
          activa: fila.activa,
          ...(pideMotivo ? { motivo: motivo.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo guardar el cambio.");
        return;
      }
      onGuardado();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Backdrop onCerrar={onCerrar}>
      <div className="p-6 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-slate-800">
          {fila.nombre}{" "}
          <span className="font-mono text-xs font-normal text-slate-400">({fila.codigo})</span>
        </h3>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}

        {cambiaElFactor && (
          <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Vas a pasar este envase de <strong>{formatearNumero(fila.litros, 2)} L</strong> a{" "}
            <strong>{formatearNumero(litros, 2)} L</strong>. Todavía no tiene movimientos, así que
            no cambia nada ya cargado. Queda en la bitácora con el motivo.
          </div>
        )}

        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Nombre</span>
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="text-gray-600">Litros por bulto</span>
          <input
            type="number"
            step="0.01"
            min={0}
            value={litros}
            disabled={litrosFijos}
            onChange={(e) => setLitros(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-60"
          />
          {litrosFijos && (
            <span className="text-xs text-slate-500">
              Fijo: este envase ya tiene {fila.movimientos}{" "}
              {fila.movimientos === 1 ? "movimiento" : "movimientos"} registrados con{" "}
              {formatearNumero(fila.litros, 2)} L. Si el envase cambió de tamaño, da de alta otro
              envase. Si fue un error al darlo de alta, se corrige con &quot;Corregir litros&quot;,
              que recalcula su historial con motivo (requiere ese permiso).
            </span>
          )}
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={esReferencia}
            onChange={(e) => setEsReferencia(e.target.checked)}
            className="mt-1"
          />
          <span className="text-gray-600">
            Envase principal: se abre primero en la estantería y viene elegido en los formularios
          </span>
        </label>
        {pideMotivo && (
          <label className="flex flex-col text-sm gap-1">
            <span className="text-gray-600">Motivo</span>
            <input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Se dio de alta con los litros mal"
              className="rounded border border-gray-300 px-3 py-2"
            />
            <span className="text-xs text-slate-500">Queda en la bitácora con tu nombre.</span>
          </label>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 text-slate-600 hover:bg-slate-50 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={
              !nombre.trim() ||
              (pideMotivo && !motivo.trim()) ||
              !litros ||
              !(litrosAhora > 0) ||
              enviando
            }
            onClick={enviar}
            className="px-4 py-2 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d] rounded-xl text-sm font-semibold disabled:cursor-not-allowed"
          >
            {enviando ? "Guardando…" : "Guardar cambio"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
