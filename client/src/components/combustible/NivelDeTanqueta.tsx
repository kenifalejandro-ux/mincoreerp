// El cilindro de "Mi tanqueta": el mismo diseño del panel "Nivel de tanque" (TanqueVisual en
// CombustiblePanel), para la tanqueta de la unidad del conductor. Sin umbral mínimo, porque la
// tanqueta no tiene; el saldo es "lo que entró menos lo que se cargó según los registros", no
// una medida física (no tiene varilla).
import { coloresDelNivel, espacioLibre, porcentajeDelNivel } from "./nivelTanqueta";

export interface TanquetaMia {
  id: number;
  codigo: string;
  capacidad: number;
  saldo: number;
  libre: number;
  asignada_vigente: boolean;
  equipo_asignado: string | null;
}

// El borde mide 4px: el radio de dentro debe ir a la par con el de fuera o el líquido se sale.
const RADIO_EXT = "rounded-t-[60px] rounded-b-4xl";
const RADIO_INT = "rounded-t-[60px] rounded-b-3xl";

/** Lo que se muestra de un número: un -0.004 no debe verse "-0". */
const formatear = (n: number) =>
  (Math.abs(n) < 0.005 ? 0 : n).toLocaleString("es-PE", { maximumFractionDigits: 2 });

const hora = (d: Date) => d.toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit" });

/** "a las 1:22 a. m." si es de hoy; con la fecha si es de otro día (un caché de hace tres días no
 *  debe parecer de hoy). */
const cuando = (d: Date) => {
  const hoy = new Date();
  if (d.toDateString() === hoy.toDateString()) return `a las ${hora(d)}`;
  const dia = d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "2-digit" });
  return `el ${dia} a las ${hora(d)}`;
};

/** Por qué lo que se ve puede estar viejo: sin señal, o el servidor respondió con un error. */
export type ProblemaDeActualizacion = "sin_senal" | "servidor";

