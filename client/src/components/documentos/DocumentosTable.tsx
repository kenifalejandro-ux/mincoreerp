/**client/src/documentos/Documentostable.tsx */

import { ChevronLeft, ChevronRight, FileSpreadsheet, Plus, X } from "lucide-react";
import { useEffect, useState, useCallback } from "react";

import { apiFetch } from "../../services/apiClient";

interface Documento {
  id: number;
  nombre_documento: string;
  responsable: string;
  fecha_vencimiento: string;
  estado_alerta: "VENCIDO" | "POR VENCER" | "VIGENTE";
}

interface DocumentoVersion {
  id: number;
  nombre_original: string;
  mime_type: string;
  tamano_bytes: number;
  subido_en: string;
}

const MIME_TYPES_PERMITIDOS = ["application/pdf", "image/jpeg", "image/png"];
const TAMANO_MAXIMO_BYTES = 10 * 1024 * 1024;

/** Espejo de MAX_FILAS_CARGA_MASIVA en server/schemas/documentos.schema.ts.
 *  Duplicarlo permite avisar ANTES de mandar 5 MB al servidor para que los
 *  rechace; el servidor sigue siendo el que decide (esto es comodidad, no
 *  seguridad). */
const MAX_FILAS_IMPORTACION = 5000;

interface FilaImportada {
  nombre_documento: string;
  responsable?: string;
  fecha_vencimiento: string;
}

/** Encabezados aceptados por columna, ya normalizados (ver
 *  normalizarEncabezado: minúsculas, sin acentos y SIN separadores). Se
 *  admiten varios porque la planilla la arma el cliente, no nosotros:
 *  exigir un encabezado exacto convierte cualquier variante ("Documento"
 *  en vez de "Nombre") en un error que el usuario no sabe corregir.
 *
 *  Ojo al agregar alias: van sin espacios ni guiones bajos, porque el
 *  encabezado con el que se comparan ya viene sin separadores. */
const COLUMNAS = {
  nombre: ["nombredocumento", "documento", "nombre"],
  responsable: ["responsable", "encargado"],
  vencimiento: ["fechavencimiento", "vencimiento", "fecha", "vence"],
};

function normalizarEncabezado(clave: string): string {
  return (
    clave
      .trim()
      .toLowerCase()
      .normalize("NFD")
      // Marcas diacríticas combinantes, por punto de código: escritas como
      // caracteres literales serían invisibles y frágiles ante un reformateo.
      .replace(/[\u0300-\u036f]/g, "")
      // Espacios, guiones, guiones bajos, puntos: cualquier cosa que alguien
      // use para separar palabras en un encabezado.
      .replace(/[^a-z0-9]/g, "")
  );
}

function buscarCelda(fila: Record<string, unknown>, alias: string[]): unknown {
  for (const [clave, valor] of Object.entries(fila)) {
    if (alias.includes(normalizarEncabezado(clave))) return valor;
  }
  return undefined;
}

function textoDeCelda(fila: Record<string, unknown>, alias: string[]): string {
  const valor = buscarCelda(fila, alias);
  return valor == null ? "" : String(valor).trim();
}

/** Devuelve la fecha en ISO (YYYY-MM-DD) o "" si no se pudo interpretar.
 *
 *  Excel guarda las fechas como número de serie, no como texto. Con
 *  `cellDates: true` la librería ya devuelve un Date en la mayoría de los
 *  casos, pero una celda formateada como texto llega como string -- por eso
 *  se contemplan los dos. Se usan los getters LOCALES (no toISOString) para
 *  no correr la fecha un día por zona horaria: quien escribe 15/03/2027 en
 *  Lima espera guardar el 15, no el 14. */
function fechaDeCelda(fila: Record<string, unknown>, alias: string[]): string {
  const valor = buscarCelda(fila, alias);
  if (valor == null || valor === "") return "";

  const fecha = valor instanceof Date ? valor : new Date(String(valor));
  if (Number.isNaN(fecha.getTime())) return "";

  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getDate()).padStart(2, "0");
  return `${fecha.getFullYear()}-${mes}-${dia}`;
}

