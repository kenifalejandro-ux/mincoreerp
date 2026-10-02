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
import { useCallback, useEffect, useRef, useState } from "react";

import AlcanceCombustible from "./AlcanceCombustible";
import { MODULOS_CLIENTE } from "../../modules/registry";
import {
  guardarPermisosApi,
  type AlcanceDeCombustible,
  listarUsuariosApi,
  permisosDeUsuarioApi,
  type NivelModulo,
  type PermisoDeModulo,
  type PermisoDePestana,
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

function ArbolPermisosCombustible({
  items,
  onChange,
  disabled = false,
}: {
  items: PermisoDePestana[];
  onChange: (modulo: string, pestana: string, permitido: boolean) => void;
  disabled?: boolean;
}) {
  const submenus = items.filter((item) => item.nivel === "submenu");

  // Un hijo NO se deshabilita porque su submenú esté apagado: marcarlo lo
  // prende (ver cambiarPestana). Si no, el admin no podría darle una sola
  // vista del Histórico a un perfil de cancha, que es justo el caso que la
  // matriz deja a su criterio.
  const fila = (item: PermisoDePestana, indent = "pl-8") => (
    <li
      key={`${item.modulo}:${item.pestana}`}
      className={`flex items-center justify-between gap-4 py-2 ${indent}`}
    >
      <span className="text-sm text-slate-700">
        {item.nombre}
        {item.permitido === item.predeterminado && (
          <span className="ml-2 text-xs text-slate-400">Predeterminado</span>
        )}
      </span>
      <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600">
        <input
          type="checkbox"
          checked={item.permitido}
          disabled={disabled}
          onChange={(event) => onChange(item.modulo, item.pestana, event.target.checked)}
          className="h-4 w-4 accent-lime-500"
        />
        Visible
      </label>
    </li>
  );

  return (
    <div className="mt-2 border-t border-slate-200 px-3">
      <p className="py-2 text-[11px] font-bold uppercase text-slate-400">Submenús de Combustible</p>
      <div className="divide-y divide-slate-100">
        {submenus.map((submenu) => {
          const children = items.filter((item) => item.padre === submenu.pestana);
          const tabs = children.filter((item) => item.nivel === "pestana");
          const actions = children.filter((item) => item.nivel === "accion");

          return (
            <details
              key={submenu.pestana}
              className="group py-2"
              open={submenu.pestana === "tanques"}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-1">
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <span className="text-slate-400 transition-transform group-open:rotate-90">
                    ›
                  </span>
                  {submenu.nombre}
                  {submenu.permitido === submenu.predeterminado && (
                    <span className="text-xs font-normal text-slate-400">
                      Predeterminado del perfil
                    </span>
                  )}
                </span>
                <label
                  className="inline-flex items-center gap-2 text-xs font-medium text-slate-600"
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={submenu.permitido}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange(submenu.modulo, submenu.pestana, event.target.checked)
                    }
                    className="h-4 w-4 accent-lime-500"
                  />
                  Visible
                </label>
              </summary>
              <ul className="mt-2">
                {tabs.length > 0 && (
                  <>
                    <li className="pl-8 pt-2 text-[11px] font-bold uppercase text-slate-400">
                      Pestañas
                    </li>
                    {tabs.map((item) => fila(item))}
                  </>
                )}
                {actions.length > 0 && (
                  <>
                    <li className="pl-8 pt-3 text-[11px] font-bold uppercase text-slate-400">
                      Panel del tanque · Acciones
                    </li>
                    {actions.map((item) => fila(item))}
                  </>
                )}
              </ul>
            </details>
          );
        })}
      </div>
    </div>
  );
}

