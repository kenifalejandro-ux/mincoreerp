// client/src/components/administracion/ConfiguracionView.tsx
//
// "Administración → Configuración": las AUTONOMÍAS. Qué módulos ve cada
// persona de la empresa y con qué nivel (ver docs/architecture/
// cuentas-perfiles-y-administracion.md §10).
//
// Solo aparecen los módulos que la empresa tiene contratados — el servidor
// devuelve esa lista y además ignora cualquier otro que llegue en el request.
// Un administrador reparte lo que su empresa ya tiene; no se habilita módulos
// a sí mismo.
import { useCallback, useEffect, useState } from "react";

import { MODULOS_CLIENTE } from "../../modules/registry";
import {
  guardarPermisosApi,
  listarUsuariosApi,
  permisosDeUsuarioApi,
  type NivelModulo,
  type PermisoDeModulo,
  type UsuarioDelTenant,
} from "../../services/usuariosApi";

const NIVELES: { valor: "sin-acceso" | NivelModulo; titulo: string; detalle: string }[] = [
  { valor: "operar", titulo: "Operar", detalle: "Carga y modifica" },
  { valor: "consultas", titulo: "Consultas", detalle: "Ve y exporta, no toca nada" },
  { valor: "sin-acceso", titulo: "Sin acceso", detalle: "No lo ve en el menú" },
];

function nombreDeModulo(id: string): string {
  return MODULOS_CLIENTE.find((m) => m.id === id)?.label ?? id;
}

/** Los tres niveles de la pantalla contra los dos campos que guarda el
 *  servidor: "sin acceso" es que el módulo no esté asignado. */
function nivelElegido(permiso: PermisoDeModulo): "sin-acceso" | NivelModulo {
  return permiso.asignado ? permiso.nivel : "sin-acceso";
}

export default function ConfiguracionView() {
  const [usuarios, setUsuarios] = useState<UsuarioDelTenant[]>([]);
  const [elegido, setElegido] = useState<string | null>(null);
  const [modulos, setModulos] = useState<PermisoDeModulo[]>([]);
  const [motivo, setMotivo] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    listarUsuariosApi()
      .then((lista) => setUsuarios(lista.filter((u) => u.estado !== "inactivo")))
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar la lista."))
      .finally(() => setCargando(false));
  }, []);

  const abrir = useCallback(async (usuarioId: string) => {
    setElegido(usuarioId);
    setError(null);
    setAviso(null);
    setMotivo("");
    try {
      const permisos = await permisosDeUsuarioApi(usuarioId);
      setModulos(permisos.modulos);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los permisos.");
      setModulos([]);
    }
  }, []);

  const cambiarNivel = (modulo: string, valor: "sin-acceso" | NivelModulo) => {
    setModulos((previos) =>
      previos.map((permiso) =>
        permiso.modulo === modulo
          ? {
              modulo,
              asignado: valor !== "sin-acceso",
              nivel: valor === "sin-acceso" ? permiso.nivel : valor,
            }
          : permiso
      )
    );
  };

  const guardar = async () => {
    if (!elegido || guardando) return;
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      const resultado = await guardarPermisosApi(elegido, {
        modulos,
        motivo: motivo.trim() || undefined,
      });

      // Con la doble firma encendida no se guardó nada todavía: queda una
      // orden esperando a otro administrador.
      if (resultado.pendiente) {
        setAviso(
          `Queda pendiente de la firma de otro administrador (${resultado.orden.correlativo}). Todavía no se cambió nada.`
        );
        return;
      }

      // Se le dice al administrador qué pasó de verdad: quitar acceso echa a
      // la persona de sus sesiones abiertas, darle uno más no.
      setAviso(
        resultado.datos.recorta
          ? "Guardado. Se le cerraron las sesiones abiertas: cuando vuelva a entrar, entra con estos permisos."
          : "Guardado. Lo nuevo le aparece la próxima vez que la app renueve su sesión."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  };

  if (cargando) return <div className="p-20 text-center text-slate-500">Cargando...</div>;

  const persona = usuarios.find((u) => u.id === elegido);

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-800">Configuración</h2>
        <p className="text-slate-600 text-sm">
          Qué módulos ve cada persona y con qué nivel. Solo aparecen los módulos que tu empresa
          tiene contratados.
        </p>
      </div>

      {error && (
        <p className="mb-4 text-sm font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
          <p className="px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-widest bg-slate-50 border-b border-slate-100">
            Elegí a quién
          </p>
          <ul className="divide-y divide-slate-100 max-h-[28rem] overflow-y-auto">
            {usuarios.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => void abrir(u.id)}
                  className={`w-full text-left px-5 py-3 hover:bg-slate-50 transition-colors ${
                    u.id === elegido ? "bg-slate-50" : ""
                  }`}
                >
                  <span className="block text-sm font-semibold text-slate-800">{u.nombre}</span>
                  <span className="block text-xs text-slate-500 truncate">{u.email ?? u.dni}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="lg:col-span-2">
          {!persona ? (
            <div className="bg-white border border-slate-200 rounded-3xl p-10 text-center text-slate-500 shadow-sm">
              Elegí a alguien de la lista para ver y cambiar sus módulos.
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm space-y-5">
              <div>
                <h3 className="text-lg font-bold text-slate-800">{persona.nombre}</h3>
                <p className="text-sm text-slate-500">{persona.email ?? persona.dni}</p>
              </div>

              {modulos.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Tu empresa no tiene ningún módulo contratado todavía.
                </p>
              ) : (
                <ul className="space-y-3">
                  {modulos.map((permiso) => (
                    <li
                      key={permiso.modulo}
                      className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border border-slate-200 rounded-2xl px-4 py-3"
                    >
                      <span className="text-sm font-semibold text-slate-800">
                        {nombreDeModulo(permiso.modulo)}
                      </span>
                      <div className="flex gap-1">
                        {NIVELES.map((nivel) => {
                          const activo = nivelElegido(permiso) === nivel.valor;
                          return (
                            <button
                              key={nivel.valor}
                              type="button"
                              title={nivel.detalle}
                              onClick={() => cambiarNivel(permiso.modulo, nivel.valor)}
                              className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all ${
                                activo
                                  ? "bg-slate-900 text-white border-slate-900"
                                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                              }`}
                            >
                              {nivel.titulo}
                            </button>
                          );
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div>
                <label
                  htmlFor="permisos-motivo"
                  className="block text-xs font-bold text-slate-700 uppercase mb-1"
                >
                  Motivo
                </label>
                <input
                  id="permisos-motivo"
                  type="text"
                  maxLength={500}
                  placeholder="Ej: pasa a almacén, ya no carga vales"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Queda en el log de eventos. Sirve cuando alguien pregunte, meses después, por qué
                  esta persona ve lo que ve.
                </p>
              </div>

              {aviso && (
                <p className="text-sm font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
                  {aviso}
                </p>
              )}

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void guardar()}
                  disabled={guardando || modulos.length === 0}
                  className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-bold rounded-xl disabled:opacity-50"
                >
                  {guardando ? "Guardando..." : "Guardar"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
