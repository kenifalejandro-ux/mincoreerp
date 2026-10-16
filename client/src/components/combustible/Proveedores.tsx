// Proveedores del catálogo de combustible y urea (migrations/0063, 0065, 0092,
// 0133). Tabla con filtros por uso (interno / externo) y por producto
// (combustible / urea). Interno = compra para la planta; externo = compra en
// el recorrido de ruta. Cada proveedor tiene cuatro casillas:
//   combustible interno = abastece_tanque    combustible externo = abastece_ruta
//   urea interna        = abastece_urea      urea externa        = abastece_urea_ruta
// La lista vive en CombustiblePanel (los desplegables de los otros formularios
// la usan); acá solo se edita y se pide que la recargue.
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { IconoCisterna, IconoEstacion, IconoGota, IconoSurtidor } from "./IconosProveedor";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";

export interface ProveedorGrifo {
  id: number;
  nombre: string;
  activo: boolean;
  abastece_ruta: boolean;
  abastece_tanque: boolean;
  abastece_urea: boolean;
  abastece_urea_ruta: boolean;
}

type Roles = Pick<
  ProveedorGrifo,
  "abastece_ruta" | "abastece_tanque" | "abastece_urea" | "abastece_urea_ruta"
>;
type Uso = "todos" | "interno" | "externo";
type Producto = "todos" | "combustible" | "urea";

const COLUMNAS: {
  clave: keyof Roles;
  producto: "combustible" | "urea";
  uso: "interno" | "externo";
  etiqueta: string;
}[] = [
  {
    clave: "abastece_tanque",
    producto: "combustible",
    uso: "interno",
    etiqueta: "Combustible interno",
  },
  {
    clave: "abastece_ruta",
    producto: "combustible",
    uso: "externo",
    etiqueta: "Combustible externo",
  },
  { clave: "abastece_urea", producto: "urea", uso: "interno", etiqueta: "Urea interna" },
  { clave: "abastece_urea_ruta", producto: "urea", uso: "externo", etiqueta: "Urea externa" },
];

const rolesDe = (g: Roles): Roles => ({
  abastece_ruta: g.abastece_ruta,
  abastece_tanque: g.abastece_tanque,
  abastece_urea: g.abastece_urea,
  abastece_urea_ruta: g.abastece_urea_ruta,
});

const sinRoles = (r: Roles) => !COLUMNAS.some((c) => r[c.clave]);

/** ¿El proveedor tiene algún rol que cumpla el uso y el producto elegidos? */
function cumple(g: Roles, uso: Uso, producto: Producto) {
  return COLUMNAS.some(
    (c) =>
      g[c.clave] &&
      (uso === "todos" || c.uso === uso) &&
      (producto === "todos" || c.producto === producto)
  );
}

function Interruptor({
  activo,
  etiqueta,
  onCambio,
}: {
  activo: boolean;
  etiqueta: string;
  onCambio: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={etiqueta}
      onClick={onCambio}
      className={`relative h-5 w-9 shrink-0 rounded-sm transition-colors ${
        activo ? "bg-[#BADC1E]" : "bg-[#475569]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 transition-all ${
          activo ? "left-[18px] bg-[#0D1719]" : "left-0.5 bg-white"
        }`}
      />
    </button>
  );
}

function IconosDeRoles({ roles }: { roles: Roles }) {
  const interno = roles.abastece_tanque || roles.abastece_urea;
  const externo = roles.abastece_ruta || roles.abastece_urea_ruta;
  return (
    <span className="inline-flex items-center gap-1.5">
      {interno && (
        <span className="text-[#BADC1E]" title="Interno: abastece la planta">
          <IconoCisterna className="h-5 w-auto" />
        </span>
      )}
      {externo && (
        <span className="text-sky-400" title="Externo: compras en ruta">
          <IconoSurtidor className="h-5 w-auto" />
        </span>
      )}
    </span>
  );
}