export default function ConfiguracionView() {
  const [usuarios, setUsuarios] = useState<UsuarioDelTenant[]>([]);
  const [elegido, setElegido] = useState<string | null>(null);
  const [modulos, setModulos] = useState<PermisoDeModulo[]>([]);
  const [alcance, setAlcance] = useState<AlcanceDeCombustible | null>(null);
  const [pestanas, setPestanas] = useState<PermisoDePestana[]>([]);
  const [esAdmin, setEsAdmin] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const detalleRef = useRef<HTMLDivElement>(null);

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
    // En mobile/tablet la lista y el detalle quedan uno debajo del otro
    // (grid-cols-1): sin esto, elegir a alguien deja el detalle fuera de
    // pantalla y parece que no pasó nada. En desktop (lg+, dos columnas
    // lado a lado) no hace falta.
    if (window.innerWidth < 1024) {
      requestAnimationFrame(() => {
        detalleRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    try {
      const permisos = await permisosDeUsuarioApi(usuarioId);
      setModulos(permisos.modulos);
      setAlcance(permisos.alcanceCombustible);
      setPestanas(permisos.pestanas ?? []);
      setEsAdmin(permisos.rol === "admin");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los permisos.");
      setModulos([]);
      setAlcance(null);
      setPestanas([]);
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

  const cambiarPestana = (modulo: string, pestana: string, permitido: boolean) => {
    setPestanas((anteriores) => {
      // Apagar un submenú apaga lo que tiene adentro: dejar un hijo prendido
      // bajo un padre apagado sería una casilla marcada que no se cumple.
      const padreDe = anteriores.find(
        (item) => item.modulo === modulo && item.pestana === pestana
      )?.padre;
      return anteriores.map((item) => {
        if (item.modulo === modulo && item.pestana === pestana) return { ...item, permitido };
        if (!permitido && item.modulo === modulo && item.padre === pestana) {
          return { ...item, permitido: false };
        }
        // Y prender un hijo prende su submenú: es lo que hace falta para
        // darle a un perfil de cancha UNA vista del Histórico sin abrirle el
        // resto (filas 24-29 de la matriz). El backend hace lo mismo.
        if (permitido && padreDe && item.modulo === modulo && item.pestana === padreDe) {
          return { ...item, permitido: true };
        }
        return item;
      });
    });
  };

  const guardar = async () => {
    if (!elegido || guardando) return;
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      const resultado = await guardarPermisosApi(elegido, {
        modulos,
        pestanas: pestanas.map(({ modulo, pestana, permitido }) => ({
          modulo,
          pestana,
          permitido,
        })),
        alcanceCombustible: alcance ?? undefined,
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
  const pestañasCombustible = pestanas.filter((item) => item.modulo === "combustible");
  const pestañasFacturacion = pestanas.filter((item) => item.modulo === "facturacion");

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-base sm:text-lg font-bold text-slate-800 tracking-tight">
          Configuración
        </h2>
        <p className="text-slate-600 text-sm">
          Qué módulos y pestañas ve cada persona, con qué nivel y, en Combustible, qué sedes y
          grifos. Solo aparecen los módulos que tu empresa tiene contratados.
        </p>
      </div>

      {error && (
        <p className="mb-4 text-sm font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
          <p className="sticky top-0 z-10 px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-widest bg-slate-50 border-b border-slate-100">
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

        <div ref={detalleRef} className="lg:col-span-2 scroll-mt-4">
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
                  {modulos.map((permiso) =>
                    permiso.modulo === "combustible" ? (
                      <li
                        key={permiso.modulo}
                        className="border border-slate-200 rounded-2xl overflow-hidden"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-start gap-3 bg-slate-50 px-4 py-3">
                          <details className="group flex-1" open={false}>
                            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-slate-800">
                              <span className="text-slate-400 transition-transform group-open:rotate-90">
                                ›
                              </span>
                              Menú: {nombreDeModulo(permiso.modulo)}
                              <span className="text-xs font-normal text-slate-400">
                                Desplegar submenús
                              </span>
                            </summary>
                            <ArbolPermisosCombustible
                              items={pestañasCombustible}
                              onChange={cambiarPestana}
                              disabled={!permiso.asignado || esAdmin}
                            />
                          </details>
                          <div className="flex gap-1 sm:shrink-0">
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
                        </div>
                      </li>
                    ) : (
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
                    )
                  )}
                </ul>
              )}

              {/* Un admin ve toda la empresa siempre: recortarle el alcance no
                  tendría efecto, así que ni se le ofrece. */}
              {alcance &&
                !esAdmin &&
                modulos.some((m) => m.modulo === "combustible" && m.asignado) && (
                  <AlcanceCombustible valor={alcance} onChange={setAlcance} />
                )}

              {pestañasFacturacion.map((item) => (
                <section
                  key={`${item.modulo}:${item.pestana}`}
                  className="border-t border-slate-200 pt-5 flex items-center justify-between gap-4"
                >
                  <div>
                    <h4 className="text-sm font-bold text-slate-800">Facturación</h4>
                    <p className="text-xs text-slate-500 mt-1">
                      Solo Admin por defecto. Habilitar aquí concede acceso al comprobante de
                      facturación del tenant.
                    </p>
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600">
                    <input
                      type="checkbox"
                      checked={item.permitido}
                      disabled={esAdmin}
                      onChange={(event) =>
                        cambiarPestana(item.modulo, item.pestana, event.target.checked)
                      }
                      className="h-4 w-4 accent-lime-500"
                    />
                    Visible
                  </label>
                </section>
              ))}

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
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
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
