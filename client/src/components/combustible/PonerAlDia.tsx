// «Poner al día»: la oficina registra de una vez lo que ya pasó en un viaje en curso y nadie marcó,
// con la fecha y la hora reales de cada llegada, salida y descanso. Reemplaza al botón de marcar de
// a una. Se guarda todo o nada (el servidor lo aplica en una sola transacción, ordenado por hora).
// Es de oficina, con señal: el celular del conductor tiene su propio camino.
import { Check, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { maxDetalle, MOTIVOS_DESCANSO, pideDetalle } from "./motivosDescanso";
import { descansoAbierto } from "./paradasViaje";
import {
  aValorLocal,
  armarAcciones,
  claveDeMarca,
  deValorLocal,
  evaluar,
  horaDeAtajo,
  marcasQueFaltan,
  textoDeGuardar,
  ultimaMarcaHecha,
  type Atajo,
  type DescansoPorPoner,
  type OrigenDeAccion,
} from "./ponerAlDiaLogica";
import { duracion, fechaHora, type FilaViaje } from "./viajesFormato";
import { apiFetch } from "../../services/apiClient";

const INPUT =
  "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-3 py-2 text-sm text-white [color-scheme:dark]";
const BTN =
  "bg-[#BADC1E] text-[#0D1719] font-bold px-4 py-2 rounded-xl hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed";
const CHIP =
  "px-3 py-1 rounded-full border border-[#334155] text-[#cbd5e1] text-sm font-semibold hover:border-[#BADC1E]";
const ETIQUETA = "block text-xs uppercase tracking-wide text-[#94a3b8] mb-1";

const ATAJOS: { id: Atajo; texto: string }[] = [
  { id: "ahora", texto: "Ahora" },
  { id: "hace1h", texto: "Hace 1 h" },
  { id: "hace6h", texto: "Hace 6 h" },
  { id: "mas8h", texto: "+8 h tras la anterior" },
];
const MOTIVOS_RAPIDOS = ["Se olvidó de marcar", "Sin señal", "Registro atrasado"];

type Escrito = Record<string, { en: string; medidor: string }>;

export function PonerAlDia({
  viaje,
  etiquetaMedidor,
  puedeEditar,
  onCambio,
  enfocar = false,
}: {
  viaje: FilaViaje;
  etiquetaMedidor: string;
  puedeEditar: boolean;
  onCambio: () => Promise<void>;
  /** Se abrió desde el botón «Poner al día» de la lista: baja hasta aquí. */
  enfocar?: boolean;
}) {
  const [ahora, setAhora] = useState(() => Date.now());
  const [escrito, setEscrito] = useState<Escrito>({});
  const [descansos, setDescansos] = useState<DescansoPorPoner[]>([]);
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [filaConError, setFilaConError] = useState<OrigenDeAccion | null>(null);
  const claveDescanso = useRef(1);
  const raiz = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setInterval(() => setAhora(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (enfocar) raiz.current?.scrollIntoView({ block: "start" });
  }, [enfocar]);

  if (!puedeEditar || viaje.estado !== "en_curso") return null;

  const paradas = viaje.paradas ?? [];
  const abierto = descansoAbierto(viaje.descansos);
  const marcas = marcasQueFaltan(paradas).map((m) => ({
    ...m,
    en: escrito[m.clave]?.en ?? "",
    medidor: escrito[m.clave]?.medidor ?? "",
  }));
  const ultimaHecha = ultimaMarcaHecha(paradas);
  const ev = evaluar({
    marcas,
    descansos,
    ultimaHecha,
    inicioViaje: viaje.inicio_en ? Date.parse(viaje.inicio_en) : null,
    exigeMedidorFinal: viaje.medidor_inicio !== null,
    ahora,
    motivo,
  });

  // La hora de la marca de antes (la que se escribió o la ya puesta), para «+8 h» y las duraciones.
  const previaDe = (i: number): number | null => {
    for (let j = i - 1; j >= 0; j--) {
      const t = deValorLocal(marcas[j].en);
      if (t !== null) return t;
      if (marcas[j].en === "") return null;
    }
    return ultimaHecha;
  };

  const poner = (clave: string, campo: "en" | "medidor", valor: string) =>
    setEscrito((prev) => ({
      ...prev,
      [clave]: { en: prev[clave]?.en ?? "", medidor: prev[clave]?.medidor ?? "", [campo]: valor },
    }));

  const cambiarDescanso = (clave: number, cambio: Partial<DescansoPorPoner>) =>
    setDescansos((prev) => prev.map((d) => (d.clave === clave ? { ...d, ...cambio } : d)));

  const guardar = async () => {
    if (guardando || ev.pie) return;
    const { acciones, origenes } = armarAcciones(marcas, descansos, ev);
    setGuardando(true);
    setError(null);
    setAviso(null);
    setFilaConError(null);
    try {
      const res = await apiFetch(`/api/erp/viajes/${viaje.id}/poner-al-dia`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivo.trim(), acciones }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        const mensaje = r.message || r.error || r.errors?.[0]?.message || "No se pudo guardar.";
        setError(`${mensaje} No se guardó nada.`);
        const indice = r.details?.indice;
        if (typeof indice === "number") setFilaConError(origenes[indice] ?? null);
        return;
      }
      const cierra = ev.cierraElViaje;
      setAviso(
        `${textoDeGuardar(ev)
          .replace(/^Guardar /, "Se guardaron ")
          .replace(/ y cerrar el viaje$/, "")}.` + (cierra ? " El viaje quedó cerrado." : "")
      );
      setEscrito({});
      setDescansos([]);
      setMotivo("");
      await onCambio();
    } finally {
      setGuardando(false);
    }
  };

  const titulo = <p className="text-xs uppercase tracking-widest text-[#94a3b8]">Poner al día</p>;

  if (abierto) {
    return (
      <div ref={raiz} className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-4 space-y-2">
        {titulo}
        <p className="text-sm text-[#94a3b8]">Termina el descanso para marcar el recorrido.</p>
      </div>
    );
  }

  // El recorrido completo, con lo que ya está puesto y lo que falta, en orden.
  const filas: ReactNode[] = [];
  if (paradas.length > 0) {
    filas.push(
      <FilaHecha
        key="salida-0"
        texto={`Salida de ${paradas[0].lugar}`}
        cuando={viaje.inicio_en}
        ultima={marcas.length === 0}
      />
    );
  }
  let primeraPendiente = true;
  const agregar = (clase: "llegada" | "salida", i: number) => {
    const indice = marcas.findIndex((m) => m.clave === claveDeMarca(clase, i));
    const ultima = clase === "llegada" ? i === paradas.length - 1 : false;
    if (indice < 0) {
      const iso = clase === "llegada" ? paradas[i].llegada_en : paradas[i].salida_en;
      filas.push(
        <FilaHecha
          key={`${clase}-${i}`}
          texto={
            clase === "llegada"
              ? `Llegada a ${paradas[i].lugar}`
              : `Salida de ${paradas[i].lugar} hacia ${paradas[i + 1].lugar}`
          }
          cuando={iso}
          ultima={ultima}
        />
      );
      return;
    }
    const m = marcas[indice];
    const previa = previaDe(indice);
    const t = deValorLocal(m.en);
    const errorFila = ev.errorMarca[indice];
    const rechazada = filaConError?.tipo === "marca" && filaConError.clave === m.clave;
    const proxima = primeraPendiente;
    primeraPendiente = false;
    filas.push(
      <li key={m.clave} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
        <Riel hecho={ev.okMarca[indice]} proxima={proxima} ultima={ultima} />
        <div role="group" aria-label={m.texto} className="pb-4 min-w-0">
          <p className="font-bold text-white">{m.texto}</p>
          {ev.okMarca[indice] && t !== null && previa !== null && (
            <p className="text-xs text-[#94a3b8]">
              {duracion((t - previa) / 60_000)} {m.clase === "llegada" ? "de camino" : "parado"}
            </p>
          )}
          <div
            className={`mt-2 rounded-xl bg-[#14201f] border p-3 space-y-3 ${
              errorFila || rechazada ? "border-red-500/60" : "border-[#2a2e37]"
            }`}
          >
            <div
              className={`grid gap-3 ${viaje.tipo_medidor !== null ? "sm:grid-cols-[1.4fr_1fr]" : ""}`}
            >
              <div>
                <label htmlFor={`pad-en-${m.clave}`} className={ETIQUETA}>
                  Fecha y hora real
                </label>
                <input
                  id={`pad-en-${m.clave}`}
                  aria-label={`Fecha y hora de ${m.texto}`}
                  type="datetime-local"
                  max={aValorLocal(ahora)}
                  value={m.en}
                  onChange={(e) => poner(m.clave, "en", e.target.value)}
                  className={INPUT}
                />
              </div>
              {viaje.tipo_medidor !== null && (
                <div>
                  <label htmlFor={`pad-med-${m.clave}`} className={ETIQUETA}>
                    {etiquetaMedidor}
                    {m.cierra && viaje.medidor_inicio !== null ? "" : " (opcional)"}
                  </label>
                  <input
                    id={`pad-med-${m.clave}`}
                    aria-label={`${etiquetaMedidor} de ${m.texto}`}
                    inputMode="decimal"
                    value={m.medidor}
                    onChange={(e) => poner(m.clave, "medidor", e.target.value)}
                    className={INPUT}
                  />
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2" aria-label="Atajos de hora">
              {ATAJOS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={CHIP}
                  onClick={() => {
                    const ya = Date.now();
                    const valor = horaDeAtajo(a.id, ya, previa);
                    if (valor === null) return;
                    setAhora(ya);
                    poner(m.clave, "en", valor);
                  }}
                >
                  {a.texto}
                </button>
              ))}
            </div>
            {errorFila && <p className="text-xs text-red-400">{errorFila}</p>}
          </div>
        </div>
      </li>
    );
  };
  for (let i = 1; i < paradas.length; i++) {
    agregar("llegada", i);
    if (i < paradas.length - 1) agregar("salida", i);
  }

  return (
    <div ref={raiz} className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-4 space-y-4">
      {titulo}
      <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-sm text-amber-200">
        <b>
          Faltan {marcas.length} {marcas.length === 1 ? "marca" : "marcas"}.
        </b>{" "}
        Pon la fecha y la hora reales de cada una, en orden. Puedes guardar solo las primeras y
        seguir después.
      </div>
      {aviso && (
        <p
          role="status"
          className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 text-sm font-semibold text-emerald-300"
        >
          {aviso}
        </p>
      )}

      <ol className="m-0 p-0 list-none">{filas}</ol>

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-widest text-[#94a3b8]">Descansos que ya pasaron</p>
        {descansos.map((d, i) => {
          const rechazado = filaConError?.tipo === "descanso" && filaConError.clave === d.clave;
          const errorD = ev.errorDescanso[i];
          return (
            <div
              key={d.clave}
              role="group"
              aria-label={`Descanso ${i + 1}`}
              className={`rounded-xl bg-[#14201f] border p-3 space-y-3 ${
                errorD || rechazado ? "border-red-500/60" : "border-[#2a2e37]"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  {MOTIVOS_DESCANSO.map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={d.motivo === m}
                      onClick={() => cambiarDescanso(d.clave, { motivo: m })}
                      className={`px-3 py-1 rounded-full border text-sm font-semibold ${
                        d.motivo === m
                          ? "border-violet-400 bg-violet-500/20 text-violet-200"
                          : "border-[#334155] text-[#cbd5e1]"
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label={`Quitar descanso ${i + 1}`}
                  onClick={() => setDescansos((prev) => prev.filter((x) => x.clave !== d.clave))}
                  className="p-2 rounded-lg border border-[#334155] text-[#94a3b8] hover:text-white"
                >
                  <X className="w-4 h-4" aria-hidden />
                </button>
              </div>
              {pideDetalle(d.motivo) && (
                <input
                  aria-label={`Motivo del descanso ${i + 1}`}
                  placeholder="Escribe el motivo"
                  maxLength={maxDetalle(d.motivo)}
                  value={d.otro}
                  onChange={(e) => cambiarDescanso(d.clave, { otro: e.target.value })}
                  className={INPUT}
                />
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={`pad-d-desde-${d.clave}`} className={ETIQUETA}>
                    Desde
                  </label>
                  <input
                    id={`pad-d-desde-${d.clave}`}
                    type="datetime-local"
                    max={aValorLocal(ahora)}
                    value={d.desde}
                    onChange={(e) => cambiarDescanso(d.clave, { desde: e.target.value })}
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor={`pad-d-hasta-${d.clave}`} className={ETIQUETA}>
                    Hasta (si ya terminó)
                  </label>
                  <input
                    id={`pad-d-hasta-${d.clave}`}
                    type="datetime-local"
                    max={aValorLocal(ahora)}
                    value={d.hasta}
                    onChange={(e) => cambiarDescanso(d.clave, { hasta: e.target.value })}
                    className={INPUT}
                  />
                </div>
              </div>
              {errorD && <p className="text-xs text-red-400">{errorD}</p>}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() =>
            setDescansos((prev) => [
              ...prev,
              { clave: claveDescanso.current++, motivo: "Dormir", otro: "", desde: "", hasta: "" },
            ])
          }
          className="inline-flex items-center gap-1 text-sm font-semibold text-[#BADC1E]"
        >
          <Plus className="w-4 h-4" aria-hidden /> Agregar descanso
        </button>
      </div>

      <div className="space-y-2 border-t border-[#2a2e37] pt-3">
        <label htmlFor="pad-motivo" className={ETIQUETA}>
          Motivo (obligatorio)
        </label>
        <input
          id="pad-motivo"
          value={motivo}
          maxLength={500}
          placeholder="Ej. el conductor no marcó la llegada"
          onChange={(e) => setMotivo(e.target.value)}
          className={INPUT}
        />
        <div className="flex flex-wrap gap-2">
          {MOTIVOS_RAPIDOS.map((m) => (
            <button key={m} type="button" className={CHIP} onClick={() => setMotivo(m)}>
              {m}
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        {ev.pie && <p className="text-xs text-amber-300">{ev.pie}</p>}
        <button
          type="button"
          className={BTN}
          disabled={guardando || ev.pie !== null}
          onClick={() => void guardar()}
        >
          {textoDeGuardar(ev)}
        </button>
      </div>
    </div>
  );
}

/** El punto y la línea de la columna izquierda de la línea del viaje. */
function Riel({ hecho, proxima, ultima }: { hecho: boolean; proxima: boolean; ultima: boolean }) {
  return (
    <div className="flex flex-col items-center">
      <span
        aria-hidden
        className={`mt-0.5 w-5 h-5 rounded-full border-2 grid place-items-center ${
          hecho
            ? "bg-emerald-400 border-emerald-400 text-[#05261a]"
            : proxima
              ? "border-[#BADC1E]"
              : "border-[#94a3b8]"
        }`}
      >
        {hecho && <Check className="w-3 h-3" strokeWidth={3} />}
      </span>
      {!ultima && <span aria-hidden className="flex-1 w-0.5 bg-[#2a2e37] my-0.5 min-h-3" />}
    </div>
  );
}

function FilaHecha({
  texto,
  cuando,
  ultima,
}: {
  texto: string;
  cuando: string | null;
  ultima: boolean;
}) {
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
      <Riel hecho proxima={false} ultima={ultima} />
      <p className="pb-4 font-bold text-white">
        {texto}
        <span className="ml-2 text-xs font-normal text-[#94a3b8]">{fechaHora(cuando)}</span>
      </p>
    </li>
  );
}
