import type { PoolClient } from "pg";

import { pool, withTenant } from "../config/database";
import { AppError } from "../shared/middlewares/error.middleware";
import type { UsuarioPayload } from "./auth.service";

export type NivelNavegacion = "submenu" | "pestana" | "accion";

export interface DefinicionPestana {
  modulo: string;
  pestana: string;
  nombre: string;
  nivel: NivelNavegacion;
  padre: string | null;
}

const pestañasTanques: DefinicionPestana[] = [
  ["importar_excel", "Importar Excel"],
  ["historial_despacho", "Historial de despacho"],
  // La CONSULTA de recepciones vive en el Histórico; acá queda lo que no
  // existe en ningún otro lado: validar la recepción contra la guía (el
  // control cruzado -- uno registra, otro valida) y anularla.
  ["gestion_recepciones", "Validar recepciones"],
  ["alertas", "Alertas"],
  ["proveedores", "Proveedores"],
  ["surtidores", "Surtidores"],
  ["precios", "Precios"],
  ["registrar_recepcion", "Registrar recepción"],
  // Repartir el excedente de una recepción que no cabe (0110). Solo cuando el
  // tanque tiene marcada la casilla "dejar decidir". No nace para el grifero:
  // el Admin decide quién.
  ["decidir_excedente", "Decidir excedente de recepción"],
  ["registrar_despacho", "Registrar despacho"],
  ["nuevo_tanque", "Nuevo tanque"],
].map(([id, nombre]) => ({
  modulo: "combustible",
  pestana: `tanques:${id}`,
  nombre,
  nivel: "pestana",
  padre: "tanques",
}));

/** Las seis vistas del selector de Histórico, cada una con su permiso: el
 *  `valor` acá es el mismo que el `<option>` de HistoricoCliente.tsx, para
 *  que el front filtre el selector con la misma clave que el back exige. */
const vistasHistorico: DefinicionPestana[] = [
  ["despachos", "Histórico de despachos (tanque propio)"],
  ["recepciones", "Histórico de recepciones de combustible"],
  ["compras_externas", "Histórico de consumo (grifo externo)"],
  ["por_conductor", "Ranking de consumo por conductor"],
  ["por_vehiculo", "Ranking de consumo por vehículo"],
  ["por_grifo", "Ranking de consumo por origen"],
  ["por_viaje", "Consumo por viaje"],
].map(([id, nombre]) => ({
  modulo: "combustible",
  pestana: `historico:${id}`,
  nombre,
  nivel: "pestana",
  padre: "historico",
}));

const accionesTanque: DefinicionPestana[] = [
  ["eliminar", "Eliminar"],
  ["editar", "Editar"],
  ["kardex", "Kardex"],
  ["registrar_lectura_varilla", "Registrar lectura de varilla"],
  ["historial_varilla", "Historial de varilla"],
  ["ver_tanque", "Ver tanque"],
  ["anular_lectura_varilla", "Anular lectura de varilla"],
].map(([id, nombre]) => ({
  modulo: "combustible",
  pestana: `tanques:acciones:${id}`,
  nombre,
  nivel: "accion",
  padre: "tanques",
}));

const accionesTanquetas: DefinicionPestana[] = [
  ["nueva", "Nueva tanqueta"],
  ["editar", "Editar tanqueta"],
].map(([id, nombre]) => ({
  modulo: "combustible",
  pestana: `tanquetas:${id}`,
  nombre,
  nivel: "accion",
  padre: "tanquetas",
}));

const accionesViajes: DefinicionPestana[] = [
  ["nuevo", "Nuevo viaje"],
  // Cerrar, editar y anular: las tres corrigen un viaje ya abierto.
  ["editar", "Editar, cerrar o anular viaje"],
  ["lugares", "Catálogo de lugares"],
].map(([id, nombre]) => ({
  modulo: "combustible",
  pestana: `viajes:${id}`,
  nombre,
  nivel: "accion",
  padre: "viajes",
}));

const pestañasUrea: DefinicionPestana[] = [
  ["registrar_vale", "Registrar vale"],
  ["registrar_entrada", "Registrar entrada"],
  // La compra de urea en ruta, con boleta o factura (0119). Aparte del vale:
  // el conductor compra en ruta pero no reparte del almacén.
  ["registrar_compra", "Registrar compra en ruta"],
  ["registrar_conteo_fisico", "Registrar conteo físico"],
  ["vista", "Vista"],
  ["exportar", "Exportar"],
  // El libro de entradas, vales y conteos con saldo corriente. Consulta pura.
  ["kardex", "Kardex"],
  // La franja de hallazgos abiertos del panel. Es visibilidad de gerencia,
  // igual que "tanques:alertas": ver el reparto por rol más abajo.
  ["hallazgos", "Hallazgos"],
  // El catálogo de precios por proveedor y presentación (0121).
  ["precios", "Precios"],
  // Los litros que trae cada envase (migración 0116). Separado de "vista"
  // porque es la palanca que mueve el stock teórico de todo lo que se
  // cargue después: ver el reparto por rol más abajo.
  ["configuracion", "Configuración"],
].map(([id, nombre]) => ({
  modulo: "combustible",
  pestana: `urea:${id}`,
  nombre,
  nivel: "pestana",
  padre: "urea",
}));

