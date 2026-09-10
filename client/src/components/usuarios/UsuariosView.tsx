// client/src/components/usuarios/UsuariosView.tsx
//
// Quién de la empresa puede entrar al sistema. La administra el admin del
// propio tenant, no el dueño del ERP: con decenas de personas de cancha que
// además rotan, hacer pasar cada alta y cada baja por el proveedor lo dejaba
// de operador permanente del personal de sus clientes.
//
// ── Por qué la clave temporal se muestra UNA sola vez ────────────────────
//
// El personal de cancha entra con DNI y no tiene correo (migración 0084), así
// que "olvidé mi contraseña" -- que manda un enlace por mail -- no existe para
// ellos. El reemplazo es que el admin le ponga una clave y se la dicte.
//
// Esa clave se muestra acá y no vuelve a estar disponible en ningún lado: no
// se guarda, no se puede volver a ver, y el servidor solo tiene su hash. Si se
// pierde, se resetea de nuevo. Guardarla "por las dudas" sería tener las
// contraseñas del personal en texto plano, que es exactamente lo que un ERP
// con trazabilidad de vales no puede permitirse: si el admin sabe la clave con
// la que el grifero firma, la firma del grifero deja de significar algo.
import { useCallback, useEffect, useState } from "react";

import { useAuth } from "../../context/AuthContext";
import {
  cambiarEstadoUsuarioApi,
  crearUsuarioApi,
  generarClaveTemporal,
  listarUsuariosApi,
  resetearClaveApi,
  type RolUsuario,
  type UsuarioDelTenant,
} from "../../services/usuariosApi";

/** El texto importa más que la etiqueta: quien elige acá es el jefe de
 *  operaciones, no un administrador de sistemas.
 *
 *  Van separados en dos grupos porque no son una escalera. Oficina sí lo es
 *  --admin puede todo lo que puede operador, y operador todo lo de lectura--
 *  pero los de cancha son recortes laterales, en direcciones distintas entre
 *  sí: el grifero puede lo del tanque y nada de ruta, el conductor al revés.
 *  Mostrarlos en una sola lista invitaría a leerlos como "menos que lectura",
 *  que es falso: un conductor de ruta registra compras, y el de lectura no. */
const ROLES: { valor: RolUsuario; titulo: string; detalle: string; cancha?: boolean }[] = [
  {
    valor: "operador",
    titulo: "Operador",
    detalle: "Carga el trabajo del día: vales, varillas, checklists. No cambia configuración.",
  },
  {
    valor: "lectura",
    titulo: "Solo lectura",
    detalle: "Ve y exporta, no toca nada. Para gerencia, contabilidad o una auditoría externa.",
  },
  {
    valor: "admin",
    titulo: "Administrador",
    detalle: "Todo lo anterior, más los umbrales, las alertas y esta misma pantalla.",
  },
  {
    valor: "grifero",
    titulo: "Grifero",
    detalle:
      "Solo Combustible: vales del tanque, recepción del camión y varilla. No anula ni ve alertas.",
    cancha: true,
  },
  {
    valor: "conductor_ruta",
    titulo: "Conductor de ruta",
    detalle: "Solo Combustible: cargas en grifos externos. Nada del tanque de la empresa.",
    cancha: true,
  },
];

/** Lo que la persona escribe en el login. Nunca los dos a la vez: el que
 *  tiene correo entra con correo, el de cancha con su documento. */
function identificador(u: UsuarioDelTenant) {
  return u.email ?? u.dni ?? "---";
}

