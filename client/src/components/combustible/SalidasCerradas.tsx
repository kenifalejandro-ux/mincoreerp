// Lo que pasó con la tanqueta cuando salió de la unidad del conductor: con cuánto salió, cuánto
// cargó, cuánto recibió el grifero al volver, la diferencia con su motivo y a dónde fue el saldo.
// Es el sustento del conductor si le preguntan por lo que devolvió. Solo lectura; sin nombres de
// otras personas (el servidor solo manda pozo, otra tanqueta o reserva).
import type { CierreDeSalida } from "./kardexTanquetaDatos";

const NUMERO = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 3 });
const FECHA = new Intl.DateTimeFormat("es-PE", {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const gal = (n: number) => `${NUMERO.format(n)} gal`;

const DESTINOS: Record<string, string> = {
  pozo: "Volvió al pozo",
  tanqueta: "Pasó a otra tanqueta",
  reserva: "Quedó en la tanqueta o pasó a otra unidad",
};

export interface GrupoDeSalidas {
  codigo: string;
  salidas: CierreDeSalida[];
}

function Salida({ s }: { s: CierreDeSalida }) {
  const volvio = s.volvio !== null;
  return (
    <li className="rounded-md border border-[#2a2e37] bg-[#0f1a1b] px-4 py-3 text-sm">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono font-bold text-white">{s.vale}</span>
        {s.unidad && <span className="font-mono text-[#94a3b8]">{s.unidad}</span>}
        <span className="text-xs text-[#94a3b8]">
          {FECHA.format(new Date(s.inicio))}
          {s.fin ? ` → ${FECHA.format(new Date(s.fin))}` : ""}
        </span>
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-[#94a3b8]">Salió con</dt>
          <dd className="font-mono text-white">{s.salioCon === null ? "—" : gal(s.salioCon)}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-[#94a3b8]">Cargó</dt>
          <dd className="font-mono text-white">{gal(s.cargo)}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-[#94a3b8]">Le entró después</dt>
          <dd className="font-mono text-white">{gal(s.entroDespues)}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-[#94a3b8]">
            Recibió el grifero
          </dt>
          <dd className="font-mono text-white">{volvio ? gal(s.volvio!) : "—"}</dd>
        </div>
      </dl>
      {volvio && s.diferencia !== null && Math.abs(s.diferencia) >= 0.0005 && (
        <p className="mt-2 text-amber-300">
          El grifero corrigió el saldo: {s.diferencia > 0 ? "+" : ""}
          {gal(s.diferencia)}
          {s.motivo ? ` · ${s.motivo}` : ""}
        </p>
      )}
      {s.destinoDelRetorno && (
        <p className="mt-1 text-[#94a3b8]">
          Destino del saldo: {DESTINOS[s.destinoDelRetorno] ?? "Otro destino"}
        </p>
      )}
      {!volvio && s.estado === "sin_retorno" && (
        <p className="mt-2 text-[#94a3b8]">No se registró el retorno de esta salida.</p>
      )}
    </li>
  );
}

export default function SalidasCerradas({ grupos }: { grupos: GrupoDeSalidas[] }) {
  const conSalidas = grupos.filter((g) => g.salidas.length > 0);
  if (conSalidas.length === 0) return null;
  return (
    <section
      className="mb-6 min-w-0 rounded-md border border-[#2a2e37] bg-[#192526] p-4"
      aria-label="Salidas anteriores de la tanqueta"
    >
      <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[#94a3b8]">
        Salidas anteriores
      </h2>
      {conSalidas.map((g) => (
        <div key={g.codigo} className="mb-3 last:mb-0">
          <p className="mb-2 font-mono text-xs font-bold text-white">{g.codigo}</p>
          <ul className="space-y-2">
            {g.salidas.map((s) => (
              <Salida key={`${s.vale}-${s.inicio}`} s={s} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