export const PESTANAS_CONFIGURABLES: DefinicionPestana[] = [
  {
    modulo: "facturacion",
    pestana: "principal",
    nombre: "Facturación",
    nivel: "submenu",
    padre: null,
  },
  { modulo: "combustible", pestana: "tanques", nombre: "Tanques", nivel: "submenu", padre: null },
  ...pestañasTanques,
  ...accionesTanque,
  {
    modulo: "combustible",
    pestana: "historico",
    nombre: "Histórico",
    nivel: "submenu",
    padre: null,
  },
  ...vistasHistorico,
  // Tanquetas / cubetas (0111): el panel con su saldo. Lectura la ve; dar de
  // alta o editar es una acción aparte que Lectura no recibe.
  {
    modulo: "combustible",
    pestana: "tanquetas",
    nombre: "Tanquetas",
    nivel: "submenu",
    padre: null,
  },
  ...accionesTanquetas,
  // Viajes (0123): A → B de una unidad. Lectura los ve; crearlos o corregirlos
  // es una acción aparte.
  { modulo: "combustible", pestana: "viajes", nombre: "Viajes", nivel: "submenu", padre: null },
  // "Mi viaje" (0124): el panel del conductor para iniciar y terminar SUS
  // viajes. Nace solo para el conductor de ruta.
  { modulo: "combustible", pestana: "mi_viaje", nombre: "Mi viaje", nivel: "submenu", padre: null },
  ...accionesViajes,
  { modulo: "combustible", pestana: "urea", nombre: "Urea", nivel: "submenu", padre: null },
  ...pestañasUrea,
  {
    modulo: "combustible",
    pestana: "auditoria",
    nombre: "Auditoría",
    nivel: "submenu",
    padre: null,
  },
  { modulo: "combustible", pestana: "bitacora", nombre: "Bitácora", nivel: "submenu", padre: null },
];

export interface PermisoPestana {
  modulo: string;
  pestana: string;
  permitido: boolean;
}

export interface PermisosPestanasDeUsuario {
  modulo: string;
  pestana: string;
  nombre: string;
  permitido: boolean;
  predeterminado: boolean;
  nivel: NivelNavegacion;
  padre: string | null;
}

export type MapaPermisosPestanas = Record<string, boolean>;

export function claveDePestana(modulo: string, pestana: string): string {
  return `${modulo}:${pestana}`;
}

export function pestanaPermitida(
  usuario: Pick<UsuarioPayload, "rol" | "permisosPestanas">,
  modulo: string,
  pestana: string
): boolean {
  if (usuario.rol === "admin") return true;
  const clave = claveDePestana(modulo, pestana);
  const definition = PESTANAS_CONFIGURABLES.find(
    (item) => item.modulo === modulo && item.pestana === pestana
  );
  if (definition?.padre && !pestanaPermitida(usuario, modulo, definition.padre)) return false;
  const override = usuario.permisosPestanas?.[clave];
  if (override !== undefined) return override;

  // Facturación es exclusiva de Admin (confirmado por Kenif, 2026-10-01):
  // ningún otro rol la ve por defecto, ni siquiera Lectura.
  if (modulo === "facturacion") return false;
  const defaults = defaultsDeRol(usuario.rol);
  if (defaults.has(pestana)) return true;

  // Un submenú apagado por defecto se abre si el admin habilitó algo ADENTRO.
  // Es el caso de las vistas del Histórico para los perfiles de cancha ("el
  // Admin decide si les da acceso a consultar", filas 24-29 de la matriz):
  // sin esto, marcarle una vista a un conductor no serviría de nada, porque
  // el corte por padre de arriba se la bloquearía igual.
  if (definition?.nivel === "submenu") {
    return PESTANAS_CONFIGURABLES.some(
      (hijo) =>
        hijo.modulo === modulo &&
        hijo.padre === pestana &&
        usuario.permisosPestanas?.[claveDePestana(modulo, hijo.pestana)] === true
    );
  }
  return false;
}

/** Matriz robusta de visibilidad por perfil (profile_user.xlsx, hoja "Matriz
 *  robusta", actualizada 2026-10-01). Esto es el DEFAULT -- "configuración
 *  predeterminada para ahorrarle la configuración a las empresas" (Kenif) --
 *  no el límite: cada tenant recorta o amplía desde Administración →
 *  Configuración, y esos overrides ganan sobre lo de acá.
 *
 *  Las tres incoherencias que el propio Excel documenta (Grifero/Combustible,
 *  Encargado/Urea, Conductor/despacho: el submenú padre dice "No visible"
 *  pero sus hijos dicen "Visible") se resuelven habilitando el submenú como
 *  entrada -- sin él, `pestanaPermitida` cortaría por el padre y el rol no
 *  podría llegar a lo único que la matriz sí le concede. */
