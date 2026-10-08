// client/src/components/equipos/EquiposTable.tsx
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  History,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import type { WorkBook } from "xlsx";

import ConductorUnidades from "./ConductorUnidades";
import EquipoIcono from "./EquipoIcono";
import {
  estadoDeUnidad,
  normalizarTexto,
  ordenarEquipos,
  sinConductor,
  sinRuta,
  textoBuscable,
  textoMedidor,
  textoTanque,
  type ColumnaOrden,
  type Equipo,
  type FocoFlota,
  type TamTarjeta,
  type VistaEquipos,
} from "./equiposVista";
import HistorialEquipo from "./HistorialEquipo";
import RutasEditor, { type LugarOpcion, type RutaForm } from "./RutasEditor";
import TarjetaEquipo, { EstadoUnidadBadge } from "./TarjetaEquipo";
import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";
import {
  BannerImportacion,
  BotonImportarExcel,
  ModalVistaPreviaImportacion,
  type ColumnaVistaPreviaExcel,
} from "../comunes/ImportarExcel";
import MoverDeGrifo from "../comunes/MoverDeGrifo";
import { useImportacionExcel, type UtilidadesXlsx } from "../comunes/useImportacionExcel";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";
import { useSedes } from "../comunes/useSedes";

/** La lista se trae ENTERA (de a 200 por pedido): el resumen, los filtros por
 *  tipo y el orden necesitan ver toda la flota, no solo una página. */
const TAMANO_PEDIDO = 200;
const MAX_PEDIDOS = 10;
/** Espejo del tope de ids del export en equipos.controller.ts. */
const MAX_IDS_EXPORT = 1000;

/** Ancho mínimo de cada tarjeta, por tamaño. */
const COLUMNA_TARJETA: Record<TamTarjeta, number> = { amplia: 380, normal: 300, compacta: 215 };

const CLAVE_PREFERENCIA = "mincore.equipos.";
function leerPreferencia<T extends string>(clave: string, validos: readonly T[], porDefecto: T): T {
  try {
    const v = localStorage.getItem(CLAVE_PREFERENCIA + clave);
    return validos.includes(v as T) ? (v as T) : porDefecto;
  } catch {
    return porDefecto;
  }
}
function guardarPreferencia(clave: string, valor: string) {
  try {
    localStorage.setItem(CLAVE_PREFERENCIA + clave, valor);
  } catch {
    /* sin almacenamiento: la preferencia solo dura esta visita */
  }
}

const TIPOS_COMUNES = [
  "Camioneta",
  "Cargador frontal",
  "Camión baranda",
  "Tracto remolcadores",
  "Excavadora",
  "Retroexcavadora",
  "Volquete",
  "Tráiler",
  "Carretas",
  "Bombona",
  "Perforadora",
  "Otro",
];

/** Medidor que le corresponde a cada tipo de unidad (pedido del cliente):
 *  horómetro en volquete, excavadora y retroexcavadora; odómetro en camioneta y
 *  tracto remolcador; bombona y carreta no llevan. Es una PRECARGA al elegir el
 *  tipo, editable: una empresa con otros tipos no recibe nada y lo elige a mano.
 *
 *  La capacidad del tanque NO se precarga: no hay dato real todavía y un número
 *  de catálogo guardado sin mirar parecería un dato verdadero (queda vacía hasta
 *  que se cargue a mano). */
const MEDIDOR_POR_TIPO: Record<string, "horometro" | "odometro" | ""> = {
  Volquete: "horometro",
  Excavadora: "horometro",
  Retroexcavadora: "horometro",
  Camioneta: "odometro",
  "Tracto remolcadores": "odometro",
  Bombona: "",
  Carretas: "",
};

const ETIQUETA_TIPO_MEDIDOR: Record<"" | "horometro" | "odometro", string> = {
  "": "Sin medidor / no configurado",
  horometro: "Horómetro (horas de motor)",
  odometro: "Odómetro (kilometraje)",
};

/** Espejo de MAX_FILAS_CARGA_MASIVA_EQUIPOS en server/schemas/equipos.schema.ts.
 *  Duplicarlo permite avisar ANTES de mandar miles de filas al servidor
 *  para que las rechace; el servidor sigue siendo el que decide. */
const MAX_FILAS_IMPORTACION = 5000;

type FilaPlanillaEquipo = {
  placa_codigo: string;
  tipo: string;
  marca?: string;
  modelo?: string;
  codigo_interno?: string;
};

/** Encabezados que puede traer la columna de TIPO/PLACA/CODIGO/MARCA/MODELO
 *  en la planilla real de flota (ver DATOS DE FLOTA_SANTA ISABEL.xlsx): busca
 *  por coincidencia parcial porque el cliente no siempre escribe el
 *  encabezado igual ("PLACA " con espacio, "TIPO DE UNIDAD" en vez de
 *  "TIPO"). */
function indiceDeColumna(encabezados: unknown[], candidatos: string[]): number {
  return encabezados.findIndex((c) => {
    const texto = String(c ?? "")
      .trim()
      .toUpperCase();
    return candidatos.some((cand) => texto.includes(cand));
  });
}

/** Convierte la hoja cruda (array de arrays) en filas de equipo.
 *
 *  La planilla real trae el TIPO en celdas COMBINADAS: SheetJS solo pone el
 *  valor en la primera fila de cada grupo y deja las demás vacías -- hay que
 *  "rellenar hacia abajo" a mano, si no cada equipo del grupo queda sin
 *  tipo. También hay filas de título ("REGISTRO DE FLOTA...") y una fila de
 *  encabezado en el medio del archivo: se busca la fila que tiene "PLACA"
 *  y se arranca a leer desde la siguiente. */
function parsearPlanillaEquipos(libro: WorkBook, utils: UtilidadesXlsx): FilaPlanillaEquipo[] {
  const ws = libro.Sheets[libro.SheetNames[0]];
  if (!ws) throw new Error("El archivo no tiene ninguna hoja de cálculo.");
  // header: 1 (array de arrays), no el modo objeto por nombre de columna:
  // es lo que permite rellenar el TIPO hacia abajo antes de saber qué fila
  // es cada equipo.
  const filasCrudas: unknown[][] = utils.sheet_to_json(ws, { header: 1 });
  const indiceEncabezado = filasCrudas.findIndex((fila) =>
    fila.some((c) =>
      String(c ?? "")
        .toUpperCase()
        .includes("PLACA")
    )
  );
  if (indiceEncabezado === -1) {
    throw new Error(
      'No se encontró una columna "Placa" en la planilla. Revisá que tenga los encabezados TIPO/PLACA/MARCA/MODELO.'
    );
  }
  const encabezados = filasCrudas[indiceEncabezado];
  const colTipo = indiceDeColumna(encabezados, ["TIPO"]);
  const colPlaca = indiceDeColumna(encabezados, ["PLACA"]);
  const colMarca = indiceDeColumna(encabezados, ["MARCA"]);
  const colModelo = indiceDeColumna(encabezados, ["MODELO"]);
  const colCodigo = indiceDeColumna(encabezados, ["CODIGO", "CÓDIGO"]);
  if (colPlaca === -1) {
    throw new Error('No se encontró la columna "Placa" en la planilla.');
  }

  const filas: FilaPlanillaEquipo[] = [];
  let ultimoTipo = "";
  for (const fila of filasCrudas.slice(indiceEncabezado + 1)) {
    const tipoCelda = colTipo === -1 ? "" : String(fila[colTipo] ?? "").trim();
    if (tipoCelda !== "") ultimoTipo = tipoCelda;
    const placa = String(fila[colPlaca] ?? "").trim();
    if (placa === "") continue; // fila vacía o de separador de grupo

    filas.push({
      placa_codigo: placa,
      tipo: ultimoTipo || "Otro",
      marca: colMarca === -1 ? undefined : String(fila[colMarca] ?? "").trim() || undefined,
      modelo: colModelo === -1 ? undefined : String(fila[colModelo] ?? "").trim() || undefined,
      codigo_interno:
        colCodigo === -1 ? undefined : String(fila[colCodigo] ?? "").trim() || undefined,
    });
  }
  return filas;
}

