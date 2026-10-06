/** Exporta lo que está en pantalla, no todo el histórico del tenant --
 *  mismo criterio que el kardex/reportes, que exportan solo el período
 *  elegido. Un valor con coma o comilla se escapa citándolo entero y
 *  duplicando las comillas internas (RFC 4180), para no romper el CSV con
 *  un nombre de conductor o de grifo que traiga una coma. */
export function exportarCsv(filas: Record<string, unknown>[], nombreArchivo: string) {
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