function defaultsDeRol(rol: UsuarioPayload["rol"]): Set<string> {
  const admin = PESTANAS_CONFIGURABLES.map((item) => item.pestana);
  // Todo menos Facturación (admin-only por defecto, ver pestanaPermitida):
  // Operador ve y opera cualquier módulo -- incluye crear/editar/eliminar en
  // Combustible (ver requireRole en combustible.routes.ts).
  // "Mi viaje" es del conductor: el operador programa y cierra desde Viajes.
  const amplio = admin.filter((item) => item !== "principal" && item !== "mi_viaje");
  // Lectura: solo lo informativo. Ni "Registrar X", ni Alertas/Proveedores/
  // Surtidores/Precios/Nuevo tanque, ni las acciones de escritura del panel
  // ("No visible / acción bloqueada" en la matriz, distinto de "Solo
  // consulta"). Ve las seis vistas del Histórico.
  const lectura = [
    "tanques",
    "tanques:importar_excel",
    "tanques:historial_despacho",
    "tanques:acciones:kardex",
    "tanques:acciones:historial_varilla",
    "tanques:acciones:ver_tanque",
    "tanquetas",
    "viajes",
    "historico",
    ...vistasHistorico.map((item) => item.pestana),
    "urea",
    "urea:vista",
    "urea:exportar",
    "urea:kardex",
    "auditoria",
    "bitacora",
  ];
  // Encargado de Urea: solo Urea, nada de Tanques ni Histórico. El catálogo
  // de presentaciones queda AFUERA: cambiar los litros de la caja corre el
  // stock teórico de todo lo que se cargue después, y el encargado es la
  // misma persona que recibe, reparte y cuenta (cero segregación, ver
  // combustible.routes.ts). Darle también el número contra el que se compara
  // su propio conteo sería cerrarle el círculo. El admin se lo puede
  // habilitar a mano si decide lo contrario.
  //
  // Los HALLAZGOS también quedan afuera, por el mismo motivo que el grifero no
  // ve las alertas de combustible: son las alertas sobre el trabajo de la
  // propia persona. Que el controlado vea en tiempo real qué disparó una
  // alerta le enseña exactamente qué no repetir.
  //
  // Y el catálogo de PRECIOS (0121): es la referencia contra la que se compara
  // la boleta de cada compra en ruta. Cargarlo también el encargado sería,
  // otra vez, darle el número contra el que se lo controla.
  const fueraDelEncargado = new Set(["urea:configuracion", "urea:hallazgos", "urea:precios"]);
  const urea = [
    "urea",
    ...pestañasUrea
      .filter((item) => !fueraDelEncargado.has(item.pestana))
      .map((item) => item.pestana),
  ];
  // Grifero: lo de cancha. Anular su propia varilla mal tipeada entra, con
  // motivo obligatorio y dejando alerta (nota de la fila 21 de la matriz).
  const grifero = [
    "tanques",
    "tanques:registrar_recepcion",
    "tanques:registrar_despacho",
    "tanques:acciones:registrar_lectura_varilla",
    "tanques:acciones:anular_lectura_varilla",
    "tanques:acciones:historial_varilla",
    "tanques:acciones:ver_tanque",
  ];
  // Conductor: solo el despacho externo. Las vistas del Histórico nacen
  // apagadas para los tres perfiles de cancha -- "el Admin decide si les da
  // acceso a consultar", nota de las filas 24-29.
  //
  // 0119: también la compra de urea en ruta -- Kenif: "igual que combustible".
  // Solo eso de Urea: ni el reparto del almacén, ni los listados, ni el stock.
  const conductor = [
    "tanques",
    "tanques:registrar_despacho",
    "urea",
    "urea:registrar_compra",
    "mi_viaje",
  ];
  switch (rol) {
    case "admin":
      return new Set(admin);
    case "operador":
      return new Set(amplio);
    case "lectura":
      return new Set(lectura);
    case "grifero":
      return new Set(grifero);
    case "conductor_ruta":
      return new Set(conductor);
    case "encargado_urea":
      return new Set(urea);
  }
}

export async function mapaPermisosPestanas(
  usuarioId: string,
  tenantId: string,
  db: PoolClient | typeof pool = pool
): Promise<MapaPermisosPestanas> {
  const result = await db.query(
    `SELECT modulo, pestana, permitido
       FROM usuario_permisos_pestana
      WHERE usuario_id = $1 AND tenant_id = $2`,
    [usuarioId, tenantId]
  );
  return Object.fromEntries(
    result.rows.map((fila) => [claveDePestana(fila.modulo, fila.pestana), fila.permitido])
  );
}

