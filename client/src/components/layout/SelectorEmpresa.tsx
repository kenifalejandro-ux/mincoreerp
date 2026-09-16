// client/src/components/layout/SelectorEmpresa.tsx
//
// Cambiar de empresa sin volver a entrar, para quien trabaja en más de una
// (ver docs/architecture/cuentas-perfiles-y-administracion.md §7).
//
// No aparece si la persona tiene una sola empresa, que es el caso de casi
// todos, ni para el personal de cancha, que entra con DNI y cuyo acceso es de
// UNA empresa (la API devuelve lista vacía).
//
// ── Por qué recarga la página entera ─────────────────────────────────────
//
// Al cambiar de empresa cambia TODO lo que está en memoria: los datos en
// pantalla, la conexión de tiempo real (SSE), los catálogos cacheados y hasta
// qué módulos se ven. Recargar es la única forma de garantizar que no quede
// nada de la empresa anterior a la vista — una tabla vieja que sobreviva al
// cambio le estaría mostrando a alguien datos de una empresa que ya no es la
// suya en esta sesión.
import { Building2, Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { contarPendientes } from "../../offline/offlineQueue";
import { cambiarEmpresaApi, misEmpresasApi, type EmpresaDelUsuario } from "../../services/authApi";

export default function SelectorEmpresa() {
  const [empresas, setEmpresas] = useState<EmpresaDelUsuario[]>([]);
  const [abierto, setAbierto] = useState(false);
  const [cambiando, setCambiando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Operaciones cargadas sin señal que todavía no llegaron al servidor.
  const [pendientes, setPendientes] = useState(0);
  const contenedor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelado = false;
    misEmpresasApi()
      .then((lista) => {
        if (!cancelado) setEmpresas(lista);
      })
      // Sin la lista, simplemente no se ofrece cambiar de empresa. No es un
      // error que valga la pena mostrarle a nadie en el encabezado.
      .catch(() => {});
    return () => {
      cancelado = true;
    };
  }, []);

  // Cerrar al hacer clic afuera: es un menú, no un modal.
  useEffect(() => {
    if (!abierto) return;
    const alClickear = (evento: MouseEvent) => {
      if (!contenedor.current?.contains(evento.target as Node)) setAbierto(false);
    };
    document.addEventListener("mousedown", alClickear);
    return () => document.removeEventListener("mousedown", alClickear);
  }, [abierto]);

  const actual = empresas.find((empresa) => empresa.actual);

  // Con una sola empresa no hay nada que elegir.
  if (empresas.length < 2) return null;

  const abrir = async () => {
    setError(null);
    if (!abierto) {
      // Se cuenta al abrir, no al montar: lo que importa es lo pendiente en el
      // momento de decidir.
      setPendientes(await contarPendientes().catch(() => 0));
    }
    setAbierto(!abierto);
  };

  const cambiar = async (empresa: EmpresaDelUsuario) => {
    if (empresa.actual || cambiando) return;
    setCambiando(empresa.tenantId);
    setError(null);
    try {
      await cambiarEmpresaApi(empresa.tenantId);
      window.location.reload();
    } catch (err) {
      setCambiando(null);
      setError(err instanceof Error ? err.message : "No se pudo cambiar de empresa");
    }
  };

  return (
    <div ref={contenedor} className="relative">
      <button
        type="button"
        onClick={() => void abrir()}
        aria-haspopup="listbox"
        aria-expanded={abierto}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-slate-700 text-slate-200 hover:border-[#DDF500] hover:text-white transition-colors max-w-[220px]"
      >
        <Building2 size={16} className="text-[#DDF500] shrink-0" />
        <span className="text-sm font-medium truncate">{actual?.nombre ?? "Empresa"}</span>
        <ChevronDown size={14} className="shrink-0 text-slate-400" />
      </button>

      {abierto && (
        <div
          role="listbox"
          className="absolute right-0 mt-2 w-72 bg-[#0A1014] border border-slate-700 rounded-lg shadow-2xl overflow-hidden z-50"
        >
          <p className="px-4 py-2 text-[10px] uppercase tracking-widest text-slate-500 border-b border-slate-800">
            Tus empresas
          </p>

          {pendientes > 0 && (
            <p className="px-4 py-3 text-xs text-amber-300 bg-amber-500/10 border-b border-amber-500/20">
              Tenés {pendientes} {pendientes === 1 ? "operación" : "operaciones"} sin sincronizar de
              esta empresa. No se pierden: se envían solas cuando vuelvas acá con señal.
            </p>
          )}

          {empresas.map((empresa) => (
            <button
              key={empresa.tenantId}
              type="button"
              role="option"
              aria-selected={empresa.actual}
              disabled={Boolean(cambiando)}
              onClick={() => void cambiar(empresa)}
              className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-white/5 disabled:opacity-50 transition-colors ${
                empresa.actual ? "bg-white/5" : ""
              }`}
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-white truncate">
                  {empresa.nombre}
                </span>
                <span className="block text-[11px] text-slate-500 truncate">{empresa.slug}</span>
              </span>
              {empresa.actual ? (
                <Check size={16} className="text-[#DDF500] shrink-0" />
              ) : cambiando === empresa.tenantId ? (
                <span className="text-[11px] text-slate-400 shrink-0">Entrando…</span>
              ) : null}
            </button>
          ))}

          {error && (
            <p className="px-4 py-3 text-xs text-red-300 bg-red-500/10 border-t border-red-500/20">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
