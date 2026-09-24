// client/src/components/comunes/useImportacionExcel.ts
//
// Importación masiva desde Excel, con VISTA PREVIA antes de mandar nada al
// servidor -- lo pidió Kenif después de ver la importación de Equipos: el
// archivo se lee y se parsea localmente, se muestra "se van a importar N
// filas" con una tabla de ejemplo, y solo al apretar "Continuar" se manda el
// POST /bulk. "Rechazar" descarta lo leído sin tocar el servidor.
//
// Nace acá y no repetido en cada módulo porque hasta este cambio CADA
// pantalla con "Importar Excel" (Repuestos, Combustible, Equipos) tenía su
// propio handleExcelUpload copiado a mano -- mismo bug arreglado tres veces,
// tres mensajes de error levemente distintos. Este hook centraliza todo lo
// que NO depende de la planilla de cada módulo (leer el archivo, cargar xlsx
// on-demand, la vista previa, el POST, los mensajes de 413/403/400); lo que
// SÍ depende de cada módulo (qué columnas trae la planilla, cómo se arma
// cada fila, qué dice el mensaje de éxito) se lo pasa el que lo usa.
import { useState } from "react";
import type { WorkBook } from "xlsx";

import { apiFetch } from "../../services/apiClient";

/** Las utilidades de SheetJS (sheet_to_json, etc.) -- se le pasan al
 *  `parsear` de cada módulo junto con el libro, porque xlsx se carga
 *  on-demand acá adentro y el módulo no tiene otra forma de llegar a ellas
 *  sin importar la librería completa en su propio bundle. */
export type UtilidadesXlsx = typeof import("xlsx").utils;

/** Traduce la respuesta de error a algo accionable. El 413 es el caso que
 *  más confunde: lo genera Express antes de llegar a nuestro código, así
 *  que no trae JSON y sin este mensaje el usuario ve un error vacío. */
async function mensajeDeErrorDelServidor(
  res: Response,
  filas: number,
  etiquetaEntidad: string
): Promise<string> {
  if (res.status === 413) {
    return `El archivo es demasiado grande para enviarlo de una vez (${filas} filas). Dividilo en varios archivos.`;
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => null);
    if (body?.error === "cuota_excedida") {
      return `Se alcanzó el límite de ${etiquetaEntidad} del plan (${body.uso} de ${body.limite}). Importar ${filas} más lo superaría.`;
    }
    return `No tenés permiso para importar ${etiquetaEntidad}.`;
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => null);
    const primero = body?.errors?.[0];
    if (primero) {
      // El campo viene como "3.codigo" (índice de fila + columna, ver
      // validate.ts: issue.path.join(".")) -- se separan los dos: sin la
      // columna el aviso dice "Fila 2: Required" sin decir QUÉ falta.
      const partes = String(primero.field).split(".");
      const indice = Number(partes[0]);
      const campo = partes.slice(1).join(".");
      const ubicacion = Number.isInteger(indice)
        ? `Fila ${indice + 2}${campo ? ` (columna "${campo}")` : ""}: `
        : "";
      return `${ubicacion}${primero.message}`;
    }
    return "El archivo tiene filas con datos inválidos.";
  }
  return "El servidor rechazó la importación. Intentalo de nuevo.";
}