export async function listarPermisosPestanasService(
  tenantId: string,
  usuarioId: string
): Promise<PermisosPestanasDeUsuario[]> {
  return withTenant(tenantId, (client) =>
    listarPermisosPestanasEnTransaccion(client, tenantId, usuarioId)
  );
}

export async function listarPermisosPestanasEnTransaccion(
  client: PoolClient,
  tenantId: string,
  usuarioId: string
): Promise<PermisosPestanasDeUsuario[]> {
  const roleResult = await client.query<{ rol: UsuarioPayload["rol"] }>(
    `SELECT rol FROM usuarios WHERE id = $1 AND tenant_id = $2`,
    [usuarioId, tenantId]
  );
  if (!roleResult.rowCount) throw new AppError(404, "Usuario no encontrado");
  const rol = roleResult.rows[0].rol;
  const rows = await client.query(
    `SELECT modulo, pestana, permitido FROM usuario_permisos_pestana
      WHERE tenant_id = $1 AND usuario_id = $2 ORDER BY modulo, pestana`,
    [tenantId, usuarioId]
  );
  const overrides = new Map(
    rows.rows.map((fila) => [claveDePestana(fila.modulo, fila.pestana), fila.permitido as boolean])
  );
  return PESTANAS_CONFIGURABLES.map(({ modulo, pestana, nombre, nivel, padre }) => {
    const defaultUser = { rol } as Pick<UsuarioPayload, "rol"> & {
      permisosPestanas: Record<string, boolean>;
    };
    const predeterminado = pestanaPermitida(defaultUser, modulo, pestana);
    const padreDefinicion = padre
      ? PESTANAS_CONFIGURABLES.find((item) => item.modulo === modulo && item.pestana === padre)
      : undefined;
    const padrePermitido = padreDefinicion
      ? (overrides.get(claveDePestana(modulo, padreDefinicion.pestana)) ??
        pestanaPermitida(defaultUser, modulo, padreDefinicion.pestana))
      : true;
    const permitidoDirecto = overrides.get(claveDePestana(modulo, pestana)) ?? predeterminado;
    return {
      modulo,
      pestana,
      nombre,
      permitido: rol === "admin" ? true : padrePermitido && permitidoDirecto,
      predeterminado,
      nivel,
      padre,
    };
  });
}

export async function guardarPermisosPestanas(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  permisos: PermisoPestana[]
): Promise<void> {
  const validas = new Set(PESTANAS_CONFIGURABLES.map((p) => claveDePestana(p.modulo, p.pestana)));
  if (permisos.some((p) => !validas.has(claveDePestana(p.modulo, p.pestana)))) {
    throw new AppError(400, "Hay una pestaña que no se puede configurar");
  }
  const usuario = await client.query<{ rol: UsuarioPayload["rol"] }>(
    `SELECT rol FROM usuarios WHERE id = $1 AND tenant_id = $2`,
    [usuarioId, tenantId]
  );
  if (!usuario.rowCount) throw new AppError(404, "Usuario no encontrado");
  const rol = usuario.rows[0].rol;
  if (rol === "admin" && permisos.some((permiso) => !permiso.permitido)) {
    throw new AppError(400, "El perfil Admin conserva acceso total a todos los módulos y pestañas");
  }

  await client.query(
    `DELETE FROM usuario_permisos_pestana WHERE tenant_id = $1 AND usuario_id = $2`,
    [tenantId, usuarioId]
  );
  for (const permiso of permisos) {
    const predeterminado = pestanaPermitida(
      { rol, permisosPestanas: {} },
      permiso.modulo,
      permiso.pestana
    );
    if (permiso.permitido === predeterminado) continue;
    await client.query(
      `INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, usuarioId, permiso.modulo, permiso.pestana, permiso.permitido]
    );
  }
}

export async function actualizarPermisosPestanasTenantService(
  tenantId: string,
  usuarioId: string,
  permisos: PermisoPestana[]
): Promise<{ pestanas: PermisosPestanasDeUsuario[]; recorta: boolean }> {
  const antes = await listarPermisosPestanasService(tenantId, usuarioId);
  await withTenant(tenantId, async (client) => {
    await guardarPermisosPestanas(client, tenantId, usuarioId, permisos);
  });
  const despues = await listarPermisosPestanasService(tenantId, usuarioId);
  const antesPorClave = new Map(
    antes.map((p) => [claveDePestana(p.modulo, p.pestana), p.permitido])
  );
  const recorta = despues.some(
    (p) => antesPorClave.get(claveDePestana(p.modulo, p.pestana)) === true && !p.permitido
  );
  return { pestanas: despues, recorta };
}