/** Clave de idempotencia derivada del CONTENIDO de las filas a importar.
 *
 *  Que sea derivada y no aleatoria es lo que hace que esto sirva. El
 *  reintento real no es automático: es una persona que ve el error, vuelve
 *  a apretar "Excel" y elige EL MISMO ARCHIVO. Un crypto.randomUUID() daría
 *  una clave nueva en ese segundo intento y duplicaría todo igual; el hash
 *  del contenido da la misma clave, y el servidor lo reconoce como
 *  reintento (ver idempotentBatch.ts).
 *
 *  Se hashea el contenido ya parseado y normalizado, no los bytes crudos
 *  del archivo: así el mismo Excel guardado de nuevo por Excel (que cambia
 *  metadatos internos y por lo tanto los bytes) sigue dando la misma clave.
 *
 *  El resultado se formatea como UUID porque la columna de la base es de
 *  ese tipo. Se fuerzan los nibbles de versión (8, "custom") y de variante
 *  (10xx) para que sea un UUID bien formado y no un hash disfrazado. */
async function claveDeIdempotencia(filas: FilaImportada[]): Promise<string | undefined> {
  // crypto.subtle solo existe en contexto seguro (https o localhost). Si no
  // está, se sigue sin idempotencia en vez de romper la importación: es una
  // protección contra duplicados, no un requisito para poder importar.
  if (!globalThis.crypto?.subtle) return undefined;

  const contenido = JSON.stringify(filas);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contenido));
  const bytes = new Uint8Array(digest).slice(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x80; // versión 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Traduce la respuesta de error a algo accionable. El 413 es el caso que
 *  más confundía: no lo genera nuestro código sino Express, así que no trae
 *  JSON y sin este mensaje el usuario ve un error vacío. */
async function mensajeDeErrorDelServidor(res: Response, filas: number): Promise<string> {
  if (res.status === 413) {
    return `El archivo es demasiado grande para enviarlo de una vez (${filas} filas). Dividilo en varios archivos.`;
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => null);
    if (body?.error === "cuota_excedida") {
      return `Se alcanzó el límite de documentos del plan (${body.uso} de ${body.limite}). Importar ${filas} más lo superaría.`;
    }
    return "No tenés permiso para importar documentos.";
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => null);
    const primero = body?.errors?.[0];
    if (primero) {
      // El campo viene como "3.nombre_documento" (índice del array). Se
      // traduce a número de fila de la planilla, +2 por el encabezado.
      const indice = Number(String(primero.field).split(".")[0]);
      const ubicacion = Number.isInteger(indice) ? `Fila ${indice + 2}: ` : "";
      return `${ubicacion}${primero.message}`;
    }
    return "El archivo tiene filas con datos inválidos.";
  }
  return "El servidor rechazó la importación. Intentalo de nuevo.";
}

