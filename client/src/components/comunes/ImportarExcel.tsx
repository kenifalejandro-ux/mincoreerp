// client/src/components/comunes/ImportarExcel.tsx
//
// Las dos piezas de UI que acompañan a useImportacionExcel: el botón que
// dispara el file picker, y el modal de vista previa ("se van a importar N
// filas" + Continuar/Rechazar). Separado del hook para que un módulo que
// necesite un disparador distinto (por ejemplo, un ítem de menú en vez de un
// botón) pueda armar el suyo y seguir usando el mismo modal.
import { FileSpreadsheet, X } from "lucide-react";

export interface ColumnaVistaPreviaExcel<T> {
  encabezado: string;
  render: (fila: T, indice: number) => React.ReactNode;
}

interface BotonImportarExcelProps {
  cargando: boolean;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  etiqueta?: string;
}

/** El botón/label que abre el selector de archivo -- mismo estilo neutro que
 *  el resto de los botones secundarios de estas pantallas (ej. "Exportar
 *  Excel"), no un color propio: no es una acción positiva que amerite
 *  destacarse en verde, es una más del grupo. */
export function BotonImportarExcel({
  cargando,
  onFile,
  etiqueta = "Importar Excel",
}: BotonImportarExcelProps) {
  return (
    <label
      className={`px-4 py-2.5 border rounded-xl flex items-center gap-2 transition-all bg-slate-50 text-slate-700 border-slate-200 ${
        cargando ? "opacity-50 cursor-wait" : "hover:bg-slate-100 cursor-pointer"
      }`}
    >
      <FileSpreadsheet className="w-4 h-4 shrink-0" />
      <span>{cargando ? "Leyendo..." : etiqueta}</span>
      <input
        type="file"
        accept=".xlsx, .xls"
        className="hidden"
        disabled={cargando}
        onChange={onFile}
      />
    </label>
  );
}

/** Banner de error/éxito de la importación. Mismo lugar en los tres módulos:
 *  debajo de la cabecera, antes del buscador. */
export function BannerImportacion({
  error,
  resultado,
}: {
  error: string | null;
  resultado: string | null;
}) {
  if (!error && !resultado) return null;
  return (
    <div
      className={`mb-4 px-4 py-3 rounded-xl text-sm ${
        error
          ? "bg-red-50 text-red-700 border border-red-200"
          : "bg-emerald-50 text-emerald-700 border border-emerald-200"
      }`}
    >
      {error ?? resultado}
    </div>
  );
}

const LIMITE_VISTA_PREVIA = 20;

interface ModalVistaPreviaImportacionProps<T> {
  filas: T[];
  columnas: ColumnaVistaPreviaExcel<T>[];
  etiquetaEntidad: string;
  confirmando: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
}

/** "Se van a importar N equipos. Revisá antes de confirmar" -- nada viajó al
 *  servidor todavía en este punto (ver useImportacionExcel): el archivo ya
 *  se leyó y se parseó en el navegador, y esto es lo único que decide si
 *  ese POST /bulk se manda o se descarta. */
export function ModalVistaPreviaImportacion<T>({
  filas,
  columnas,
  etiquetaEntidad,
  confirmando,
  onConfirmar,
  onCancelar,
}: ModalVistaPreviaImportacionProps<T>) {
  const visibles = filas.slice(0, LIMITE_VISTA_PREVIA);
  const restantes = filas.length - visibles.length;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div className="bg-white w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl shadow-2xl animate-in zoom-in duration-200">
        <div className="p-6 border-b flex justify-between items-center shrink-0">
          <div>
            <h3 className="text-xl font-bold">Confirmar importación</h3>
            <p className="text-sm text-slate-500 mt-1">
              Se van a importar <strong>{filas.length}</strong> {etiquetaEntidad}. Nada se guardó
              todavía.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancelar}
            aria-label="Cerrar"
            className="text-slate-400 hover:text-slate-900"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-auto flex-1">
          <table className="w-full min-w-max text-left border-collapse text-sm">
            <thead className="bg-slate-50 sticky top-0">
              <tr>
                {columnas.map((c) => (
                  <th
                    key={c.encabezado}
                    className="px-4 py-2.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest"
                  >
                    {c.encabezado}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibles.map((fila, i) => (
                // El índice como key es aceptable acá: es una vista previa
                // efímera de datos que todavía no tienen id propio (ni
                // siquiera se mandaron al servidor).
                <tr key={i}>
                  {columnas.map((c) => (
                    <td key={c.encabezado} className="px-4 py-2 text-slate-700">
                      {c.render(fila, i)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {restantes > 0 && (
            <p className="text-xs text-slate-400 px-4 py-3">
              Y {restantes} fila{restantes === 1 ? "" : "s"} más.
            </p>
          )}
        </div>

        <div className="p-6 border-t flex justify-end gap-3 shrink-0">
          <button
            type="button"
            onClick={onCancelar}
            disabled={confirmando}
            className="px-5 py-2.5 text-sm font-medium text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-50"
          >
            Rechazar
          </button>
          <button
            type="button"
            onClick={onConfirmar}
            disabled={confirmando}
            className="px-5 py-2.5 text-sm font-bold text-white bg-slate-900 rounded-xl hover:bg-slate-800 disabled:opacity-50"
          >
            {confirmando ? "Importando..." : "Continuar"}
          </button>
        </div>
      </div>
    </div>
  );
}