export default function EquiposTable() {
  const puedeEscribir = usePuedeEscribir("equipos");
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  // La vista abre en TABLA (con cientos de unidades las tarjetas obligan a
  // recorrer demasiado); cada persona recuerda la que eligió por último.
  const [vista, setVista] = useState<VistaEquipos>(() =>
    leerPreferencia<VistaEquipos>("vista", ["tabla", "tarjetas"], "tabla")
  );
  const [tam, setTam] = useState<TamTarjeta>(() =>
    leerPreferencia<TamTarjeta>("tam", ["amplia", "normal", "compacta"], "normal")
  );
  const [tipoFiltro, setTipoFiltro] = useState("");
  const [foco, setFoco] = useState<FocoFlota>("todos");
  const [orden, setOrden] = useState<{ col: ColumnaOrden | null; dir: 1 | -1 }>({
    col: null,
    dir: 1,
  });
  const [errorCarga, setErrorCarga] = useState(false);
  const [flotaIncompleta, setFlotaIncompleta] = useState(false);
  const [conductorVer, setConductorVer] = useState<{ dni: string; nombre: string } | null>(null);
  const [enviando, setEnviando] = useState(false);

  // 📦 EXPORTAR (Excel) -- IMPORTAR vive en `importacion` más abajo, con el
  // hook compartido de los tres módulos que tienen esta pantalla.
  const [exportando, setExportando] = useState(false);

  // ☑️ SELECCIÓN MÚLTIPLE + ELIMINACIÓN MASIVA
  const [seleccionados, setSeleccionados] = useState<Set<number>>(new Set());
  const [eliminandoMasivo, setEliminandoMasivo] = useState(false);

  // El cliente_uuid se fija al ABRIR el modal para CREAR (no al apretar el
  // botón): un doble tap en la tablet antes del re-render mandaría DOS
  // claves distintas si se generara en el submit, y el servidor no tendría
  // forma de distinguir eso de dos equipos legítimos. Editar no usa
  // idempotencia (sobreescribe campos existentes), así que abrir el modal
  // para editar no toca este valor -- ver el mismo comentario en
  // CombustiblePanel.tsx.
  const [clienteUuid, setClienteUuid] = useState("");

  // El texto de la sugerencia de consumo (5ª auditoría). Se muestra, NUNCA
  // se aplica solo: la muestra puede incluir el robo que se quiere detectar.
  const [sugerenciaConsumo, setSugerenciaConsumo] = useState<string | null>(null);

  // Sedes y grifos internos (0097): con uno solo, nada de esto se ve. El grifo
  // del alta va APARTE del formulario: el PUT manda el formulario entero y el
  // servidor rechaza un grifo ahí (cambiarlo es "Mover de grifo").
  const grifosInternos = useSedes();
  const [grifoAlta, setGrifoAlta] = useState("");
  const [filtroGrifo, setFiltroGrifo] = useState("");
  const [equipoAMover, setEquipoAMover] = useState<Equipo | null>(null);
  // Conductor y rutas con historial (0126).
  const [equipoHistorial, setEquipoHistorial] = useState<Equipo | null>(null);
  const [lugares, setLugares] = useState<LugarOpcion[]>([]);
  const [formRutas, setFormRutas] = useState<RutaForm[]>([]);
  const [motivoCambio, setMotivoCambio] = useState("");
  const [formData, setFormData] = useState({
    placa_codigo: "",
    codigo_interno: "",
    tipo: TIPOS_COMUNES[0],
    marca: "",
    modelo: "",
    tipo_medidor: "" as "" | "horometro" | "odometro",
    capacidad_tanque: "",
    capacidad_tanque_unidad: "L" as "gal" | "L",
    consumo_maximo_l: "",
    conductor_nombre: "",
    conductor_dni: "",
  });

  const fetchEquipos = useCallback(async () => {
    try {
      const todos: Equipo[] = [];
      let paginas = 1;
      for (let pedido = 1; pedido <= Math.min(paginas, MAX_PEDIDOS); pedido++) {
        const res = await apiFetch(`/api/erp/equipos?page=${pedido}&pageSize=${TAMANO_PEDIDO}`);
        // Una flota a medias daría un resumen falso ("3 sin conductor" cuando
        // son 30): si un pedido falla, se queda la lista anterior y se avisa.
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        todos.push(...(Array.isArray(body.data) ? (body.data as Equipo[]) : []));
        paginas = body.pagination?.totalPages ?? 1;
      }
      setEquipos(todos);
      setFlotaIncompleta(paginas > MAX_PEDIDOS);
      setErrorCarga(false);
    } catch (err) {
      console.error("Error al obtener equipos:", err);
      setErrorCarga(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // El catálogo de lugares (el de Viajes) para el selector de ruta. Si falla, el
  // formulario sigue funcionando sin rutas: no bloquea cargar un equipo.
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch("/api/erp/equipos/lugares");
        if (res.ok) setLugares(await res.json());
      } catch {
        /* sin lugares no hay selector de ruta, nada más */
      }
    })();
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar (setLoading(true) -> fetch ->
    // setLoading(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchEquipos();
  }, [fetchEquipos]);

  // Cuando la cola offline termina de drenar, los equipos que se dieron de
  // alta sin señal ya existen del lado del servidor -- recargar es lo que
  // hace que aparezcan en el listado sin que el operario tenga que
  // refrescar a mano.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) fetchEquipos();
    });
  }, [fetchEquipos]);

  /** Pide al servidor el consumo sugerido para ESTE equipo, con su muestra.
   *  Igual que el asistente de umbrales del tanque: propone, no aplica. */
  const sugerirConsumo = async (equipoId: number) => {
    setSugerenciaConsumo("Calculando...");
    try {
      const res = await apiFetch(`/api/erp/combustible/equipos/${equipoId}/sugerencia-consumo`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        setSugerenciaConsumo("No se pudo calcular la sugerencia.");
        return;
      }
      if (!body.muestraSuficiente) {
        setSugerenciaConsumo(
          `Todavía no alcanza: hay ${body.tamanioMuestra} carga(s) con medidor y hacen falta ` +
            `${body.minimoRequerido}. Con menos, cualquier número sería inventado.`
        );
        return;
      }
      setSugerenciaConsumo(
        `Sugerencia: ${body.sugerido} L/${body.unidadMedida} — calculada con ${body.tamanioMuestra} ` +
          `cargas de esta unidad (consume ${body.promedio} L/${body.unidadMedida} en promedio). ` +
          `Si la unidad venía perdiendo combustible, ese consumo ya está adentro del promedio.`
      );
      setFormData((previo) => ({ ...previo, consumo_maximo_l: String(body.sugerido) }));
    } catch {
      setSugerenciaConsumo("No se pudo calcular la sugerencia.");
    }
  };

  const openEditModal = (e: Equipo) => {
    setEditingId(e.id);
    setSugerenciaConsumo(null);
    setFormData({
      placa_codigo: e.placa_codigo,
      codigo_interno: e.codigo_interno ?? "",
      tipo: e.tipo,
      marca: e.marca ?? "",
      modelo: e.modelo ?? "",
      tipo_medidor: e.tipo_medidor ?? "",
      capacidad_tanque: e.capacidad_tanque ?? "",
      consumo_maximo_l: e.consumo_maximo_l ?? "",
      conductor_nombre: e.conductor_nombre ?? "",
      conductor_dni: e.conductor_dni ?? "",
      capacidad_tanque_unidad: e.capacidad_tanque_unidad ?? "L",
    });
    setFormRutas(
      (e.rutas ?? []).map((r) => ({
        origen_id: String(r.origen_id),
        destino_id: String(r.destino_id),
      }))
    );
    setMotivoCambio("");
    setIsModalOpen(true);
  };

  // ¿Cambió el conductor o las rutas respecto de lo guardado? Entonces el
  // servidor exige el motivo (queda en el historial y en la bitácora).
  const equipoEnEdicion = editingId === null ? null : equipos.find((x) => x.id === editingId);
  const conductorCambio =
    !!equipoEnEdicion &&
    (formData.conductor_nombre.trim() !== (equipoEnEdicion.conductor_nombre ?? "") ||
      formData.conductor_dni.trim() !== (equipoEnEdicion.conductor_dni ?? ""));
  const clavesRutas = (rs: { origen_id: unknown; destino_id: unknown }[]) =>
    rs
      .map((r) => `${r.origen_id}>${r.destino_id}`)
      .sort()
      .join("|");
  const rutasCambiaron =
    !!equipoEnEdicion && clavesRutas(formRutas) !== clavesRutas(equipoEnEdicion.rutas ?? []);
  const exigeMotivo = conductorCambio || rutasCambiaron;

  const handleDelete = async (id: number) => {
    if (!window.confirm("¿Estás seguro de que deseas eliminar este equipo?")) return;
    try {
      const res = await apiFetch(`/api/erp/equipos/${id}`, { method: "DELETE" });
      if (res.ok) {
        setSeleccionados((prev) => {
          const copia = new Set(prev);
          copia.delete(id);
          return copia;
        });
        fetchEquipos();
      } else {
        alert("Error: el servidor no permitió eliminar el equipo.");
      }
    } catch {
      alert("Error de conexión con el backend.");
    }
  };

  // Filtros y orden -- se definen acá (y no junto al JSX) porque "seleccionar
  // todo" y el export necesitan saber qué filas están visibles ANTES del return.
  const termino = searchTerm.trim().toLowerCase();
  const filteredEquipos = ordenarEquipos(
    equipos.filter(
      (e) =>
        (tipoFiltro === "" || normalizarTexto(e.tipo) === tipoFiltro) &&
        (foco === "todos" || (foco === "sinConductor" ? sinConductor(e) : sinRuta(e))) &&
        (termino === "" || textoBuscable(e).includes(termino)) &&
        // El filtro por grifo (0097) solo existe con más de un grifo.
        (!grifosInternos.hayVarios ||
          filtroGrifo === "" ||
          e.grifo_interno_id === Number(filtroGrifo))
    ),
    orden.col,
    orden.dir
  );
  const hayFiltros = filteredEquipos.length !== equipos.length;

  const totalActivas = equipos.filter((e) => estadoDeUnidad(e) === "Activo").length;
  const totalSinConductor = equipos.filter(sinConductor).length;
  const totalSinRuta = equipos.filter(sinRuta).length;
  // Un chip por tipo. "EXCAVADORA" de una planilla y "Excavadora" escrito a
  // mano son el mismo tipo: se agrupan sin mayúsculas ni tildes.
  const tiposPresentes = new Map<string, { etiqueta: string; cantidad: number }>();
  for (const e of equipos) {
    const clave = normalizarTexto(e.tipo);
    const previo = tiposPresentes.get(clave);
    if (previo) previo.cantidad += 1;
    else tiposPresentes.set(clave, { etiqueta: e.tipo, cantidad: 1 });
  }
  const chipsTipo = [...tiposPresentes.entries()].sort((a, b) =>
    a[1].etiqueta.localeCompare(b[1].etiqueta, "es")
  );

  const ordenarPor = (col: ColumnaOrden) =>
    setOrden((previo) =>
      previo.col !== col
        ? { col, dir: 1 }
        : previo.dir === 1
          ? { col, dir: -1 }
          : { col: null, dir: 1 }
    );
  const encabezadoOrden = (col: ColumnaOrden, texto: string) => (
    <th
      key={col}
      aria-sort={orden.col === col ? (orden.dir === 1 ? "ascending" : "descending") : undefined}
      className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-[#94a3b8] uppercase tracking-widest sticky top-0 z-10 bg-[#192526] border-b border-[#2a2e37] whitespace-nowrap"
    >
      <button
        type="button"
        onClick={() => ordenarPor(col)}
        className={`inline-flex items-center gap-1.5 uppercase tracking-widest hover:text-white ${
          orden.col === col ? "text-[#BADC1E]" : ""
        }`}
      >
        {texto}
        {orden.col !== col ? (
          <ArrowUpDown className="w-3 h-3 opacity-50" aria-hidden="true" />
        ) : orden.dir === 1 ? (
          <ArrowUp className="w-3 h-3" aria-hidden="true" />
        ) : (
          <ArrowDown className="w-3 h-3" aria-hidden="true" />
        )}
      </button>
    </th>
  );

  const cambiarVista = (v: VistaEquipos) => {
    setVista(v);
    guardarPreferencia("vista", v);
  };
  const cambiarTam = (t: TamTarjeta) => {
    setTam(t);
    guardarPreferencia("tam", t);
  };
  const verConductor = (e: Equipo) => {
    if (e.conductor_dni)
      setConductorVer({ dni: e.conductor_dni, nombre: e.conductor_nombre ?? "" });
  };

  // ☑️ Selección múltiple: por fila, y "seleccionar todo" cubre solo lo que
  // se ve. Lo marcado que un filtro deja oculto NO cuenta ni se borra: si no,
  // marcar tres volquetes, pasar al chip Camioneta y "Eliminar seleccionados"
  // borraría unidades que el usuario ya no tiene delante.
  const idsVisibles = new Set(filteredEquipos.map((e) => e.id));
  const seleccionVisible = [...seleccionados].filter((id) => idsVisibles.has(id));
  const toggleSeleccion = (id: number) => {
    setSeleccionados((prev) => {
      const copia = new Set(prev);
      if (copia.has(id)) copia.delete(id);
      else copia.add(id);
      return copia;
    });
  };

  const todosSeleccionadosEnPagina =
    filteredEquipos.length > 0 && filteredEquipos.every((e) => seleccionados.has(e.id));

  const toggleSeleccionarTodo = () => {
    setSeleccionados((prev) => {
      const idsPagina = filteredEquipos.map((e) => e.id);
      const todosMarcados = idsPagina.length > 0 && idsPagina.every((id) => prev.has(id));
      const copia = new Set(prev);
      if (todosMarcados) {
        idsPagina.forEach((id) => copia.delete(id));
      } else {
        idsPagina.forEach((id) => copia.add(id));
      }
      return copia;
    });
  };

  const handleEliminarSeleccionados = async () => {
    const ids = seleccionVisible;
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `¿Eliminar ${ids.length} equipo${ids.length === 1 ? "" : "s"} seleccionado${ids.length === 1 ? "" : "s"}? Esta acción no se puede deshacer.`
      )
    )
      return;
    setEliminandoMasivo(true);
    try {
      const res = await apiFetch("/api/erp/equipos/bulk", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        alert(error.message || "No se pudieron eliminar los equipos seleccionados.");
        return;
      }
      setSeleccionados(new Set());
      fetchEquipos();
    } catch {
      alert("Error de conexión con el backend.");
    } finally {
      setEliminandoMasivo(false);
    }
  };

  // 📥 Importar planilla de flota (.xlsx) -- hook compartido con Repuestos y
  // Combustible: se lee y se parsea acá, pero el POST /bulk solo se manda si
  // el usuario confirma la vista previa (ModalVistaPreviaImportacion, más
  // abajo en el JSX).
  const importacion = useImportacionExcel<FilaPlanillaEquipo>({
    endpoint: "/api/erp/equipos/bulk",
    parsear: parsearPlanillaEquipos,
    maxFilas: MAX_FILAS_IMPORTACION,
    etiquetaEntidad: "equipos",
    onImportado: () => {
      void fetchEquipos();
    },
  });

  const columnasVistaPreviaEquipos: ColumnaVistaPreviaExcel<FilaPlanillaEquipo>[] = [
    { encabezado: "Placa", render: (f) => f.placa_codigo },
    { encabezado: "Código", render: (f) => f.codigo_interno || "---" },
    { encabezado: "Tipo", render: (f) => f.tipo },
    { encabezado: "Marca", render: (f) => f.marca || "---" },
    { encabezado: "Modelo", render: (f) => f.modelo || "---" },
  ];

  // 📤 Exportar a Excel lo que se está viendo: con filtros puestos viajan solo
  // los ids de esas unidades; sin filtros, la flota entera.
  const handleExportExcel = async () => {
    setExportando(true);
    try {
      // Los ids viajan en la URL (GET: Lectura también exporta, y su perfil no
      // admite POST). Más de MAX_IDS_EXPORT la haría demasiado larga.
      if (hayFiltros && filteredEquipos.length > MAX_IDS_EXPORT) {
        alert(
          `Hay ${filteredEquipos.length} unidades filtradas: para exportar de a más de ${MAX_IDS_EXPORT}, ` +
            "quita los filtros y exporta la flota entera."
        );
        return;
      }
      const url = hayFiltros
        ? `/api/erp/equipos/export/xlsx?ids=${filteredEquipos.map((e) => e.id).join(",")}`
        : "/api/erp/equipos/export/xlsx";
      const res = await apiFetch(url);
      if (!res.ok) {
        alert("No se pudo generar el archivo de exportación.");
        return;
      }
      const blob = await res.blob();
      const enlace = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = enlace;
      a.download = "equipos.xlsx";
      a.click();
      URL.revokeObjectURL(enlace);
    } catch {
      alert("Error de conexión con el backend.");
    } finally {
      setExportando(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    const url = editingId ? `/api/erp/equipos/${editingId}` : "/api/erp/equipos";
    const method = editingId ? "PUT" : "POST";
    // "" no es un valor válido del enum -- Zod lo rechazaría (esperaba
    // "horometro"/"odometro"/undefined, ver equipos.schema.ts). undefined
    // sí es "no configurado" para el servidor.
    // Capacidad vacía = "sin configurar": los DOS campos tienen que irse
    // como undefined, no solo el número -- el schema los exige de a pares
    // (espejo del CHECK de migrations/0069).
    const capacidadCargada = formData.capacidad_tanque.trim() !== "";
    // Una ruta a medio elegir no se manda ni se descarta en silencio: se avisa.
    if (formRutas.some((r) => (r.origen_id === "") !== (r.destino_id === ""))) {
      alert("Hay una ruta con solo origen o solo destino: completala o quitala.");
      return;
    }
    if (editingId && exigeMotivo && motivoCambio.trim() === "") {
      alert("Indicá el motivo del cambio de conductor o rutas: queda en el historial.");
      return;
    }
    const rutasValidas = formRutas
      .filter((r) => r.origen_id !== "" && r.destino_id !== "")
      .map((r) => ({ origen_id: Number(r.origen_id), destino_id: Number(r.destino_id) }));
    const datosFormulario = {
      ...formData,
      tipo_medidor: formData.tipo_medidor === "" ? undefined : formData.tipo_medidor,
      capacidad_tanque: capacidadCargada ? Number(formData.capacidad_tanque) : undefined,
      // Vacío = sin configurar = no alerta. Se manda null explícito (y no
      // undefined) para poder QUITARLO: el PUT reemplaza la fila entera.
      consumo_maximo_l:
        formData.consumo_maximo_l.trim() === "" ? null : Number(formData.consumo_maximo_l),
      capacidad_tanque_unidad: capacidadCargada ? formData.capacidad_tanque_unidad : undefined,
      // Vacío = sin cargar, no se manda: el schema los tiene opcionales y un
      // string vacío fallaría el min(1).
      conductor_nombre: formData.conductor_nombre.trim() || undefined,
      conductor_dni: formData.conductor_dni.trim() || undefined,
      codigo_interno: formData.codigo_interno.trim() || undefined,
      rutas: rutasValidas,
      // Solo al EDITAR y solo si cambió el conductor o las rutas.
      motivo_cambio: editingId && exigeMotivo ? motivoCambio.trim() : undefined,
    };
    // cliente_uuid solo viaja al crear -- editar no pasa por
    // idempotentInsert() del lado del servidor.
    const body = editingId
      ? datosFormulario
      : {
          ...datosFormulario,
          cliente_uuid: clienteUuid,
          // Con un solo grifo lo asigna el servidor (0097).
          grifo_interno_id:
            grifosInternos.hayVarios && grifoAlta !== "" ? Number(grifoAlta) : undefined,
        };
    setEnviando(true);
    try {
      const res = await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        alert(error.error || error.message || "Error: revisa los datos del equipo.");
        return;
      }

      setIsModalOpen(false);
      setEditingId(null);
      setFormData({
        placa_codigo: "",
        codigo_interno: "",
        tipo: TIPOS_COMUNES[0],
        marca: "",
        modelo: "",
        tipo_medidor: "",
        capacidad_tanque: "",
        capacidad_tanque_unidad: "L",
        consumo_maximo_l: "",
        conductor_nombre: "",
        conductor_dni: "",
      });
      setFormRutas([]);
      setMotivoCambio("");

      // 202 = no había red y quedó en la cola del dispositivo (ver
      // apiFetch). No se recarga: sin señal el GET también falla, y el
      // equipo todavía no existe del lado del servidor.
      if (res.status === 202) {
        // "en este dispositivo" y no "en este equipo" -- acá "equipo" es el
        // propio recurso que se está creando, "guardado en este equipo"
        // sería ambiguo. Mismo mensaje que el resto de los módulos, solo
        // con ese sustituto.
        alert(
          "Sin conexión: el equipo quedó guardado en este dispositivo y se enviará solo cuando vuelva la señal."
        );
        return;
      }

      fetchEquipos();
    } catch {
      alert("Error de conexión con el backend.");
    } finally {
      setEnviando(false);
    }
  };

  if (loading) return <div className="p-20 text-center text-[#94a3b8]">Cargando...</div>;

  return (
    <div className="p-2 sm:p-4 lg:p-8 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 lg:gap-6 mb-6 lg:mb-10">
        <div>
          <h1 className="text-lg sm:text-xl lg:text-2xl font-bold text-white tracking-tight">
            Equipos
          </h1>
          <p className="text-xs sm:text-sm text-[#94a3b8]">
            Maestro de la flota: datos de cada unidad, su conductor y sus rutas, con historial
          </p>
        </div>
        <div className="flex  flex-wrap items-center gap-3">
          {puedeEscribir && (
            <BotonImportarExcel cargando={importacion.cargando} onFile={importacion.handleFile} />
          )}
          <button
            type="button"
            onClick={handleExportExcel}
            disabled={exportando || filteredEquipos.length === 0}
            className="px-4 py-2.5 border rounded-xl flex items-center gap-2 transition-all border-[#334155] text-[#cbd5e1] hover:text-white hover:bg-[#1f2e2b] disabled:opacity-50 disabled:cursor-wait"
          >
            <Download className="w-4 h-4 shrink-0" />
            <span>
              {exportando
                ? "Exportando..."
                : hayFiltros
                  ? `Exportar Excel (${filteredEquipos.length})`
                  : "Exportar Excel"}
            </span>
          </button>
          {puedeEscribir && (
            <button
              onClick={() => {
                setEditingId(null);
                setFormData({
                  placa_codigo: "",
                  codigo_interno: "",
                  tipo: TIPOS_COMUNES[0],
                  marca: "",
                  modelo: "",
                  tipo_medidor: "",
                  capacidad_tanque: "",
                  capacidad_tanque_unidad: "L",
                  consumo_maximo_l: "",
                  conductor_nombre: "",
                  conductor_dni: "",
                });
                setGrifoAlta("");
                setFormRutas([]);
                setMotivoCambio("");
                // Se regenera en cada apertura: si no, el segundo equipo
                // legítimo que se registre reusaría la clave del primero y el
                // servidor devolvería aquel en silencio -- se perdería un
                // registro, que es peor que el duplicado que esto evita.
                setClienteUuid(crypto.randomUUID());
                setIsModalOpen(true);
              }}
              className="flex items-center gap-2 px-6 py-2.5 bg-[#BADC1E] text-[#0D1719] font-bold rounded-xl hover:brightness-110 transition-all"
            >
              <Plus className="w-4 h-4 shrink-0" />
              Nuevo Equipo
            </button>
          )}
        </div>
      </div>

      <BannerImportacion error={importacion.error} resultado={importacion.resultado} />
      {errorCarga && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-[#f0b429]/40 bg-[#192526] px-4 py-3 text-sm text-[#f0b429]"
        >
          No se pudo cargar la flota completa. Lo que ves puede estar desactualizado: recarga la
          página.
        </div>
      )}
      {flotaIncompleta && (
        <div className="mb-4 rounded-xl border border-[#f0b429]/40 bg-[#192526] px-4 py-3 text-sm text-[#f0b429]">
          Se muestran las primeras {MAX_PEDIDOS * TAMANO_PEDIDO} unidades: el resumen y los filtros
          cuentan solo esas.
        </div>
      )}

      {/* Resumen de la flota: cada celda con faltantes filtra la lista. */}
      <section
        aria-label="Resumen de la flota"
        className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5"
      >
        <CeldaResumen etiqueta="Unidades" valor={equipos.length} detalle="en la flota" />
        <CeldaResumen etiqueta="Activas" valor={totalActivas} detalle="con conductor vigente" />
        <CeldaResumen
          etiqueta="Sin conductor"
          valor={totalSinConductor}
          detalle={totalSinConductor > 0 ? "unidades por asignar" : "todas asignadas"}
          alerta={totalSinConductor > 0}
          activa={foco === "sinConductor"}
          onClick={() => setFoco(foco === "sinConductor" ? "todos" : "sinConductor")}
        />
        <CeldaResumen
          etiqueta="Sin ruta"
          valor={totalSinRuta}
          detalle={totalSinRuta > 0 ? "unidades por asignar" : "todas asignadas"}
          alerta={totalSinRuta > 0}
          activa={foco === "sinRuta"}
          onClick={() => setFoco(foco === "sinRuta" ? "todos" : "sinRuta")}
        />
      </section>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex gap-2 overflow-x-auto pb-1 max-w-full"
          role="group"
          aria-label="Filtrar por tipo"
        >
          <ChipTipo activo={tipoFiltro === ""} onClick={() => setTipoFiltro("")}>
            Todos <b className="font-mono ml-1.5">{equipos.length}</b>
          </ChipTipo>
          {chipsTipo.map(([clave, t]) => (
            <ChipTipo
              key={clave}
              activo={tipoFiltro === clave}
              onClick={() => setTipoFiltro(clave)}
            >
              {t.etiqueta} <b className="font-mono ml-1.5">{t.cantidad}</b>
            </ChipTipo>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            aria-label="Buscar equipos"
            placeholder="Buscar placa, conductor, ruta..."
            className="w-56 max-w-full bg-[#0D1719] border border-[#334155] text-white rounded-xl px-3.5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E] transition-all"
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <div
            className="inline-flex border border-[#334155] rounded-xl overflow-hidden"
            role="group"
            aria-label="Tipo de vista"
          >
            {(
              [
                ["tabla", "Tabla", List],
                ["tarjetas", "Tarjetas", LayoutGrid],
              ] as const
            ).map(([v, texto, Icono]) => (
              <button
                key={v}
                type="button"
                aria-pressed={vista === v}
                onClick={() => cambiarVista(v)}
                className={`flex items-center gap-2 px-3.5 py-2.5 text-sm transition-colors ${
                  vista === v
                    ? "bg-[#BADC1E] text-[#0D1719] font-bold"
                    : "text-[#94a3b8] hover:bg-[#1f2e2b] hover:text-white"
                }`}
              >
                <Icono className="w-4 h-4" />
                {texto}
              </button>
            ))}
          </div>
          {vista === "tarjetas" && (
            <div
              className="inline-flex border border-[#334155] rounded-xl overflow-hidden"
              role="group"
              aria-label="Tamaño de las tarjetas"
            >
              {(["amplia", "normal", "compacta"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={tam === t}
                  onClick={() => cambiarTam(t)}
                  className={`px-3 py-2.5 text-sm capitalize transition-colors ${
                    tam === t
                      ? "bg-[#BADC1E] text-[#0D1719] font-bold"
                      : "text-[#94a3b8] hover:bg-[#1f2e2b] hover:text-white"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {grifosInternos.hayVarios && (
        <div className="mb-4 flex items-center gap-2">
          <label
            htmlFor="filtro-grifo-equipos"
            className="text-xs font-bold uppercase text-[#94a3b8]"
          >
            Grifo
          </label>
          <select
            id="filtro-grifo-equipos"
            className="border border-[#334155] rounded-lg p-2 text-sm bg-[#0D1719] text-white"
            value={filtroGrifo}
            onChange={(e) => setFiltroGrifo(e.target.value)}
          >
            <option value="">Todos</option>
            {grifosInternos.grifosActivos.map((g) => (
              <option key={g.id} value={g.id}>
                {g.etiqueta}
              </option>
            ))}
          </select>
        </div>
      )}
      {foco !== "todos" && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#223033] bg-[#192526] px-4 py-2.5 text-sm text-[#94a3b8]">
          <span>
            Mostrando solo unidades{" "}
            <b className="text-white">{foco === "sinConductor" ? "sin conductor" : "sin ruta"}</b>:{" "}
            {filteredEquipos.length}
          </span>
          <button
            type="button"
            onClick={() => setFoco("todos")}
            className="font-semibold text-[#BADC1E] underline"
          >
            Quitar filtro
          </button>
        </div>
      )}

      {puedeEscribir && seleccionVisible.length > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 bg-[#192526] border border-[#2a2e37] text-white rounded-xl px-4 py-3 text-sm">
          <span>
            {seleccionVisible.length} equipo{seleccionVisible.length === 1 ? "" : "s"} seleccionado
            {seleccionVisible.length === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSeleccionados(new Set())}
              className="px-3 py-1.5 text-xs rounded-lg border border-white/30 hover:bg-white/10"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleEliminarSeleccionados}
              disabled={eliminandoMasivo}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#BADC1E] text-[#0D1719] hover:brightness-110 disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {eliminandoMasivo ? "Eliminando..." : "Eliminar seleccionados"}
            </button>
          </div>
        </div>
      )}

      {filteredEquipos.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#334155] px-4 py-12 text-center text-[#94a3b8]">
          {equipos.length === 0
            ? "Todavía no hay equipos. Registra el primero con Nuevo Equipo o importa tu planilla."
            : "Ninguna unidad coincide con estos filtros."}
        </div>
      ) : vista === "tarjetas" ? (
        <div
          className="grid gap-3.5"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${COLUMNA_TARJETA[tam]}px), 1fr))`,
          }}
        >
          {filteredEquipos.map((e) => (
            <TarjetaEquipo
              key={e.id}
              equipo={e}
              tam={tam}
              puedeEscribir={puedeEscribir}
              seleccionado={seleccionados.has(e.id)}
              onToggleSeleccion={() => toggleSeleccion(e.id)}
              onConductor={verConductor}
              onHistorial={setEquipoHistorial}
              onEditar={openEditModal}
              onEliminar={(x) => handleDelete(x.id)}
            />
          ))}
        </div>
      ) : (
        <div className="bg-[#192526] border border-[#2a2e37] rounded-2xl overflow-hidden">
          <div className="overflow-auto max-h-[68vh]">
            <table className="w-full min-w-max text-left border-separate border-spacing-0">
              <thead>
                <tr>
                  {puedeEscribir && (
                    <th className="px-3 sm:px-4 py-2.5 sm:py-3 sticky top-0 z-10 bg-[#192526] border-b border-[#2a2e37]">
                      <input
                        type="checkbox"
                        aria-label="Seleccionar todos los equipos de la lista"
                        checked={todosSeleccionadosEnPagina}
                        onChange={toggleSeleccionarTodo}
                        className="w-4 h-4 rounded border-slate-300"
                      />
                    </th>
                  )}
                  {encabezadoOrden("placa", "placa")}
                  {encabezadoOrden("tipo", "tipo")}
                  <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-[#94a3b8] uppercase tracking-widest sticky top-0 z-10 bg-[#192526] border-b border-[#2a2e37] whitespace-nowrap">
                    estado
                  </th>
                  {encabezadoOrden("conductor", "conductor")}
                  <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-[#94a3b8] uppercase tracking-widest sticky top-0 z-10 bg-[#192526] border-b border-[#2a2e37] whitespace-nowrap">
                    dni
                  </th>
                  <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-[#94a3b8] uppercase tracking-widest sticky top-0 z-10 bg-[#192526] border-b border-[#2a2e37] whitespace-nowrap">
                    ruta
                  </th>
                  {encabezadoOrden("tanque", "tanque")}
                  {encabezadoOrden("medidor", "medidor")}
                  {encabezadoOrden("marca", "marca / modelo")}
                  {grifosInternos.hayVarios && (
                    <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-[#94a3b8] uppercase tracking-widest sticky top-0 z-10 bg-[#192526] border-b border-[#2a2e37] whitespace-nowrap">
                      grifo
                    </th>
                  )}
                  <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-[#94a3b8] uppercase tracking-widest sticky top-0 z-10 bg-[#192526] border-b border-[#2a2e37] whitespace-nowrap !z-20 right-0 text-right shadow-[-12px_0_12px_-12px_rgba(0,0,0,0.6)]">
                    acciones
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredEquipos.map((e) => (
                  <tr key={e.id} className="group">
                    {puedeEscribir && (
                      <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors">
                        <input
                          type="checkbox"
                          aria-label={`Seleccionar ${e.placa_codigo}`}
                          checked={seleccionados.has(e.id)}
                          onChange={() => toggleSeleccion(e.id)}
                          className="w-4 h-4 rounded border-slate-300"
                        />
                      </td>
                    )}
                    <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors">
                      <div className="font-mono text-xs sm:text-sm font-semibold text-white">
                        {e.placa_codigo}
                      </div>
                      {e.codigo_interno && (
                        <div className="font-mono text-[11px] text-[#94a3b8]">
                          {e.codigo_interno}
                        </div>
                      )}
                    </td>
                    <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors text-xs sm:text-sm text-[#e2e8f0]">
                      <span className="inline-flex items-center gap-2.5">
                        <EquipoIcono tipo={e.tipo} className="w-8 h-5 shrink-0 text-[#BADC1E]" />
                        {e.tipo}
                      </span>
                    </td>
                    <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors text-xs sm:text-sm">
                      <EstadoUnidadBadge equipo={e} />
                    </td>
                    <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors text-xs sm:text-sm text-[#e2e8f0]">
                      {e.conductor_nombre ? (
                        e.conductor_dni ? (
                          <button
                            type="button"
                            onClick={() => verConductor(e)}
                            title={`Ver las unidades de ${e.conductor_nombre}`}
                            className="text-left underline decoration-[#334155] underline-offset-4 hover:text-[#BADC1E] hover:decoration-[#BADC1E]"
                          >
                            {e.conductor_nombre}
                          </button>
                        ) : (
                          e.conductor_nombre
                        )
                      ) : sinConductor(e) ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#f0b429]">
                          <TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" />
                          Sin conductor
                        </span>
                      ) : (
                        "---"
                      )}
                    </td>
                    <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors font-mono text-xs sm:text-sm text-[#94a3b8]">
                      {e.conductor_dni || "---"}
                    </td>
                    <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors text-xs sm:text-sm text-[#e2e8f0]">
                      {(e.rutas ?? []).length > 0 ? (
                        <ul className="space-y-0.5">
                          {e.rutas.map((r) => (
                            <li
                              key={`${r.origen_id}>${r.destino_id}`}
                              className="whitespace-nowrap"
                            >
                              {r.origen} → {r.destino}
                            </li>
                          ))}
                        </ul>
                      ) : sinRuta(e) ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#f0b429]">
                          <TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" />
                          Sin ruta
                        </span>
                      ) : (
                        "---"
                      )}
                    </td>
                    <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors font-mono text-xs sm:text-sm text-[#e2e8f0]">
                      {textoTanque(e) ?? <span className="font-sans text-[#64748b]">Sin dato</span>}
                    </td>
                    <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors text-xs sm:text-sm text-[#94a3b8]">
                      {textoMedidor(e) ?? "---"}
                    </td>
                    <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors text-xs sm:text-sm">
                      <div className="text-[#e2e8f0]">{e.marca || "---"}</div>
                      {e.modelo && <div className="text-[11px] text-[#94a3b8]">{e.modelo}</div>}
                    </td>
                    {grifosInternos.hayVarios && (
                      <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors text-xs sm:text-sm text-[#94a3b8]">
                        {grifosInternos.nombreDeGrifo(e.grifo_interno_id)}
                      </td>
                    )}
                    <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 border-b border-[#2a2e37] group-hover:bg-[#1f2e2b] transition-colors sticky right-0 text-right space-x-2 whitespace-nowrap !bg-[#192526] group-hover:!bg-[#1f2e2b] shadow-[-12px_0_12px_-12px_rgba(0,0,0,0.6)]">
                      {/* El historial es una consulta: Lectura también lo ve. */}
                      <button
                        onClick={() => setEquipoHistorial(e)}
                        className="p-2 text-slate-400 hover:text-[#BADC1E] rounded-lg transition-all"
                        title="Historial de conductor y rutas"
                        aria-label={`Historial de ${e.placa_codigo}`}
                      >
                        <History className="w-4 h-4" />
                      </button>
                      {puedeEscribir && (
                        <>
                          <button
                            onClick={() => openEditModal(e)}
                            className="p-2 text-slate-400 hover:text-[#BADC1E] rounded-lg transition-all"
                            title="Editar"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(e.id)}
                            className="p-2 text-slate-400 hover:text-[#BADC1E] rounded-lg transition-all"
                            title="Eliminar"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 bg-[#0D1719]/90 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-[#192526] text-[#e2e8f0] border border-[#2a2e37] overflow-x-auto h-full w-full max-w-lg shadow-2xl animate-in zoom-in duration-200">
            <div className="p-6 border-b border-[#2a2e37] flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">
                {editingId ? "Editar Equipo" : "Nuevo Equipo"}
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                aria-label="Cerrar"
                className="text-[#94a3b8] hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="space-y-1">
                <label
                  htmlFor="equipo-placa-codigo"
                  className="text-xs font-bold text-[#94a3b8] uppercase"
                >
                  Placa
                </label>
                <input
                  id="equipo-placa-codigo"
                  type="text"
                  placeholder="Ej: V-014"
                  required
                  className="w-full bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                  value={formData.placa_codigo}
                  onChange={(e) => setFormData({ ...formData, placa_codigo: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="equipo-codigo-interno"
                  className="text-xs font-bold text-[#94a3b8] uppercase"
                >
                  Código interno
                </label>
                <input
                  id="equipo-codigo-interno"
                  type="text"
                  placeholder="Ej: CU-14 (opcional)"
                  className="w-full bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                  value={formData.codigo_interno}
                  onChange={(e) => setFormData({ ...formData, codigo_interno: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="equipo-tipo" className="text-xs font-bold text-[#94a3b8] uppercase">
                  Tipo
                </label>
                <select
                  id="equipo-tipo"
                  className="w-full bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                  value={formData.tipo}
                  onChange={(e) => {
                    const tipo = e.target.value;
                    // Al DAR DE ALTA, el tipo precarga su medidor. Al editar no
                    // se toca: lo configurado a mano manda.
                    const medidor = MEDIDOR_POR_TIPO[tipo];
                    setFormData({
                      ...formData,
                      tipo,
                      ...(editingId === null && medidor !== undefined
                        ? { tipo_medidor: medidor }
                        : {}),
                    });
                  }}
                >
                  {TIPOS_COMUNES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              {/* Fase D de combustible (migrations/0069). Vacío = sin
                  configurar, y entonces no se valida sobredespacho para esta
                  unidad -- que es mejor que un número inventado. */}
              <div className="space-y-1">
                <label
                  htmlFor="equipo-capacidad-tanque"
                  className="text-xs font-bold text-[#94a3b8] uppercase"
                >
                  Capacidad de tanque
                </label>
                <div className="flex gap-2">
                  <input
                    id="equipo-capacidad-tanque"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Dejar vacío si no se conoce"
                    className="flex-1 bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                    value={formData.capacidad_tanque}
                    onChange={(e) => setFormData({ ...formData, capacidad_tanque: e.target.value })}
                  />
                  <select
                    aria-label="Unidad de la capacidad de tanque"
                    className="bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                    value={formData.capacidad_tanque_unidad}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        capacidad_tanque_unidad: e.target.value as "gal" | "L",
                      })
                    }
                  >
                    <option value="L">L</option>
                    <option value="gal">gal</option>
                  </select>
                </div>
                <p className="text-[11px] text-[#94a3b8]">
                  Sirve para avisar cuando un vale despacha más de lo que entra en el tanque.{" "}
                  <strong>Cargalo de la ficha técnica de la unidad</strong>. Si todavía no se
                  conoce, dejalo vacío: es mejor que un número aproximado.
                </p>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="equipo-consumo-maximo"
                  className="text-xs font-bold text-[#94a3b8] uppercase"
                >
                  Consumo máximo
                </label>
                <div className="flex gap-2 items-center">
                  <input
                    id="equipo-consumo-maximo"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Dejar vacío si todavía no se sabe"
                    className="flex-1 bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                    value={formData.consumo_maximo_l}
                    onChange={(e) => setFormData({ ...formData, consumo_maximo_l: e.target.value })}
                  />
                  <span className="text-sm text-[#94a3b8]">
                    L / {formData.tipo_medidor === "odometro" ? "km" : "hora"}
                  </span>
                  {editingId !== null && (
                    <button
                      type="button"
                      onClick={() => sugerirConsumo(editingId)}
                      className="text-xs font-semibold text-[#BADC1E] underline"
                      title="Calculado con las cargas anteriores de ESTA unidad"
                    >
                      Sugerir
                    </button>
                  )}
                </div>
                {sugerenciaConsumo && (
                  <p className="text-[11px] text-[#94a3b8]">{sugerenciaConsumo}</p>
                )}
                <p className="text-[11px] text-[#94a3b8]">
                  Compara los litros cargados contra el trabajo que hizo la unidad. Es el único
                  control que ve el combustible que sale <strong>con vale</strong> y no llega a la
                  máquina: el tanque cuadra igual. Sin dato no alerta; el número se puede sugerir
                  desde el historial, pero <strong>mirá la muestra antes de aceptarlo</strong>: si
                  ya venían robando, el promedio incluye ese robo.
                </p>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="equipo-tipo-medidor"
                  className="text-xs font-bold text-[#94a3b8] uppercase"
                >
                  Tipo de medidor
                </label>
                <select
                  id="equipo-tipo-medidor"
                  className="w-full bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                  value={formData.tipo_medidor}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      tipo_medidor: e.target.value as "" | "horometro" | "odometro",
                    })
                  }
                >
                  {Object.entries(ETIQUETA_TIPO_MEDIDOR).map(([valor, etiqueta]) => (
                    <option key={valor} value={valor}>
                      {etiqueta}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-[#94a3b8]">
                  Solo hace falta para despachar combustible de compra externa a este equipo (ruta
                  Bambamarca). Un volquete se mide por horómetro, un tráiler por odómetro.
                </p>
              </div>
              {/* El conductor asignado (0083). Se copia al vale en el momento
                  del despacho, así el consumo por conductor no se reescribe
                  cuando la unidad cambia de chofer. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="equipo-conductor"
                    className="text-xs font-bold text-[#cbd5e1] uppercase"
                  >
                    Conductor
                  </label>
                  <input
                    id="equipo-conductor"
                    type="text"
                    placeholder="Nombre y apellidos"
                    className="w-full bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                    value={formData.conductor_nombre}
                    onChange={(e) => setFormData({ ...formData, conductor_nombre: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="equipo-dni"
                    className="text-xs font-bold text-[#cbd5e1] uppercase"
                  >
                    DNI
                  </label>
                  <input
                    id="equipo-dni"
                    type="text"
                    placeholder="Ej: 12345678"
                    className="w-full bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                    value={formData.conductor_dni}
                    onChange={(e) => setFormData({ ...formData, conductor_dni: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-xs text-[#94a3b8] -mt-2">
                Queda copiado en cada vale que se despache a esta unidad, así el consumo por
                conductor sigue siendo correcto aunque después cambie de chofer.
              </p>
              <RutasEditor lugares={lugares} value={formRutas} onChange={setFormRutas} />
              {editingId !== null && exigeMotivo && (
                <div className="space-y-1 border border-[#BADC1E]/40 rounded-xl p-3 bg-[#BADC1E]/5">
                  <label
                    htmlFor="equipo-motivo-cambio"
                    className="text-xs font-bold text-[#BADC1E] uppercase"
                  >
                    Motivo del cambio (obligatorio)
                  </label>
                  <input
                    id="equipo-motivo-cambio"
                    type="text"
                    maxLength={500}
                    required
                    placeholder="Ej.: Juan pasó a la unidad V-9"
                    className="w-full bg-[#0D1719] border border-[#334155] rounded-xl p-3 text-sm text-white outline-none focus:ring-2 focus:ring-[#BADC1E]"
                    value={motivoCambio}
                    onChange={(e) => setMotivoCambio(e.target.value)}
                  />
                  <p className="text-[11px] text-[#94a3b8]">
                    Cambiar el conductor o las rutas deja registro: quién, cuándo y por qué. Lo
                    anterior se conserva en el historial.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="equipo-marca"
                    className="text-xs font-bold text-[#94a3b8] uppercase"
                  >
                    Marca
                  </label>
                  <input
                    id="equipo-marca"
                    type="text"
                    className="w-full bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                    value={formData.marca}
                    onChange={(e) => setFormData({ ...formData, marca: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="equipo-modelo"
                    className="text-xs font-bold text-[#94a3b8] uppercase"
                  >
                    Modelo
                  </label>
                  <input
                    id="equipo-modelo"
                    type="text"
                    className="w-full bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                    value={formData.modelo}
                    onChange={(e) => setFormData({ ...formData, modelo: e.target.value })}
                  />
                </div>
              </div>
              {/* Grifo interno (0097): solo con más de uno. En el alta se
                  elige; después se cambia con "Mover de grifo", con motivo. */}
              {grifosInternos.hayVarios &&
                (editingId === null ? (
                  <div className="space-y-1">
                    <label
                      htmlFor="equipo-grifo-interno"
                      className="text-xs font-bold text-[#94a3b8] uppercase"
                    >
                      Grifo interno
                    </label>
                    <select
                      id="equipo-grifo-interno"
                      required
                      className="w-full bg-[#0D1719] border border-[#334155] text-white rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-[#BADC1E]"
                      value={grifoAlta}
                      onChange={(e) => setGrifoAlta(e.target.value)}
                    >
                      <option value="">Elegir grifo</option>
                      {grifosInternos.grifosActivos.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.etiqueta}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2 text-sm bg-[#0D1719] border border-[#334155] rounded-xl p-3">
                    <span>
                      <span className="text-xs font-bold text-[#94a3b8] uppercase block">
                        Grifo interno
                      </span>
                      {grifosInternos.nombreDeGrifo(
                        equipos.find((x) => x.id === editingId)?.grifo_interno_id
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setEquipoAMover(equipos.find((x) => x.id === editingId) ?? null)
                      }
                      className="px-3 py-1.5 text-xs border border-[#334155] text-[#cbd5e1] rounded-lg hover:text-white"
                    >
                      Mover de grifo
                    </button>
                  </div>
                ))}
              <button
                type="submit"
                disabled={enviando}
                className="w-full bg-[#BADC1E] text-[#0D1719] font-bold py-4 rounded-2xl hover:brightness-110 transition-all mt-4 disabled:opacity-50"
              >
                {editingId ? "Guardar Cambios" : "Registrar Equipo"}
              </button>
            </form>
          </div>
        </div>
      )}
      {equipoHistorial && (
        <HistorialEquipo
          equipoId={equipoHistorial.id}
          placa={equipoHistorial.placa_codigo}
          onCerrar={() => setEquipoHistorial(null)}
        />
      )}
      {conductorVer && (
        <ConductorUnidades
          dni={conductorVer.dni}
          nombre={conductorVer.nombre}
          onCerrar={() => setConductorVer(null)}
        />
      )}
      {equipoAMover && (
        <MoverDeGrifo
          que="equipo"
          id={equipoAMover.id}
          nombre={equipoAMover.placa_codigo}
          grifoActualId={equipoAMover.grifo_interno_id}
          grifos={grifosInternos.grifosActivos}
          onCerrar={() => setEquipoAMover(null)}
          onMovido={() => {
            setEquipoAMover(null);
            grifosInternos.recargar();
            void fetchEquipos();
          }}
        />
      )}
      {importacion.filasPendientes && (
        <ModalVistaPreviaImportacion
          filas={importacion.filasPendientes}
          columnas={columnasVistaPreviaEquipos}
          etiquetaEntidad="equipos"
          confirmando={importacion.importando}
          onConfirmar={importacion.confirmar}
          onCancelar={importacion.cancelar}
        />
      )}
    </div>
  );
}

function CeldaResumen({
  etiqueta,
  valor,
  detalle,
  alerta,
  activa,
  onClick,
}: {
  etiqueta: string;
  valor: number;
  detalle: string;
  alerta?: boolean;
  activa?: boolean;
  onClick?: () => void;
}) {
  const contenido = (
    <>
      <span className="text-[11px] uppercase tracking-widest text-[#94a3b8]">{etiqueta}</span>
      <span
        className={`font-mono text-3xl font-bold leading-none tabular-nums ${
          alerta ? "text-[#f0b429]" : onClick ? "text-[#BADC1E]" : "text-white"
        }`}
      >
        {valor}
      </span>
      <span className="text-xs text-[#94a3b8]">{detalle}</span>
    </>
  );
  const base =
    "flex flex-col gap-1 text-left min-w-0 rounded-2xl border bg-[#192526] px-4 py-4 transition-colors";
  if (!onClick) {
    return <div className={`${base} border-[#223033]`}>{contenido}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!!activa}
      className={`${base} hover:bg-[#1f2e2b] hover:border-[#BADC1E]/35 ${
        activa ? "border-[#BADC1E] ring-1 ring-inset ring-[#BADC1E]" : "border-[#223033]"
      }`}
    >
      {contenido}
    </button>
  );
}

function ChipTipo({
  activo,
  onClick,
  children,
}: {
  activo: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activo}
      className={`whitespace-nowrap px-3.5 py-1.5 rounded-full border text-[13px] transition-colors ${
        activo
          ? "bg-[#BADC1E] border-[#BADC1E] text-[#0D1719] font-semibold"
          : "border-[#334155] text-[#94a3b8] hover:bg-[#1f2e2b] hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