function Chip({
  activo,
  onClick,
  icono,
  texto,
  cuenta,
}: {
  activo: boolean;
  onClick: () => void;
  icono?: React.ReactNode;
  texto: string;
  cuenta: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={activo}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${
        activo
          ? "border-[#BADC1E] bg-[#BADC1E] text-[#0D1719]"
          : "border-[#2a2e37] bg-[#192526] text-[#94a3b8] hover:text-white"
      }`}
    >
      {icono}
      {texto}
      <span className="font-mono">{cuenta}</span>
    </button>
  );
}

const ROLES_VACIOS: Roles = {
  abastece_ruta: false,
  abastece_tanque: false,
  abastece_urea: false,
  abastece_urea_ruta: false,
};

export default function Proveedores({
  grifos,
  onRecargar,
}: {
  grifos: ProveedorGrifo[];
  onRecargar: () => Promise<void> | void;
}) {
  const [uso, setUso] = useState<Uso>("todos");
  const [producto, setProducto] = useState<Producto>("todos");
  const [busca, setBusca] = useState("");
  // Roles editados y todavía sin guardar, por id. El PUT sale con "Guardar".
  const [borrador, setBorrador] = useState<Record<number, Roles>>({});
  const [guardando, setGuardando] = useState(false);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);

  const [modalAbierto, setModalAbierto] = useState(false);
  const [nombreNuevo, setNombreNuevo] = useState("");
  const [rolesNuevo, setRolesNuevo] = useState<Roles>(ROLES_VACIOS);
  const [creando, setCreando] = useState(false);
  const [errorCrear, setErrorCrear] = useState<string | null>(null);

  // Al entrar: la lista al día.
  useEffect(() => {
    void onRecargar();
  }, [onRecargar]);

  const hayCambios = (g: ProveedorGrifo) => {
    const b = borrador[g.id];
    return b !== undefined && COLUMNAS.some((c) => b[c.clave] !== g[c.clave]);
  };
  const conCambios = grifos.filter(hayCambios);

  const visibles = grifos.filter(
    (g) => cumple(g, uso, producto) && g.nombre.toLowerCase().includes(busca.trim().toLowerCase())
  );
  const nInternos = grifos.filter((g) => cumple(g, "interno", "todos")).length;
  const nExternos = grifos.filter((g) => cumple(g, "externo", "todos")).length;
  const nDesactivados = grifos.filter((g) => !g.activo).length;

  const alternarRol = (g: ProveedorGrifo, clave: keyof Roles) => {
    const actual = borrador[g.id] ?? rolesDe(g);
    setBorrador({ ...borrador, [g.id]: { ...actual, [clave]: !actual[clave] } });
    setErrorGuardar(null);
  };

  /** El PUT reemplaza la fila entera: se mandan todos los campos aunque solo
   *  cambie uno. */
  const guardarFila = (g: ProveedorGrifo, roles: Roles, activo: boolean) =>
    apiFetch(`/api/erp/combustible/grifos/${g.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: g.nombre, activo, ...roles }),
    });

  /** Activar o desactivar siempre pasa por una confirmación que nombra al
   *  proveedor: en celular la columna del nombre puede quedar fuera de la
   *  pantalla al deslizar la tabla. */
  const [porConfirmar, setPorConfirmar] = useState<ProveedorGrifo | null>(null);
  const [cambiandoEstado, setCambiandoEstado] = useState(false);
  const [errorEstado, setErrorEstado] = useState<string | null>(null);

  const handleConfirmarEstado = async () => {
    if (!porConfirmar || cambiandoEstado) return;
    setCambiandoEstado(true);
    setErrorEstado(null);
    try {
      const res = await guardarFila(porConfirmar, rolesDe(porConfirmar), !porConfirmar.activo);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorEstado(mensajeDeError(body, "No se pudo actualizar el proveedor."));
        return;
      }
      setPorConfirmar(null);
      await onRecargar();
    } finally {
      setCambiandoEstado(false);
    }
  };

  const handleGuardarCambios = async () => {
    const vacio = conCambios.find((g) => sinRoles(borrador[g.id]));
    if (vacio) {
      setErrorGuardar(`"${vacio.nombre}": marca al menos un rol.`);
      return;
    }
    setGuardando(true);
    setErrorGuardar(null);
    const fallidos: string[] = [];
    const restante = { ...borrador };
    for (const g of conCambios) {
      const res = await guardarFila(g, borrador[g.id], g.activo);
      if (res.ok) delete restante[g.id];
      else fallidos.push(g.nombre);
    }
    setBorrador(restante);
    setGuardando(false);
    await onRecargar();
    if (fallidos.length > 0) {
      setErrorGuardar(`No se pudo actualizar: ${fallidos.join(", ")}. Los demás sí se guardaron.`);
    }
  };

  const abrirModal = () => {
    setNombreNuevo("");
    setErrorCrear(null);
    const urea = producto === "urea";
    setRolesNuevo({
      abastece_tanque: !urea && uso !== "externo",
      abastece_ruta: !urea && uso !== "interno",
      abastece_urea: urea && uso !== "externo",
      abastece_urea_ruta: urea && uso !== "interno",
    });
    setModalAbierto(true);
  };

  const handleCrear = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creando || !nombreNuevo.trim()) return;
    if (sinRoles(rolesNuevo)) {
      setErrorCrear("Marca al menos un rol.");
      return;
    }
    setCreando(true);
    try {
      const res = await apiFetch("/api/erp/combustible/grifos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: nombreNuevo.trim(), ...rolesNuevo }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorCrear(mensajeDeError(body, "No se pudo crear el proveedor."));
        return;
      }
      setModalAbierto(false);
      await onRecargar();
    } finally {
      setCreando(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Proveedores</h2>
          <p className="text-sm text-[#94a3b8]">
            <strong className="text-white">Interno:</strong> compra para despachar desde la planta.{" "}
            <strong className="text-white">Externo:</strong> se compra en el recorrido de ruta.
          </p>
        </div>
        <button
          type="button"
          onClick={abrirModal}
          className="flex items-center gap-2 rounded-lg bg-[#BADC1E] px-4 py-2 font-bold text-[#0D1719] hover:brightness-110"
        >
          <Plus className="h-4 w-4" /> Nuevo proveedor
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Proveedores", grifos.length, "registrados", "text-white"],
          ["Internos", nInternos, "abastecen la planta", "text-white"],
          ["Externos", nExternos, "compras en ruta", "text-white"],
          ["Desactivados", nDesactivados, "fuera de uso", "text-amber-400"],
        ].map(([titulo, valor, nota, color]) => (
          <div
            key={titulo as string}
            className="rounded-lg border border-[#2a2e37] bg-[#192526] px-4 py-3"
          >
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#94a3b8]">
              {titulo}
            </p>
            <p className={`font-mono text-3xl font-bold ${color}`}>{valor}</p>
            <p className="text-xs text-[#64748b]">{nota}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-[#64748b]">
            Uso
          </span>
          <Chip
            activo={uso === "todos"}
            onClick={() => setUso("todos")}
            texto="Todos"
            cuenta={grifos.filter((g) => cumple(g, "todos", producto)).length}
          />
          <Chip
            activo={uso === "interno"}
            onClick={() => setUso("interno")}
            icono={<IconoCisterna className="h-3.5 w-auto" />}
            texto="Internos"
            cuenta={grifos.filter((g) => cumple(g, "interno", producto)).length}
          />
          <Chip
            activo={uso === "externo"}
            onClick={() => setUso("externo")}
            icono={<IconoSurtidor className="h-3.5 w-auto" />}
            texto="Externos"
            cuenta={grifos.filter((g) => cumple(g, "externo", producto)).length}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-[#64748b]">
            Producto
          </span>
          <Chip
            activo={producto === "todos"}
            onClick={() => setProducto("todos")}
            texto="Todos"
            cuenta={grifos.filter((g) => cumple(g, uso, "todos")).length}
          />
          <Chip
            activo={producto === "combustible"}
            onClick={() => setProducto("combustible")}
            icono={<IconoGota className="h-3.5 w-auto" />}
            texto="Combustible"
            cuenta={grifos.filter((g) => cumple(g, uso, "combustible")).length}
          />
          <Chip
            activo={producto === "urea"}
            onClick={() => setProducto("urea")}
            icono={<IconoEstacion className="h-3.5 w-auto" />}
            texto="Urea"
            cuenta={grifos.filter((g) => cumple(g, uso, "urea")).length}
          />
        </div>
        <input
          type="text"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar proveedor"
          aria-label="Buscar proveedor"
          className="min-w-[200px] max-w-xs flex-1 rounded-lg border border-[#2a2e37] bg-[#192526] px-3 py-2 text-sm text-white outline-none focus:border-[#BADC1E]"
        />
      </div>

      {/* Una fila por proveedor en todos los anchos; en celular se desliza hacia la derecha. */}
      <div className="overflow-x-auto rounded-lg border border-[#2a2e37] bg-[#192526]">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="bg-[#1d2d30] text-[11px] uppercase tracking-widest text-[#94a3b8]">
              <th rowSpan={2} className="px-4 py-3 text-left">
                Código
              </th>
              <th rowSpan={2} className="px-4 py-3 text-left">
                Proveedor
              </th>
              <th
                colSpan={2}
                className="border-b border-[#2a2e37] px-4 py-2 text-center text-[#BADC1E]"
              >
                <span className="inline-flex items-center gap-1.5">
                  <IconoGota className="h-4 w-4" /> Combustible
                </span>
              </th>
              <th
                colSpan={2}
                className="border-b border-[#2a2e37] px-4 py-2 text-center text-[#BADC1E]"
              >
                <span className="inline-flex items-center gap-1.5">
                  <IconoEstacion className="h-4 w-4" /> Urea
                </span>
              </th>
              <th rowSpan={2} className="px-4 py-3 text-left">
                Estado
              </th>
              <th rowSpan={2} className="px-4 py-3 text-right">
                Acciones
              </th>
            </tr>
            <tr className="bg-[#1d2d30] text-[10px] uppercase tracking-widest text-[#94a3b8]">
              <th className="px-4 py-2 text-center">Interno</th>
              <th className="px-4 py-2 text-center">Externo</th>
              <th className="px-4 py-2 text-center">Interno</th>
              <th className="px-4 py-2 text-center">Externo</th>
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center font-mono text-xs text-[#64748b]">
                  {grifos.length === 0
                    ? "TODAVÍA NO HAY PROVEEDORES CARGADOS"
                    : "SIN PROVEEDORES CON ESE FILTRO"}
                </td>
              </tr>
            )}
            {visibles.map((g) => {
              const roles = borrador[g.id] ?? rolesDe(g);
              const cambio = hayCambios(g);
              return (
                <tr
                  key={g.id}
                  className={`border-t border-[#2a2e37] hover:bg-[#BADC1E]/5 ${cambio ? "shadow-[inset_3px_0_0_#f59e0b]" : ""}`}
                >
                  <td className="px-3 py-2 md:px-4 md:py-3 font-mono text-xs font-bold text-white">
                    PRV-{String(g.id).padStart(3, "0")}
                  </td>
                  <td className="px-3 py-2 md:px-4 md:py-3">
                    <div className="flex items-center gap-3 whitespace-nowrap">
                      <IconosDeRoles roles={roles} />
                      <span
                        className={
                          g.activo ? "font-semibold text-white" : "text-[#64748b] line-through"
                        }
                      >
                        {g.nombre}
                      </span>
                      {cambio && (
                        <span className="font-mono text-[10px] tracking-widest text-amber-400">
                          ● SIN GUARDAR
                        </span>
                      )}
                    </div>
                  </td>
                  {COLUMNAS.map((c) => (
                    <td key={c.clave} className="px-3 py-2 md:px-4 md:py-3 text-center">
                      <Interruptor
                        activo={roles[c.clave]}
                        etiqueta={`${c.etiqueta} de ${g.nombre}`}
                        onCambio={() => alternarRol(g, c.clave)}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2 md:px-4 md:py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs font-bold ${g.activo ? "text-white" : "text-[#64748b]"}`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${g.activo ? "bg-emerald-400" : "bg-[#475569]"}`}
                      />
                      {g.activo ? "Activo" : "Desactivado"}
                    </span>
                  </td>
                  <td className="px-3 py-2 md:px-4 md:py-3 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        setErrorEstado(null);
                        setPorConfirmar(g);
                      }}
                      className="rounded border border-[#334155] px-3 py-1.5 text-xs font-bold text-[#94a3b8] hover:border-[#64748b] hover:text-white"
                    >
                      {g.activo ? "Desactivar" : "Activar"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(conCambios.length > 0 || errorGuardar) && (
        <div className="sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500 bg-[#1d2d30] px-4 py-3 shadow-2xl">
          <span className="text-sm text-white">
            {errorGuardar ? (
              <span className="text-red-400">{errorGuardar}</span>
            ) : (
              <>
                <strong className="font-mono">{conCambios.length}</strong> proveedor(es) con cambios
                sin guardar
              </>
            )}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setBorrador({});
                setErrorGuardar(null);
              }}
              disabled={guardando}
              className="rounded-lg border border-[#334155] px-4 py-2 text-sm font-medium text-[#94a3b8] hover:text-white disabled:opacity-40"
            >
              Descartar
            </button>
            <button
              type="button"
              onClick={handleGuardarCambios}
              disabled={guardando || conCambios.length === 0}
              className="rounded-lg bg-[#BADC1E] px-4 py-2 text-sm font-bold text-[#0D1719] hover:brightness-110 disabled:opacity-40"
            >
              {guardando ? "Guardando..." : `Guardar cambios (${conCambios.length})`}
            </button>
          </span>
        </div>
      )}

      {porConfirmar && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={porConfirmar.activo ? "Desactivar proveedor" : "Activar proveedor"}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D1719]/90 p-4 backdrop-blur-sm"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !cambiandoEstado) setPorConfirmar(null);
          }}
        >
          <div className="w-full max-w-sm rounded-xl border border-[#2a2e37] bg-[#192526] shadow-2xl">
            <div className="space-y-2 p-5">
              <h3 className="text-lg font-bold text-white">
                ¿Estás seguro de {porConfirmar.activo ? "desactivar" : "activar"} «
                {porConfirmar.nombre}»?
              </h3>
              <p className="text-sm text-[#94a3b8]">
                {porConfirmar.activo
                  ? "Dejará de aparecer en los desplegables de nuevos registros. Lo ya registrado se mantiene."
                  : "Volverá a aparecer en los desplegables."}
              </p>
              {errorEstado && <p className="text-sm text-red-400">{errorEstado}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-[#2a2e37] px-5 py-4">
              <button
                type="button"
                autoFocus
                onClick={() => setPorConfirmar(null)}
                disabled={cambiandoEstado}
                className="rounded-lg border border-[#334155] px-4 py-2 text-sm font-medium text-[#94a3b8] hover:text-white disabled:opacity-40"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmarEstado}
                disabled={cambiandoEstado}
                className="rounded-lg bg-[#BADC1E] px-4 py-2 text-sm font-bold text-[#0D1719] hover:brightness-110 disabled:opacity-40"
              >
                {cambiandoEstado ? "Guardando..." : porConfirmar.activo ? "Desactivar" : "Activar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalAbierto && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Nuevo proveedor"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D1719]/90 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={handleCrear}
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-[#2a2e37] bg-[#192526] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#2a2e37] bg-[#1d2d30] px-5 py-4">
              <h3 className="text-lg font-bold text-white">Nuevo proveedor</h3>
              <button
                type="button"
                onClick={() => setModalAbierto(false)}
                aria-label="Cerrar"
                className="text-[#94a3b8] hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div>
                <label
                  htmlFor="proveedor-nombre-nuevo"
                  className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-[#94a3b8]"
                >
                  Nombre
                </label>
                <input
                  id="proveedor-nombre-nuevo"
                  type="text"
                  autoFocus
                  maxLength={150}
                  placeholder="Ej. PRIMAX Bambamarca"
                  value={nombreNuevo}
                  onChange={(e) => setNombreNuevo(e.target.value)}
                  className="w-full rounded-lg border border-[#2a2e37] bg-[#0D1719] p-3 text-sm text-white outline-none focus:border-[#BADC1E]"
                />
              </div>
              {(["combustible", "urea"] as const).map((prod) => (
                <div key={prod} className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#BADC1E]">
                    {prod === "urea" ? (
                      <IconoEstacion className="h-4 w-4" />
                    ) : (
                      <IconoGota className="h-4 w-4" />
                    )}
                    {prod === "urea" ? "Urea" : "Combustible"}
                  </p>
                  {COLUMNAS.filter((c) => c.producto === prod).map((c) => (
                    <div
                      key={c.clave}
                      className="flex items-center justify-between gap-3 rounded-lg border border-[#2a2e37] bg-[#0D1719] px-3 py-2.5"
                    >
                      <span className="text-sm text-white">
                        {c.uso === "interno" ? "Interno" : "Externo"}
                        <small className="block text-[11px] text-[#64748b]">
                          {c.uso === "interno" ? "compra para la planta" : "compra en ruta"}
                        </small>
                      </span>
                      <Interruptor
                        activo={rolesNuevo[c.clave]}
                        etiqueta={c.etiqueta}
                        onCambio={() => {
                          setRolesNuevo({ ...rolesNuevo, [c.clave]: !rolesNuevo[c.clave] });
                          setErrorCrear(null);
                        }}
                      />
                    </div>
                  ))}
                </div>
              ))}
              {errorCrear && <p className="text-sm text-red-400">{errorCrear}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-[#2a2e37] px-5 py-4">
              <button
                type="button"
                onClick={() => setModalAbierto(false)}
                className="rounded-lg border border-[#334155] px-4 py-2 text-sm font-medium text-[#94a3b8] hover:text-white"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={creando || !nombreNuevo.trim()}
                className="rounded-lg bg-[#BADC1E] px-4 py-2 text-sm font-bold text-[#0D1719] hover:brightness-110 disabled:opacity-40"
              >
                {creando ? "Agregando..." : "Agregar"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
