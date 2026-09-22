// client/src/components/administracion/AlcanceCombustible.tsx
//
// El bloque "Alcance en Combustible" de Configuración (migración 0100): qué
// sedes, grifos y surtidores ve una persona. Con un solo grifo y un solo
// surtidor no hay nada que repartir y el bloque no aparece — salvo que la
// persona ya tenga un alcance recortado, para que se lo pueda devolver.
//
// Marcar una sede cubre todos sus grifos, también los que se agreguen después.
// Marcar un grifo le da el grifo entero (varilla, recepciones, lecturas);
// marcar solo un surtidor le deja cargar vales en él y nada más.
import { useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";
import type { AlcanceDeCombustible } from "../../services/usuariosApi";
import { useSedes } from "../comunes/useSedes";

interface SurtidorCorto {
  id: number;
  grifo_interno_id: number;
  nombre: string;
  activo: boolean;
}

type Lista = "sedes" | "grifos" | "surtidores";

const alternar = (a: AlcanceDeCombustible, lista: Lista, id: number): AlcanceDeCombustible => ({
  ...a,
  [lista]: a[lista].includes(id) ? a[lista].filter((x) => x !== id) : [...a[lista], id],
});

export default function AlcanceCombustible({
  valor,
  onChange,
}: {
  valor: AlcanceDeCombustible;
  onChange: (a: AlcanceDeCombustible) => void;
}) {
  const { sedes } = useSedes();
  const [surtidores, setSurtidores] = useState<SurtidorCorto[]>([]);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const res = await apiFetch("/api/erp/combustible/surtidores");
      const filas = res.ok ? ((await res.json()) as SurtidorCorto[]) : [];
      if (vigente) setSurtidores(filas.filter((s) => s.activo));
    })().catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, []);

  const sedesActivas = sedes.filter((s) => s.activo);
  const grifos = sedesActivas.flatMap((s) => s.grifos.filter((g) => g.activo));
  if (valor.todo && grifos.length <= 1 && surtidores.length <= 1) return null;

  const casilla = (lista: Lista, id: number, texto: string, cubierto: boolean, extra = "") => (
    <label className={`flex items-center gap-2 text-sm ${cubierto ? "text-slate-400" : ""}`}>
      <input
        type="checkbox"
        checked={cubierto || valor[lista].includes(id)}
        disabled={cubierto}
        onChange={() => onChange(alternar(valor, lista, id))}
      />
      <span className="font-semibold text-slate-800">{texto}</span>
      {extra && <span className="text-xs text-slate-500">{extra}</span>}
    </label>
  );

  const nada = valor.sedes.length + valor.grifos.length + valor.surtidores.length === 0;

  return (
    <div className="border border-slate-200 rounded-2xl px-4 py-3 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <span className="text-sm font-semibold text-slate-800">Alcance en Combustible</span>
        <div className="flex gap-1">
          {[
            { todo: true, titulo: "Toda la empresa" },
            { todo: false, titulo: "Solo lo asignado" },
          ].map((op) => (
            <button
              key={op.titulo}
              type="button"
              onClick={() => onChange({ ...valor, todo: op.todo })}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all ${
                valor.todo === op.todo
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {op.titulo}
            </button>
          ))}
        </div>
      </div>

      {!valor.todo && (
        <>
          <ul className="space-y-2">
            {sedesActivas.map((sede) => {
              const sedeMarcada = valor.sedes.includes(sede.id);
              return (
                <li key={sede.id} className="space-y-1">
                  {casilla("sedes", sede.id, sede.nombre, false, "toda la sede")}
                  <ul className="ml-6 space-y-1">
                    {sede.grifos
                      .filter((g) => g.activo)
                      .map((grifo) => {
                        const grifoCubierto = sedeMarcada || valor.grifos.includes(grifo.id);
                        return (
                          <li key={grifo.id} className="space-y-1">
                            {casilla("grifos", grifo.id, grifo.nombre, sedeMarcada, "grifo entero")}
                            <ul className="ml-6 space-y-1">
                              {surtidores
                                .filter((s) => s.grifo_interno_id === grifo.id)
                                .map((s) => (
                                  <li key={s.id}>
                                    {casilla(
                                      "surtidores",
                                      s.id,
                                      s.nombre,
                                      grifoCubierto,
                                      "solo vales"
                                    )}
                                  </li>
                                ))}
                            </ul>
                          </li>
                        );
                      })}
                  </ul>
                </li>
              );
            })}
          </ul>
          {nada && (
            <p className="text-xs font-semibold text-amber-800">
              Sin nada marcado no ve ningún tanque ni vale de Combustible.
            </p>
          )}
        </>
      )}
    </div>
  );
}