export default function NivelDeTanqueta({
  tanquetas,
  elegida,
  onElegir,
  problema,
  actualizadoEn,
}: {
  tanquetas: TanquetaMia[];
  elegida: TanquetaMia;
  onElegir: (id: number) => void;
  /** No se pudo actualizar: lo que se ve es lo último que se supo. */
  problema: ProblemaDeActualizacion | null;
  actualizadoEn: Date | null;
}) {
  const pct = porcentajeDelNivel(elegida.saldo, elegida.capacidad);
  const [color, claro, oscuro, brillo] = coloresDelNivel(elegida.saldo, pct);
  const sobregiro = elegida.saldo < -0.005;
  return (
    <div className="bg-[#192526] border border-[#2a2e37] rounded-lg p-6 flex flex-col items-center shadow-lg relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[#2a2e37] to-transparent" />
      <h2 className="text-sm font-bold uppercase tracking-widest text-[#94a3b8] mb-6 w-full text-center border-b border-[#2a2e37] pb-4">
        Mi tanqueta
      </h2>
      {tanquetas.length > 1 ? (
        <select
          aria-label="Tanqueta"
          value={elegida.id}
          onChange={(e) => onElegir(Number(e.target.value))}
          className="mb-1 w-full bg-[#0D1719] border border-[#334155] rounded px-3 py-2 text-sm font-semibold text-white"
        >
          {tanquetas.map((t) => (
            <option key={t.id} value={t.id}>
              {t.codigo}
              {t.saldo > 0 ? "" : " · sin saldo"}
            </option>
          ))}
        </select>
      ) : (
        <p
          className="w-full truncate text-center text-sm font-semibold text-white"
          title={elegida.codigo}
        >
          {elegida.codigo}
        </p>
      )}
      <p className="text-[10px] font-mono text-[#94a3b8] mb-6">
        {elegida.equipo_asignado ? `Unidad ${elegida.equipo_asignado}` : "Sin unidad"}
      </p>
      <div
        role="img"
        aria-label={`${elegida.codigo}: ${formatear(elegida.saldo)} de ${formatear(elegida.capacidad)} galones`}
        className="relative w-48 h-80 mb-6 flex justify-center"
      >
        {/* Capas de abajo hacia arriba: fondo -> líquido -> marcas -> vidrio. */}
        <div
          className={`absolute inset-0 ${RADIO_EXT} border-5 border-[#334155] bg-[#0f1115] shadow-[inset_0_0_20px_rgba(0,0,0,0.8)] z-0 pointer-events-none`}
        />
        <div className={`absolute inset-1 ${RADIO_INT} overflow-hidden z-10 pointer-events-none`}>
          <div
            className="absolute bottom-0 w-full transition-all duration-700 ease-out"
            style={{ height: `${pct}%` }}
          >
            <div
              className="w-full h-full relative overflow-hidden"
              style={{
                background: `linear-gradient(90deg, ${oscuro} 0%, ${color} 28%, ${claro} 42%, ${color} 58%, ${oscuro} 100%)`,
                boxShadow: pct > 0 ? `0 -8px 30px ${brillo}` : "none",
              }}
            >
              {pct > 0 && <div className="absolute top-0 left-0 w-full h-2 bg-white/40" />}
              <div className="absolute top-0 bottom-0 left-[18%] w-[10%] bg-gradient-to-b from-white/50 via-white/15 to-white/0 blur-[2px]" />
              <div className="absolute top-0 bottom-0 right-[16%] w-[4%] bg-white/15 blur-[2px]" />
            </div>
          </div>
        </div>
        <div className={`absolute inset-0 ${RADIO_EXT} overflow-hidden z-20 pointer-events-none`}>
          <div className="absolute left-0 top-0 h-full w-4 border-r border-[#334155]/50 flex flex-col justify-between py-8 opacity-70">
            {[100, 80, 60, 40, 20, 0].map((m) => (
              <div key={m} className="w-full border-b border-[#334155] relative">
                <span className="absolute left-6 -top-2 text-[10px] font-mono text-[#94a3b8]">
                  {m}%
                </span>
              </div>
            ))}
          </div>
        </div>
        <div
          className={`absolute inset-0 ${RADIO_EXT} bg-gradient-to-r from-white/10 via-transparent to-black/40 z-30 pointer-events-none`}
        />
      </div>
      <div className="bg-[#0D1719] border border-[#334155] rounded px-4 py-3 w-full text-center">
        <div className="text-[10px] text-[#94a3b8] font-bold uppercase mb-1">
          Saldo según registros
        </div>
        <div className="font-mono text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight flex items-baseline justify-center gap-1">
          <span className={sobregiro ? "text-red-400" : "text-white"}>
            {formatear(elegida.saldo)}
          </span>
          <span className="text-xs sm:text-sm text-[#94a3b8]">
            / {formatear(elegida.capacidad)} gal
          </span>
        </div>
        <div className="mt-2 flex items-baseline justify-center gap-1.5">
          <span className="font-mono text-lg sm:text-xl lg:text-2xl font-bold" style={{ color }}>
            {Math.floor(pct)}%
          </span>
          <span className="text-[10px] font-mono uppercase text-[#94a3b8]">
            · libre {formatear(espacioLibre(elegida.libre, elegida.capacidad))} gal
          </span>
        </div>
      </div>
      {sobregiro && (
        <p className="mt-3 w-full text-xs text-red-300 text-center">
          Se cargaron {formatear(-elegida.saldo)} gal más de los que esta tanqueta tenía
          registrados. Avisa al grifero.
        </p>
      )}
      <p className={`mt-3 text-[11px] ${problema ? "text-amber-400" : "text-[#94a3b8]"}`}>
        {problema === "sin_senal"
          ? `Sin señal: último saldo conocido${actualizadoEn ? ` ${cuando(actualizadoEn)}` : ""}`
          : problema === "servidor"
            ? `No se pudo actualizar: último saldo conocido${actualizadoEn ? ` ${cuando(actualizadoEn)}` : ""}`
            : actualizadoEn
              ? `Actualizado ${cuando(actualizadoEn)}`
              : ""}
      </p>
    </div>
  );
}
