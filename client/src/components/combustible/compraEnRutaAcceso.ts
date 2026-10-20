// client/src/components/combustible/compraEnRutaAcceso.ts
//
// Quién ve "Compra en ruta" y con qué secciones. Va aparte del formulario para
// que App.tsx y el menú puedan preguntarlo sin importar la pantalla (que se
// carga perezosa).
//
// No hay una pestaña nueva en la matriz de permisos a propósito: la pantalla
// junta dos cosas que ya tenían permiso propio -- registrar una compra de
// combustible ("tanques:registrar_despacho") y una de urea
// ("urea:registrar_compra"). Cada sección sigue gobernada por el suyo, así que
// ningún override ya cargado por el admin queda huérfano.
//
// Es el espejo del servidor (POST /compras-ruta): exige uno de los dos permisos
// y, para cada sección que llega, el suyo; y solo deja pasar a admin, operador
// y conductor de ruta. Esto solo evita dibujar lo que daría 403.

export interface UsuarioParaCompraEnRuta {
  rol: string;
  modulosPermitidos?: string[];
  permisosPestanas?: Record<string, boolean>;
}

export interface SeccionesCompraEnRuta {
  combustible: boolean;
  urea: boolean;
}

const ROLES_QUE_COMPRAN = ["admin", "operador", "conductor_ruta"];

export function seccionesCompraEnRuta(
  usuario: UsuarioParaCompraEnRuta | null | undefined
): SeccionesCompraEnRuta {
  if (!usuario || !ROLES_QUE_COMPRAN.includes(usuario.rol)) {
    return { combustible: false, urea: false };
  }
  if (usuario.modulosPermitidos && !usuario.modulosPermitidos.includes("combustible")) {
    return { combustible: false, urea: false };
  }
  const permiso = (clave: string) => usuario.permisosPestanas?.[clave] ?? true;
  return {
    combustible: permiso("combustible:tanques:registrar_despacho"),
    urea: permiso("combustible:urea:registrar_compra"),
  };
}

export function puedeCompraEnRuta(usuario: UsuarioParaCompraEnRuta | null | undefined): boolean {
  const s = seccionesCompraEnRuta(usuario);
  return s.combustible || s.urea;
}
