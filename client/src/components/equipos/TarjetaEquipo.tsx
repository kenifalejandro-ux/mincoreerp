// client/src/components/equipos/TarjetaEquipo.tsx
//
// La unidad en una tarjeta: quién la maneja y por dónde va, de un vistazo.
// Tres tamaños; la compacta deja lo esencial para ver muchas a la vez.
import { History, Pencil, Trash2, TriangleAlert } from "lucide-react";

import EquipoIcono from "./EquipoIcono";
import {
  estadoDeUnidad,
  sinConductor,
  sinRuta,
  textoMedidor,
  textoTanque,
  tipoLlevaConductor,
  type Equipo,
  type TamTarjeta,
} from "./equiposVista";

export function EstadoUnidadBadge({ equipo, soloPunto }: { equipo: Equipo; soloPunto?: boolean }) {
  const estado = estadoDeUnidad(equipo);
  const color = estado === "Activo" ? "text-[#BADC1E]" : "text-[#64748b]";
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-bold whitespace-nowrap ${color}`}
      title={estado}
    >
      <span aria-hidden="true" className="w-2 h-2 rounded-full bg-current" />
      {soloPunto ? <span className="sr-only">{estado}</span> : estado}
    </span>
  );
}

function Falta({ texto }: { texto: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#f0b429]">
      <TriangleAlert className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      {texto}
    </span>
  );
}

export default function TarjetaEquipo({
  equipo: e,
  tam,
  puedeEscribir,
  seleccionado,
  onToggleSeleccion,
  onConductor,
  onHistorial,
  onEditar,
  onEliminar,
}: {
  equipo: Equipo;
  tam: TamTarjeta;
  puedeEscribir: boolean;
  seleccionado: boolean;
  onToggleSeleccion: () => void;
  onConductor: (e: Equipo) => void;
  onHistorial: (e: Equipo) => void;
  onEditar: (e: Equipo) => void;
  onEliminar: (e: Equipo) => void;
}) {
  const compacta = tam === "compacta";
  const lleva = tipoLlevaConductor(e.tipo);
  const rutas = e.rutas ?? [];
  const tanque = textoTanque(e);
  const medidor = textoMedidor(e);
  const marcaModelo = [e.marca, e.modelo].filter(Boolean).join(" · ");

  const conductor = e.conductor_nombre ? (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      {e.conductor_dni ? (
        <button
          type="button"
          onClick={() => onConductor(e)}
          title={`Ver las unidades de ${e.conductor_nombre}`}
          className={`font-semibold text-left text-white underline decoration-[#334155] underline-offset-4 hover:text-[#BADC1E] hover:decoration-[#BADC1E] ${
            compacta ? "text-sm" : "text-base"
          }`}
        >
          {e.conductor_nombre}
        </button>
      ) : (
        <span className={`font-semibold text-white ${compacta ? "text-sm" : "text-base"}`}>
          {e.conductor_nombre}
        </span>
      )}
      {!compacta && e.conductor_dni && (
        <span className="font-mono text-xs text-[#94a3b8]">DNI {e.conductor_dni}</span>
      )}
    </div>
  ) : e.conductor_dni ? (
    <span className="font-mono text-sm text-[#e2e8f0]">DNI {e.conductor_dni}</span>
  ) : lleva ? (
    sinConductor(e) ? (
      <Falta texto="Sin conductor asignado" />
    ) : (
      <span className="text-[13px] text-[#94a3b8]">Sin conductor</span>
    )
  ) : (
    <span className="text-[13px] text-[#94a3b8]">No lleva conductor</span>
  );

  const rutasHtml =
    rutas.length > 0 ? (
      <ul className="space-y-1">
        {(compacta ? rutas.slice(0, 1) : rutas).map((r) => (
          <li
            key={`${r.origen_id}>${r.destino_id}`}
            className={compacta ? "text-xs truncate" : "text-sm"}
            title={`${r.origen} → ${r.destino}`}
          >
            {r.origen} <span className="text-[#BADC1E]">→</span> {r.destino}
          </li>
        ))}
        {compacta && rutas.length > 1 && (
          <li className="text-[11px] text-[#94a3b8]">+{rutas.length - 1} más</li>
        )}
      </ul>
    ) : lleva ? (
      sinRuta(e) ? (
        <Falta texto="Sin ruta asignada" />
      ) : (
        <span className="text-[13px] text-[#94a3b8]">Sin ruta</span>
      )
    ) : (
      <span className="text-[13px] text-[#94a3b8]">No lleva ruta</span>
    );

  const botones = (
    <div className="flex gap-1.5">
      <button
        type="button"
        onClick={() => onHistorial(e)}
        title="Historial de conductor y rutas"
        aria-label={`Historial de ${e.placa_codigo}`}
        className="w-8 h-8 grid place-items-center rounded-lg border border-[#334155] text-[#94a3b8] hover:text-[#BADC1E] hover:border-[#BADC1E] transition-colors"
      >
        <History className="w-4 h-4" />
      </button>
      {puedeEscribir && (
        <>
          <button
            type="button"
            onClick={() => onEditar(e)}
            title="Editar"
            aria-label={`Editar ${e.placa_codigo}`}
            className="w-8 h-8 grid place-items-center rounded-lg border border-[#334155] text-[#94a3b8] hover:text-[#BADC1E] hover:border-[#BADC1E] transition-colors"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onEliminar(e)}
            title="Eliminar"
            aria-label={`Eliminar ${e.placa_codigo}`}
            className="w-8 h-8 grid place-items-center rounded-lg border border-[#334155] text-[#94a3b8] hover:text-[#BADC1E] hover:border-[#BADC1E] transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </>
      )}
    </div>
  );

  const etiqueta = "text-[11px] uppercase tracking-widest text-[#94a3b8]";

  return (
    <article
      className={`flex flex-col min-w-0 rounded-2xl border border-[#223033] bg-[#192526] transition-colors hover:bg-[#1f2e2b] hover:border-[#BADC1E]/35 ${
        compacta ? "p-3 gap-2" : "p-4 gap-3"
      }`}
    >
      <div className={`flex items-center ${compacta ? "gap-2" : "gap-3"}`}>
        {puedeEscribir && (
          <input
            type="checkbox"
            aria-label={`Seleccionar ${e.placa_codigo}`}
            checked={seleccionado}
            onChange={onToggleSeleccion}
            className="w-4 h-4 rounded border-slate-300 shrink-0"
          />
        )}
        <div
          className={`shrink-0 grid place-items-center rounded-xl bg-[#0D1719] border border-[#223033] text-[#BADC1E] ${
            compacta ? "w-11 h-8" : "w-16 h-11"
          }`}
        >
          <EquipoIcono tipo={e.tipo} className={compacta ? "w-8 h-5" : "w-12 h-8"} />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className={`font-mono font-bold text-white break-words ${
              compacta ? "text-[13px]" : "text-[17px] tracking-wide"
            }`}
          >
            {e.placa_codigo}
          </div>
          <div className="text-[11px] uppercase tracking-wider text-[#94a3b8] truncate">
            {e.tipo}
            {e.codigo_interno && !compacta ? ` · ${e.codigo_interno}` : ""}
          </div>
        </div>
        <EstadoUnidadBadge equipo={e} soloPunto={compacta} />
      </div>

      <div className="space-y-1.5 border-t border-[#223033] pt-3">
        {!compacta && <div className={etiqueta}>Conductor</div>}
        {conductor}
      </div>

      <div className="space-y-1.5 border-t border-[#223033] pt-3 min-w-0">
        {!compacta && <div className={etiqueta}>{rutas.length > 1 ? "Rutas" : "Ruta"}</div>}
        {rutasHtml}
      </div>

      <div
        className={`grid gap-3 border-t border-[#223033] pt-3 ${compacta ? "grid-cols-1" : "grid-cols-2"}`}
      >
        <div className="min-w-0">
          <div className={etiqueta}>Tanque</div>
          {tanque ? (
            <div className="font-mono font-bold text-[15px] text-white">{tanque}</div>
          ) : (
            <div className="text-[13px] text-[#94a3b8]">Sin dato</div>
          )}
        </div>
        {!compacta && (
          <div className="min-w-0">
            <div className={etiqueta}>Medidor</div>
            {medidor ? (
              <div className="font-semibold text-sm text-white">{medidor}</div>
            ) : (
              <div className="text-[13px] text-[#94a3b8]">Sin medidor</div>
            )}
          </div>
        )}
      </div>

      <div
        className={`mt-auto flex items-center gap-2 border-t border-[#223033] pt-3 ${
          compacta ? "justify-end" : "justify-between"
        }`}
      >
        {!compacta && (
          <span className="text-xs text-[#94a3b8] min-w-0 break-words">
            {marcaModelo || "Sin marca ni modelo"}
          </span>
        )}
        {botones}
      </div>
    </article>
  );
}