export default function UsuariosView() {
  const { usuario: yo } = useAuth();
  const [usuarios, setUsuarios] = useState<UsuarioDelTenant[]>([]);
  const [cargando, setCargando] = useState(true);
  const [busqueda, setBusqueda] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [modalAlta, setModalAlta] = useState(false);
  const [usuarioAResetear, setUsuarioAResetear] = useState<UsuarioDelTenant | null>(null);
  const [usuarioADarDeBaja, setUsuarioADarDeBaja] = useState<UsuarioDelTenant | null>(null);
  const [enviando, setEnviando] = useState(false);

  // Lo único que se muestra una vez y no se puede recuperar.
  const [claveParaDictar, setClaveParaDictar] = useState<{
    nombre: string;
    identificador: string;
    clave: string;
    esAlta: boolean;
  } | null>(null);

  const cargar = useCallback(async () => {
    try {
      setUsuarios(await listarUsuariosApi());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la lista.");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  const filtrados = usuarios.filter((u) => {
    const texto = busqueda.trim().toLowerCase();
    if (!texto) return true;
    return (
      u.nombre.toLowerCase().includes(texto) ||
      (u.email ?? "").toLowerCase().includes(texto) ||
      (u.dni ?? "").includes(texto)
    );
  });

  if (cargando) return <div className="p-20 text-center text-slate-500">Cargando...</div>;

  return (
    <div className="p-4 lg:p-8 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Usuarios</h1>
          <p className="text-slate-600">Quién puede entrar al sistema, y con qué permisos</p>
        </div>
        <button
          onClick={() => setModalAlta(true)}
          className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
        >
          + Nuevo usuario
        </button>
      </div>

      {error && (
        <p className="mb-6 text-sm font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          {error}
        </p>
      )}

      <div className="mb-6">
        <input
          type="text"
          placeholder="Buscar por nombre, correo o DNI..."
          className="w-full bg-white border border-slate-200 rounded-2xl px-5 py-4 outline-none focus:ring-2 focus:ring-slate-900 transition-all shadow-sm"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
        />
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl overflow-x-auto shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead className="bg-slate-50">
            <tr>
              <th className="p-5 text-xs font-bold text-slate-500 uppercase tracking-widest">
                nombre
              </th>
              <th className="p-5 text-xs font-bold text-slate-500 uppercase tracking-widest">
                entra con
              </th>
              <th className="p-5 text-xs font-bold text-slate-500 uppercase tracking-widest">
                rol
              </th>
              <th className="p-5 text-xs font-bold text-slate-500 uppercase tracking-widest">
                estado
              </th>
              <th className="p-5 text-xs font-bold text-slate-500 uppercase tracking-widest text-right">
                acciones
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtrados.map((u) => (
              <tr key={u.id} className="hover:bg-slate-50/50 transition-colors">
                <td className="p-5 text-sm font-semibold text-slate-800">
                  {u.nombre}
                  {u.id === yo?.id && (
                    <span className="ml-2 text-xs font-bold text-slate-500">(vos)</span>
                  )}
                </td>
                <td className="p-5 text-sm">
                  <span className="font-mono text-slate-700">{identificador(u)}</span>
                  {!u.email && u.dni && (
                    <span className="ml-2 px-2 py-0.5 rounded-full bg-slate-100 text-[11px] font-bold text-slate-600 uppercase">
                      DNI
                    </span>
                  )}
                </td>
                <td className="p-5 text-sm font-medium text-slate-700">
                  {ROLES.find((r) => r.valor === u.rol)?.titulo ?? u.rol}
                </td>
                <td className="p-5 text-sm">
                  <span className={`font-bold ${u.activo ? "text-emerald-700" : "text-slate-500"}`}>
                    {u.activo ? "Activo" : "Dado de baja"}
                  </span>
                </td>
                <td className="p-5 text-right whitespace-nowrap">
                  <button
                    onClick={() => setUsuarioAResetear(u)}
                    disabled={!u.activo}
                    className="px-3 py-1.5 text-xs font-bold text-slate-700 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Resetear clave
                  </button>
                  {u.activo ? (
                    <button
                      onClick={() => setUsuarioADarDeBaja(u)}
                      disabled={u.id === yo?.id}
                      title={u.id === yo?.id ? "No podés darte de baja a vos mismo" : "Dar de baja"}
                      className="ml-2 px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Dar de baja
                    </button>
                  ) : (
                    <button
                      onClick={async () => {
                        setEnviando(true);
                        try {
                          await cambiarEstadoUsuarioApi(u.id, true);
                          await cargar();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "No se pudo reactivar.");
                        } finally {
                          setEnviando(false);
                        }
                      }}
                      disabled={enviando}
                      className="ml-2 px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 rounded-lg transition-all disabled:opacity-40"
                    >
                      Reactivar
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {filtrados.length === 0 && (
              <tr>
                <td colSpan={5} className="p-10 text-center text-sm text-slate-500">
                  No hay usuarios que coincidan con la búsqueda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modalAlta && (
        <ModalAlta
          onCerrar={() => setModalAlta(false)}
          onCreado={async (datos) => {
            setModalAlta(false);
            setClaveParaDictar({ ...datos, esAlta: true });
            await cargar();
          }}
        />
      )}

      {usuarioAResetear && (
        <ModalResetearClave
          usuario={usuarioAResetear}
          onCerrar={() => setUsuarioAResetear(null)}
          onListo={(clave) => {
            setClaveParaDictar({
              nombre: usuarioAResetear.nombre,
              identificador: identificador(usuarioAResetear),
              clave,
              esAlta: false,
            });
            setUsuarioAResetear(null);
          }}
        />
      )}

      {usuarioADarDeBaja && (
        <ModalDarDeBaja
          usuario={usuarioADarDeBaja}
          onCerrar={() => setUsuarioADarDeBaja(null)}
          onListo={async () => {
            setUsuarioADarDeBaja(null);
            await cargar();
          }}
        />
      )}

      {claveParaDictar && (
        <ClaveParaDictar datos={claveParaDictar} onCerrar={() => setClaveParaDictar(null)} />
      )}
    </div>
  );
}

// ── Alta ─────────────────────────────────────────────────────────────────

function ModalAlta({
  onCerrar,
  onCreado,
}: {
  onCerrar: () => void;
  onCreado: (datos: {
    nombre: string;
    identificador: string;
    clave: string;
  }) => void | Promise<void>;
}) {
  // El DNI primero, y el correo abajo marcado como opcional: el caso masivo
  // es el de cancha. Un formulario que arranca pidiendo correo empuja a
  // inventar uno, y un correo inventado no recibe nada -- la recuperación de
  // contraseña no funcionaría, solo lo parecería.
  const [nombre, setNombre] = useState("");
  const [dni, setDni] = useState("");
  const [email, setEmail] = useState("");
  const [rol, setRol] = useState<RolUsuario>("operador");
  const [clave, setClave] = useState(generarClaveTemporal);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    if (!dni.trim() && !email.trim()) {
      setError("Cargá un DNI o un correo: sin ninguno de los dos no podría entrar.");
      return;
    }
    setEnviando(true);
    setError(null);
    try {
      await crearUsuarioApi({
        nombre: nombre.trim(),
        dni: dni.trim() || undefined,
        email: email.trim() || undefined,
        password: clave,
        rol,
      });
      await onCreado({
        nombre: nombre.trim(),
        identificador: email.trim() || dni.trim(),
        clave,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el usuario.");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal titulo="Nuevo usuario" onCerrar={onCerrar}>
      <form onSubmit={enviar} className="p-6 space-y-4">
        <Campo id="usuario-nombre" etiqueta="Nombre y apellido">
          <input
            id="usuario-nombre"
            type="text"
            required
            maxLength={100}
            placeholder="Ej: Juan Pérez Quispe"
            className={ESTILO_INPUT}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
          />
        </Campo>

        <Campo
          id="usuario-dni"
          etiqueta="DNI"
          ayuda="Con esto entra al sistema el personal de cancha."
        >
          <input
            id="usuario-dni"
            type="text"
            inputMode="numeric"
            maxLength={15}
            placeholder="Ej: 45871203"
            className={ESTILO_INPUT}
            value={dni}
            onChange={(e) => setDni(e.target.value)}
          />
        </Campo>

        <Campo
          id="usuario-email"
          etiqueta="Correo (opcional)"
          ayuda="Solo para quien tenga uno de verdad: es el único que después puede recuperar su clave solo."
        >
          <input
            id="usuario-email"
            type="email"
            maxLength={150}
            placeholder="Ej: jperez@empresa.com"
            className={ESTILO_INPUT}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Campo>

        <fieldset className="space-y-2">
          <legend className="text-xs font-bold text-slate-700 uppercase mb-1">
            Qué puede hacer
          </legend>
          <OpcionesDeRol
            titulo="En la oficina"
            opciones={ROLES.filter((r) => !r.cancha)}
            elegido={rol}
            onElegir={setRol}
          />
          <OpcionesDeRol
            titulo="En cancha"
            ayuda="Solo ven Combustible. No hace falta que les saques los demás módulos a mano."
            opciones={ROLES.filter((r) => r.cancha)}
            elegido={rol}
            onElegir={setRol}
          />
        </fieldset>

        <Campo
          id="usuario-clave"
          etiqueta="Clave temporal"
          ayuda="Se la vas a dictar a la persona. El sistema la obliga a cambiarla apenas entre."
        >
          <div className="flex gap-2">
            <input
              id="usuario-clave"
              type="text"
              required
              minLength={8}
              className={`${ESTILO_INPUT} font-mono`}
              value={clave}
              onChange={(e) => setClave(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setClave(generarClaveTemporal())}
              className="px-3 py-2 text-xs font-bold text-slate-700 border border-slate-200 rounded-xl hover:bg-slate-50 whitespace-nowrap"
            >
              Otra
            </button>
          </div>
        </Campo>

        {error && <p className="text-sm font-semibold text-red-700">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <BotonCancelar onClick={onCerrar} />
          <BotonPrincipal enviando={enviando}>Crear usuario</BotonPrincipal>
        </div>
      </form>
    </Modal>
  );
}

// ── Reset de clave ───────────────────────────────────────────────────────

function ModalResetearClave({
  usuario,
  onCerrar,
  onListo,
}: {
  usuario: UsuarioDelTenant;
  onCerrar: () => void;
  onListo: (clave: string) => void;
}) {
  const [clave, setClave] = useState(generarClaveTemporal);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await resetearClaveApi(usuario.id, clave);
      onListo(clave);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo resetear la clave.");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal titulo={`Resetear la clave de ${usuario.nombre}`} onCerrar={onCerrar}>
      <form onSubmit={enviar} className="p-6 space-y-4">
        <p className="text-sm text-slate-700">
          Se le va a pedir que la cambie apenas entre, y{" "}
          <strong className="font-bold text-slate-900">
            se cierran todas las sesiones que tenga abiertas
          </strong>{" "}
          en cualquier dispositivo.
        </p>

        <Campo id="reset-clave" etiqueta="Clave temporal">
          <div className="flex gap-2">
            <input
              id="reset-clave"
              type="text"
              required
              minLength={8}
              className={`${ESTILO_INPUT} font-mono`}
              value={clave}
              onChange={(e) => setClave(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setClave(generarClaveTemporal())}
              className="px-3 py-2 text-xs font-bold text-slate-700 border border-slate-200 rounded-xl hover:bg-slate-50 whitespace-nowrap"
            >
              Otra
            </button>
          </div>
        </Campo>

        {error && <p className="text-sm font-semibold text-red-700">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <BotonCancelar onClick={onCerrar} />
          <BotonPrincipal enviando={enviando}>Resetear</BotonPrincipal>
        </div>
      </form>
    </Modal>
  );
}

// ── Baja ─────────────────────────────────────────────────────────────────

function ModalDarDeBaja({
  usuario,
  onCerrar,
  onListo,
}: {
  usuario: UsuarioDelTenant;
  onCerrar: () => void;
  onListo: () => void | Promise<void>;
}) {
  // El motivo es obligatorio del lado del servidor también: dejar a alguien
  // afuera del sistema es una acción correctiva, como anular un vale, y las
  // correctivas de este ERP se explican.
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await cambiarEstadoUsuarioApi(usuario.id, false, motivo.trim());
      await onListo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo dar de baja.");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal titulo={`Dar de baja a ${usuario.nombre}`} onCerrar={onCerrar}>
      <form onSubmit={enviar} className="p-6 space-y-4">
        <p className="text-sm text-slate-700">
          Deja de poder entrar de inmediato y se le cierran las sesiones abiertas.{" "}
          <strong className="font-bold text-slate-900">No se borra nada de lo que cargó</strong>:
          los vales, las varillas y los checklists que firmó siguen ahí, con su nombre.
        </p>

        <Campo
          id="baja-motivo"
          etiqueta="Motivo"
          ayuda="Queda en la bitácora. Sirve cuando alguien pregunte, meses después, por qué esta persona dejó de aparecer."
        >
          <input
            id="baja-motivo"
            type="text"
            required
            maxLength={500}
            placeholder="Ej: dejó la empresa el 30/09"
            className={ESTILO_INPUT}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
        </Campo>

        {error && <p className="text-sm font-semibold text-red-700">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <BotonCancelar onClick={onCerrar} />
          <BotonPrincipal enviando={enviando} peligro>
            Dar de baja
          </BotonPrincipal>
        </div>
      </form>
    </Modal>
  );
}

// ── La clave, una sola vez ───────────────────────────────────────────────

function ClaveParaDictar({
  datos,
  onCerrar,
}: {
  datos: { nombre: string; identificador: string; clave: string; esAlta: boolean };
  onCerrar: () => void;
}) {
  const [copiado, setCopiado] = useState(false);

  return (
    <Modal titulo={datos.esAlta ? "Usuario creado" : "Clave reseteada"} onCerrar={onCerrar}>
      <div className="p-6 space-y-4">
        <p className="text-sm text-slate-700">
          Dictale estos datos a <strong className="font-bold text-slate-900">{datos.nombre}</strong>
          .
        </p>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div>
            <span className="block text-xs font-bold text-slate-500 uppercase">Entra con</span>
            <span className="block font-mono text-lg font-bold text-slate-900 break-all">
              {datos.identificador}
            </span>
          </div>
          <div>
            <span className="block text-xs font-bold text-slate-500 uppercase">Clave temporal</span>
            <span className="block font-mono text-lg font-bold text-slate-900 break-all">
              {datos.clave}
            </span>
          </div>
        </div>

        <p className="text-sm font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          Esta clave no se vuelve a mostrar. Si se pierde, se resetea de nuevo — nadie, ni vos ni el
          soporte, puede verla después.
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(`${datos.identificador} / ${datos.clave}`)
                .then(() => setCopiado(true))
                // Sin permiso de portapapeles (o sin HTTPS) no pasa nada: la
                // clave está a la vista para dictarla igual.
                .catch(() => setCopiado(false));
            }}
            className="px-4 py-2.5 text-sm font-bold text-slate-700 border border-slate-200 rounded-xl hover:bg-slate-50"
          >
            {copiado ? "Copiado" : "Copiar"}
          </button>
          <button
            type="button"
            onClick={onCerrar}
            className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-bold rounded-xl"
          >
            Ya la anoté
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Piezas compartidas ───────────────────────────────────────────────────

const ESTILO_INPUT =
  "w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900";

function Modal({
  titulo,
  onCerrar,
  children,
}: {
  titulo: string;
  onCerrar: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl animate-in zoom-in duration-200 max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b flex justify-between items-center gap-4">
          <h3 className="text-xl font-bold text-slate-900">{titulo}</h3>
          <button
            onClick={onCerrar}
            aria-label="Cerrar"
            className="text-slate-400 hover:text-slate-900 text-2xl leading-none"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Campo({
  id,
  etiqueta,
  ayuda,
  children,
}: {
  id: string;
  etiqueta: string;
  ayuda?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-bold text-slate-700 uppercase">
        {etiqueta}
      </label>
      {children}
      {ayuda && <p className="text-xs text-slate-600">{ayuda}</p>}
    </div>
  );
}

function OpcionesDeRol({
  titulo,
  ayuda,
  opciones,
  elegido,
  onElegir,
}: {
  titulo: string;
  ayuda?: string;
  opciones: (typeof ROLES)[number][];
  elegido: RolUsuario;
  onElegir: (rol: RolUsuario) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider pt-1">{titulo}</p>
      {ayuda && <p className="text-xs text-slate-600 -mt-1">{ayuda}</p>}
      {opciones.map((r) => (
        <label
          key={r.valor}
          className={`flex gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
            elegido === r.valor
              ? "border-slate-900 bg-slate-50"
              : "border-slate-200 hover:border-slate-300"
          }`}
        >
          <input
            type="radio"
            name="rol"
            className="mt-1"
            checked={elegido === r.valor}
            onChange={() => onElegir(r.valor)}
          />
          <span>
            <span className="block text-sm font-bold text-slate-800">{r.titulo}</span>
            <span className="block text-xs text-slate-600">{r.detalle}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function BotonCancelar({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-xl"
    >
      Cancelar
    </button>
  );
}

function BotonPrincipal({
  enviando,
  peligro,
  children,
}: {
  enviando: boolean;
  peligro?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={enviando}
      className={`px-6 py-2.5 text-white text-sm font-bold rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
        peligro ? "bg-red-700 hover:bg-red-800" : "bg-slate-900 hover:bg-slate-800"
      }`}
    >
      {enviando ? "Guardando..." : children}
    </button>
  );
}