export interface OpcionesImportacionExcel<T> {
  /** Endpoint POST /bulk del módulo, ej. "/api/erp/equipos/bulk". */
  endpoint: string;
  /** Cada módulo entiende su propia planilla -- acá se recibe el
   *  WorkBook completo (no una sola forma fija de leerlo) porque algunas
   *  planillas tienen encabezados con nombre de columna == campo (sirve
   *  sheet_to_json en modo objeto, ej. Repuestos) y otras traen celdas
   *  combinadas o encabezados libres que hace falta rellenar a mano (ej.
   *  Equipos, con el tipo en celdas combinadas: sheet_to_json en modo
   *  array con header:1). */
  parsear: (libro: WorkBook, utils: UtilidadesXlsx) => T[];
  /** Tope de filas -- espejo del límite del schema del servidor
   *  (MAX_FILAS_CARGA_MASIVA_*). Avisa ANTES de leer/mandar miles de filas;
   *  el servidor sigue siendo el que decide. */
  maxFilas: number;
  /** Plural en minúscula, para los mensajes genéricos ("equipos",
   *  "repuestos", "tanques"). */
  etiquetaEntidad: string;
  /** Se llama con la respuesta CRUDA del servidor al confirmar, para que el
   *  módulo refresque su listado y arme su propio mensaje de éxito (algunos,
   *  como Combustible, necesitan avisar de tanques sin vigilancia u
   *  omitidos). Si no devuelve nada, se usa el mensaje genérico. */
  onImportado: (bodyServidor: Record<string, unknown>, cantidadEnviada: number) => string | void;
}

export function useImportacionExcel<T>({
  endpoint,
  parsear,
  maxFilas,
  etiquetaEntidad,
  onImportado,
}: OpcionesImportacionExcel<T>) {
  // Leyendo/parseando el archivo EN EL NAVEGADOR -- todavía no se mandó nada.
  const [cargando, setCargando] = useState(false);
  // Enviando el POST /bulk, después de que el usuario confirmó la vista previa.
  const [importando, setImportando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<string | null>(null);
  // No-null = hay una vista previa esperando "Continuar" o "Rechazar". Es lo
  // que dispara el modal: nada se manda al servidor mientras esto exista.
  const [filasPendientes, setFilasPendientes] = useState<T[] | null>(null);

  const limpiarMensajes = () => {
    setError(null);
    setResultado(null);
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Sin esto, elegir el MISMO archivo dos veces seguidas no dispara
    // onChange (el value no cambió) -- justo lo que querría hacer alguien
    // que corrigió su planilla y la vuelve a subir con el mismo nombre.
    e.target.value = "";
    if (!file) return;

    limpiarMensajes();
    setCargando(true);

    const reader = new FileReader();
    reader.onerror = () => {
      setCargando(false);
      setError("No se pudo leer el archivo.");
    };
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const XLSX = await import("xlsx");
        const libro = XLSX.read(bstr, { type: "binary" });
        if (libro.SheetNames.length === 0) {
          throw new Error("El archivo no tiene ninguna hoja de cálculo.");
        }
        const data = parsear(libro, XLSX.utils);

        if (data.length === 0) {
          throw new Error(`No se encontraron ${etiquetaEntidad} en el archivo.`);
        }
        if (data.length > maxFilas) {
          throw new Error(
            `El archivo tiene ${data.length} filas y el máximo es ${maxFilas}. Dividilo en varios archivos.`
          );
        }

        // Vista previa: se guarda lo parseado y se espera confirmación --
        // TODAVÍA no viajó nada al servidor.
        setFilasPendientes(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error al procesar el archivo.");
      } finally {
        setCargando(false);
      }
    };
    reader.readAsBinaryString(file);
  };

  const cancelar = () => setFilasPendientes(null);

  const confirmar = async () => {
    if (!filasPendientes || importando) return;
    setImportando(true);
    try {
      const res = await apiFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filasPendientes),
      });

      if (!res.ok) {
        setError(await mensajeDeErrorDelServidor(res, filasPendientes.length, etiquetaEntidad));
        setFilasPendientes(null);
        return;
      }

      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const insertados = Number(body.insertados ?? filasPendientes.length);
      const mensajePersonalizado = onImportado(body, filasPendientes.length);
      setResultado(
        mensajePersonalizado ?? `Se importaron ${insertados} ${etiquetaEntidad} correctamente.`
      );
      setFilasPendientes(null);
    } catch {
      setError("Error de conexión con el backend.");
    } finally {
      setImportando(false);
    }
  };

  return {
    cargando,
    importando,
    error,
    resultado,
    filasPendientes,
    handleFile,
    confirmar,
    cancelar,
    limpiarMensajes,
  };
}