function formatearTamano(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentosTable() {
  const [docs, setDocs] = useState<Documento[]>([]);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState<any>({});
  const [editId, setEditId] = useState<number | null>(null);
  // Deshabilita "Guardar"/"Actualizar" mientras la request está en curso --
  // sin esto, un doble clic (o doble tap en una tablet con pantalla lenta
  // en campo) genera dos cliente_uuid distintos y crea dos documentos
  // reales: la idempotencia protege reintentos de la MISMA acción, no dos
  // clics que el sistema ve como dos acciones separadas.
  const [guardando, setGuardando] = useState(false);

  // Bloquear el botón achica la ventana, pero no la cierra: si los dos taps
  // entran antes del re-render, un crypto.randomUUID() dentro del submit
  // manda DOS claves distintas y el servidor las ve como dos documentos
  // legítimamente distintos. Fijar el uuid al ABRIR el modal es lo que hace
  // que los dos envíos compartan clave y la idempotencia los una.
  //
  // Se regenera en cada apertura: si no, el segundo documento legítimo
  // reusaría la clave del primero y el servidor devolvería aquel en
  // silencio — se perdería un registro, peor que el duplicado.
  const [clienteUuid, setClienteUuid] = useState("");

  // 🟡 MODAL CONTROL
  const [openModal, setOpenModal] = useState(false);

  // Vínculo opcional a una Orden de Trabajo (evidencia del trabajo -- ver
  // migrations/0049). Catálogo cargado una sola vez al montar, igual que
  // el selector de equipos en Checklists/IPERC.
  const [ordenesDeTrabajo, setOrdenesDeTrabajo] = useState<{ id: number; titulo: string }[]>([]);

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // 📎 ARCHIVO ADJUNTO (versiones)
  const [docArchivoId, setDocArchivoId] = useState<number | null>(null);
  const [versiones, setVersiones] = useState<DocumentoVersion[]>([]);
  const [cargandoVersiones, setCargandoVersiones] = useState(false);
  const [subiendoArchivo, setSubiendoArchivo] = useState(false);
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null);

  // 📦 IMPORTACIÓN MASIVA
  const [importando, setImportando] = useState(false);
  const [errorImportacion, setErrorImportacion] = useState<string | null>(null);
  const [resultadoImportacion, setResultadoImportacion] = useState<string | null>(null);

  const load = useCallback(
    (paginaAConsultar: number = page) => {
      apiFetch(`/api/erp/documentos?page=${paginaAConsultar}&pageSize=50`)
        .then((r) => r.json())
        .then((body) => {
          setDocs(Array.isArray(body.data) ? body.data : []);
          setTotalPages(body.pagination?.totalPages ?? 1);
          setLoading(false);
        })
        .catch(() => {
          setDocs([]);
          setLoading(false);
        });
    },
    [page]
  );

  useEffect(() => {
    load(page);
  }, [page, load]);

  useEffect(() => {
    apiFetch("/api/erp/ordenes_trabajo?page=1&pageSize=200")
      .then((r) => r.json())
      .then((body) => setOrdenesDeTrabajo(Array.isArray(body.data) ? body.data : []))
      .catch(() => setOrdenesDeTrabajo([]));
  }, []);

  const getStatusStyle = (estado: string) => {
    switch (estado) {
      case "VENCIDO":
        return "bg-red-100 text-red-600 border border-red-200";
      case "POR VENCER":
        return "bg-amber-100 text-amber-600 border border-amber-200";
      default:
        return "bg-green-100 text-green-600 border border-green-200";
    }
  };

  // ➕ CREAR
  const createDoc = async () => {
    if (guardando) return;

    // Chequeo ANTES de encolar/enviar, no solo confiar en el 400 del
    // servidor: si esto se llena SIN red, apiFetch nunca llega a validar
    // nada -- encolaría igual y recién al sincronizar (quién sabe cuándo)
    // el servidor lo rechazaría. Frenarlo acá evita generar una entrada
    // que va a terminar descartada sin que el operario se entere a tiempo.
    if (!form.nombre_documento?.trim() || !form.fecha_vencimiento) {
      alert("Completá el nombre del documento y la fecha de vencimiento antes de guardar.");
      return;
    }

    setGuardando(true);
    try {
      // Aviso de posible duplicado (mismo nombre + misma fecha de
      // vencimiento -- una renovación normal tiene el mismo nombre pero
      // OTRA fecha, así que no dispara esto). Best-effort a propósito: es
      // una consulta de LECTURA aparte, nunca pasa por la cola offline, así
      // que sin red simplemente no se puede avisar -- se sigue con la
      // creación normal, que si hace falta, se encola como siempre.
      if (form.nombre_documento && form.fecha_vencimiento) {
        try {
          const chequeo = await apiFetch(
            `/api/erp/documentos/duplicado?nombre=${encodeURIComponent(form.nombre_documento)}&fecha=${encodeURIComponent(form.fecha_vencimiento)}`
          );
          if (chequeo.ok) {
            const { duplicado } = await chequeo.json();
            if (
              duplicado &&
              !window.confirm(
                `Ya existe un documento "${form.nombre_documento}" con la misma fecha de vencimiento. ¿Guardar de todos modos?`
              )
            ) {
              return;
            }
          }
        } catch {
          // Sin red u otro error en el chequeo: no bloquea la creación.
        }
      }

      const res = await apiFetch("/api/erp/documentos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Viene del estado (se fijó al abrir el modal), NO de un
          // crypto.randomUUID() acá adentro — ver el comentario donde se
          // declara clienteUuid.
          cliente_uuid: clienteUuid,
          ...form,
        }),
      });

      // 202 = no había red y quedó en la cola del dispositivo (ver
      // apiFetch). No se recarga el listado: sin señal el GET también
      // falla, y el documento todavía no existe del lado del servidor.
      if (res.status === 202) {
        setForm({});
        setOpenModal(false);
        alert(
          "Sin conexión: el documento quedó guardado en este equipo y se enviará solo cuando vuelva la señal."
        );
        return;
      }

      // El schema Zod de POST / puede rechazar el envío (ej. sin fecha de
      // vencimiento) -- antes de esto Documentos no validaba nada, así que
      // esto nunca pasaba. El modal se queda abierto con lo ya tipeado en
      // vez de limpiarse como si hubiera guardado: cerrarlo acá le mostraría
      // al operario un "listo" falso para algo que el servidor rechazó.
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const detalle = Array.isArray(body?.errors)
          ? body.errors.map((e: { message: string }) => e.message).join(", ")
          : null;
        alert(detalle ?? "No se pudo guardar el documento.");
        return;
      }

      setForm({});
      setOpenModal(false);
      load();
    } finally {
      setGuardando(false);
    }
  };

  // ✏️ EDITAR
  const updateDoc = async () => {
    if (guardando) return;
    setGuardando(true);
    try {
      await apiFetch(`/api/erp/documentos/${editId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      setEditId(null);
      setForm({});
      setOpenModal(false);
      load();
    } finally {
      setGuardando(false);
    }
  };

  // 🗑️ DELETE
  const deleteDoc = async (id: number) => {
    if (!window.confirm("¿Estás seguro de que deseas eliminar este documento?")) return;

    try {
      const res = await apiFetch(`/api/erp/documentos/${id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        load();
      } else {
        alert("Error: el servidor no permitió eliminar el documento.");
      }
    } catch {
      alert("Error de conexión con el backend.");
    }
  };

  // 📎 ARCHIVO ADJUNTO
  const cargarVersiones = useCallback(async (documentoId: number) => {
    setCargandoVersiones(true);
    try {
      const res = await apiFetch(`/api/erp/documentos/${documentoId}/versiones`);
      const body = await res.json();
      setVersiones(res.ok && Array.isArray(body) ? body : []);
    } catch {
      setVersiones([]);
    } finally {
      setCargandoVersiones(false);
    }
  }, []);

  const abrirArchivo = (documentoId: number) => {
    setDocArchivoId(documentoId);
    setErrorArchivo(null);
    cargarVersiones(documentoId);
  };

  const subirArchivo = async (file: File) => {
    if (subiendoArchivo) return;
    if (docArchivoId === null) return;

    if (!MIME_TYPES_PERMITIDOS.includes(file.type)) {
      setErrorArchivo("Solo se acepta PDF, JPG o PNG.");
      return;
    }
    if (file.size > TAMANO_MAXIMO_BYTES) {
      setErrorArchivo("El archivo supera el máximo permitido de 10 MB.");
      return;
    }

    setErrorArchivo(null);
    setSubiendoArchivo(true);

    const formData = new FormData();
    formData.append("archivo", file);
    // Acá SÍ se genera por invocación, a diferencia de createDoc() -- y es
    // deliberado, no un olvido. Esta función se dispara desde el onChange
    // de un input de archivo, que emite un evento por selección: un doble
    // tap abre el selector dos veces, no manda dos veces. Atar el uuid a
    // "el modal abierto" haría que subir DOS versiones distintas del mismo
    // documento sin cerrar el panel se deduplicara contra sí mismo, y la
    // segunda se perdería en silencio -- justo lo contrario de lo que se
    // busca en un historial de versiones.
    //
    // Sigue protegiendo lo que tiene que proteger: el reintento de la cola
    // offline reusa esta misma entrada (con su uuid ya fijo), así que una
    // respuesta perdida no duplica la versión.
    formData.append("cliente_uuid", crypto.randomUUID());

    try {
      const res = await apiFetch(`/api/erp/documentos/${docArchivoId}/versiones`, {
        method: "POST",
        body: formData,
      });

      if (res.status === 202) {
        setErrorArchivo(null);
        alert(
          "Sin conexión: el archivo quedó guardado en este equipo y se enviará solo cuando vuelva la señal."
        );
        return;
      }

      if (!res.ok) {
        setErrorArchivo("No se pudo subir el archivo.");
        return;
      }

      await cargarVersiones(docArchivoId);
    } catch {
      setErrorArchivo("Error de conexión con el backend.");
    } finally {
      setSubiendoArchivo(false);
    }
  };

  const descargarVersion = (versionId: number) => {
    if (docArchivoId === null) return;
    window.open(`/api/erp/documentos/${docArchivoId}/versiones/${versionId}/descarga`, "_blank");
  };

  // 📦 IMPORTACIÓN DESDE EXCEL
  //
  // xlsx se carga on-demand (import dinámico) para que su chunk no viaje en
  // el bundle inicial -- mismo criterio que RepuestosTable, y ya está
  // contemplado en el manualChunks de vite.config.js.
  //
  // Antes esto hacía readAsText() + JSON.parse(): decía "Excel" pero
  // esperaba un .json, y si el usuario elegía un .xlsx de verdad el
  // JSON.parse tiraba adentro de un callback async, o sea fallaba en
  // silencio absoluto.
  const leerFilasDelExcel = async (file: File): Promise<FilaImportada[]> => {
    const buffer = await file.arrayBuffer();
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buffer, { type: "array", cellDates: true });

    const hoja = wb.Sheets[wb.SheetNames[0]];
    if (!hoja) throw new Error("El archivo no tiene ninguna hoja de cálculo.");

    const filas = XLSX.utils.sheet_to_json<Record<string, unknown>>(hoja);
    if (filas.length === 0) throw new Error("La primera hoja está vacía.");

    return filas.map((fila, i) => {
      const nombre = textoDeCelda(fila, COLUMNAS.nombre);
      const vencimiento = fechaDeCelda(fila, COLUMNAS.vencimiento);

      // Se valida acá y no solo en el servidor para poder decir QUÉ fila
      // está mal: el 400 del backend habla de índices del array, que al
      // usuario no le dicen nada. La fila +2 compensa el encabezado y que
      // las planillas se numeran desde 1.
      if (!nombre) throw new Error(`Fila ${i + 2}: falta el nombre del documento.`);
      if (!vencimiento)
        throw new Error(`Fila ${i + 2}: falta la fecha de vencimiento o no es una fecha válida.`);

      return {
        nombre_documento: nombre,
        responsable: textoDeCelda(fila, COLUMNAS.responsable) || undefined,
        fecha_vencimiento: vencimiento,
      };
    });
  };

  const uploadExcel = async (file: File) => {
    setErrorImportacion(null);
    setResultadoImportacion(null);
    setImportando(true);

    try {
      const filas = await leerFilasDelExcel(file);

      if (filas.length > MAX_FILAS_IMPORTACION) {
        throw new Error(
          `El archivo tiene ${filas.length} filas y el máximo es ${MAX_FILAS_IMPORTACION}. Dividilo en varios archivos.`
        );
      }

      const clave = await claveDeIdempotencia(filas);

      const res = await apiFetch("/api/erp/documentos/bulk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(clave ? { "Idempotency-Key": clave } : {}),
        },
        body: JSON.stringify(filas),
      });

      if (!res.ok) {
        setErrorImportacion(await mensajeDeErrorDelServidor(res, filas.length));
        return;
      }

      const body = await res.json().catch(() => ({}));
      setResultadoImportacion(
        body.yaImportado
          ? "Este archivo ya se había importado antes, así que no se duplicó nada."
          : `Se importaron ${body.insertadas ?? filas.length} documentos correctamente.`
      );
      load();
    } catch (err) {
      setErrorImportacion(err instanceof Error ? err.message : "No se pudo leer el archivo.");
    } finally {
      setImportando(false);
    }
  };

  if (loading) {
    return <div className="p-10 text-center text-gray-500">Cargando documentos...</div>;
  }

  return (
    <div className="animate-in fade-in duration-700 slide-in-from-bottom-4">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-4 lg:gap-6 mb-6 lg:mb-12">
        {/* IZQUIERDA */}
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-3xl lg:text-4xl font-light text-slate-800 tracking-tight">
            Documentación Legal
          </h1>
        </div>

        {/* DERECHA (BOTONES) */}
        <div className="flex items-center gap-3 ml-auto">
          <button
            onClick={() => {
              setForm({});
              setEditId(null);
              setClienteUuid(crypto.randomUUID());
              setOpenModal(true);
            }}
            className="flex items-center gap-2 px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors duration-200"
          >
            <Plus className="w-4 h-4 shrink-0" />
            Nuevo Documento
          </button>

          <label
            className={`flex items-center gap-2 px-6 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50  text-sm font-medium rounded-lg ${
              importando ? " cursor-wait" : " cursor-pointer"
            }`}
          >
            <FileSpreadsheet className="w-4 h-4 shrink-0" />
            {importando ? "Importando..." : "Excel"}
            <input
              type="file"
              hidden
              accept=".xlsx,.xls,.csv"
              disabled={importando}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadExcel(file);
                // Sin esto, elegir el MISMO archivo dos veces seguidas no
                // dispara onChange (el value no cambió) -- justo lo que
                // querría hacer alguien que corrigió su planilla y la
                // vuelve a subir con el mismo nombre.
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>

      {/* MODAL ERP (NUEVO / EDITAR) */}
      {openModal && (
        <div className="fixed inset-0 z-50 p-4 bg-zinc-800/50 flex items-center justify-center">
          <div className="bg-white w-full max-w-[520px] min-h-[320px] p-4 sm:p-6 rounded-xl space-y-3">
            <h2 className="text-lg font-semibold">
              {editId ? "Editar Documento" : "Nuevo Documento"}
            </h2>

            <input
              className="border p-2 border border-zinc-400 rounded-[0.5rem] w-full"
              placeholder="Documento"
              value={form.nombre_documento || ""}
              onChange={(e) => setForm({ ...form, nombre_documento: e.target.value })}
            />

            <input
              className="border p-2 border border-zinc-400 rounded-[0.5rem] w-full"
              placeholder="Responsable"
              value={form.responsable || ""}
              onChange={(e) => setForm({ ...form, responsable: e.target.value })}
            />

            <input
              type="date"
              className="border p-2 border border-zinc-400 rounded-[0.5rem] w-full"
              value={form.fecha_vencimiento || ""}
              onChange={(e) => setForm({ ...form, fecha_vencimiento: e.target.value })}
            />

            <div className="space-y-1">
              <label
                htmlFor="documento-orden-trabajo"
                className="text-xs font-bold text-slate-500 uppercase"
              >
                Vincular a Orden de Trabajo (opcional)
              </label>
              <select
                id="documento-orden-trabajo"
                className="border p-2 border border-zinc-400 rounded-[0.5rem] w-full bg-white"
                value={form.orden_trabajo_id || ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    orden_trabajo_id: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
              >
                <option value="">Sin vincular</option>
                {ordenesDeTrabajo.map((ot) => (
                  <option key={ot.id} value={ot.id}>
                    #{ot.id} — {ot.titulo}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-2">
              {editId ? (
                <button
                  className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
                  onClick={updateDoc}
                  disabled={guardando}
                >
                  {guardando ? "Actualizando..." : "Actualizar"}
                </button>
              ) : (
                <button
                  className="bg-green-600 text-white px-4 py-2 rounded disabled:opacity-50"
                  onClick={createDoc}
                  disabled={guardando}
                >
                  {guardando ? "Guardando..." : "Guardar"}
                </button>
              )}

              <button className="text-gray-500" onClick={() => setOpenModal(false)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL ARCHIVO ADJUNTO (versiones) */}
      {docArchivoId !== null && (
        <div className="fixed inset-0 z-50 p-4 bg-zinc-800/50 flex items-center justify-center">
          <div className="bg-white w-full max-w-[520px] max-h-[80vh] p-4 sm:p-6 rounded-xl space-y-4 flex flex-col">
            <h2 className="text-lg font-semibold">Archivo del documento</h2>

            <label className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg cursor-pointer text-center w-fit">
              {subiendoArchivo ? "Subiendo..." : "Subir nueva versión"}
              <input
                type="file"
                hidden
                accept="application/pdf,image/jpeg,image/png"
                disabled={subiendoArchivo}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) subirArchivo(file);
                  e.target.value = "";
                }}
              />
            </label>

            {errorArchivo && <p className="text-sm text-red-600">{errorArchivo}</p>}

            <div className="overflow-y-auto space-y-2 flex-1">
              {cargandoVersiones ? (
                <p className="text-sm text-slate-400">Cargando versiones...</p>
              ) : versiones.length > 0 ? (
                versiones.map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-slate-900 truncate">{v.nombre_original}</p>
                      <p className="text-xs text-slate-400">
                        {formatearTamano(v.tamano_bytes)} ·{" "}
                        {new Date(v.subido_en).toLocaleString("es-PE")}
                      </p>
                    </div>
                    <button
                      className="text-blue-600 text-sm shrink-0 ml-3"
                      onClick={() => descargarVersion(v.id)}
                    >
                      Descargar
                    </button>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-400">Todavía no se subió ningún archivo.</p>
              )}
            </div>

            <button
              className="text-gray-500 text-sm"
              onClick={() => {
                setDocArchivoId(null);
                setVersiones([]);
              }}
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {/* RESULTADO DE LA IMPORTACIÓN */}
      {errorImportacion && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <p className="text-sm text-red-900 font-light flex-1">{errorImportacion}</p>
          <button
            className="text-red-400 hover:text-red-600 shrink-0"
            onClick={() => setErrorImportacion(null)}
            aria-label="Cerrar aviso de error"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {resultadoImportacion && (
        <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
          <p className="text-sm text-green-900 font-light flex-1">{resultadoImportacion}</p>
          <button
            className="text-green-500 hover:text-green-700 shrink-0"
            onClick={() => setResultadoImportacion(null)}
            aria-label="Cerrar aviso de importación"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Alert Banner */}
      {(docs.some((d) => d.estado_alerta === "VENCIDO") ||
        docs.some((d) => d.estado_alerta === "POR VENCER")) && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-center gap-3">
            <div className="w-1.5 h-1.5 bg-amber-500 rounded-full"></div>
            <p className="text-sm text-amber-900 font-light">
              Sistema de alertas activo · Margen de notificación: 15 días
            </p>
          </div>
        </div>
      )}

      {/* TABLE */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  Documento
                </th>
                <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  Responsable
                </th>
                <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  Vencimiento
                </th>
                <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide text-center">
                  Estado
                </th>
                <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide text-right">
                  Acciones
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100">
              {docs.length > 0 ? (
                docs.map((doc) => (
                  <tr key={doc.id} className="hover:bg-slate-50 transition-colors duration-150">
                    <td className="px-6 py-4">
                      <div className="space-y-1">
                        <p className="text-sm font-light text-slate-900">{doc.nombre_documento}</p>
                        <p className="text-xs text-slate-400 font-light">
                          ID: {doc.id.toString().padStart(4, "0")}
                        </p>
                      </div>
                    </td>

                    <td className="px-6 py-4">
                      <span className="text-sm font-light text-slate-600">{doc.responsable}</span>
                    </td>

                    <td className="px-6 py-4">
                      <div className="space-y-1">
                        <p className="text-sm font-light text-slate-900">
                          {new Date(doc.fecha_vencimiento).toLocaleDateString("es-PE", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </p>
                        <p className="text-xs text-slate-400 font-light">
                          {Math.ceil(
                            (new Date(doc.fecha_vencimiento).getTime() - new Date().getTime()) /
                              (1000 * 60 * 60 * 24)
                          )}{" "}
                          días
                        </p>
                      </div>
                    </td>

                    <td className="px-6 py-4">
                      <div className="flex justify-center">
                        <div
                          className={`px-3 py-1 rounded-md border text-xs font-medium ${getStatusStyle(doc.estado_alerta)}`}
                        >
                          {doc.estado_alerta}
                        </div>
                      </div>
                    </td>

                    {/* ACCIONES ORDENADAS */}
                    <td className="px-6 py-4">
                      <div className="flex justify-end gap-2">
                        <button className="text-slate-600" onClick={() => abrirArchivo(doc.id)}>
                          Archivo
                        </button>

                        <button
                          className="text-blue-600"
                          onClick={() => {
                            setForm(doc);
                            setEditId(doc.id);
                            setOpenModal(true);
                          }}
                        >
                          Editar
                        </button>

                        <button className="text-red-600" onClick={() => deleteDoc(doc.id)}>
                          Eliminar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-6 py-20">
                    <div className="text-center space-y-3">
                      <div className="inline-flex items-center justify-center w-12 h-12 bg-slate-100 rounded-lg">
                        <div className="w-4 h-4 bg-slate-300 rounded-sm"></div>
                      </div>
                      <p className="text-sm font-light text-slate-400">
                        No hay documentos registrados
                      </p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* PAGINACIÓN */}
      <div className="flex items-center justify-between mt-4 px-1">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
        >
          <ChevronLeft className="w-4 h-4" />
          Anterior
        </button>
        <span className="text-sm text-slate-400">
          Página {page} de {totalPages}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
        >
          Siguiente
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
