/** src/server/services/ordenesAdmin.service.ts
 *
 * **Órdenes administrativas y doble firma** (entrega 5, migración 0091). Ver
 * docs/architecture/cuentas-perfiles-y-administracion.md §11.
 *
 * Toda acción de administración pasa por acá: un admin la PIDE con motivo, y
 * --cuando hace falta la segunda firma-- otro la aprueba o la rechaza viendo
 * el antes y el después. Con la doble firma apagada, la orden se crea y se
 * aplica de una; el correlativo y el registro quedan igual.
 *
 * ── Qué necesita dos firmas ─────────────────────────────────────────────
 *
 *   Alta de usuario                                        2
 *   Dar más permisos (tipo, módulos, subir nivel)          2
 *   Reactivar                                              2
 *   Resetear clave                                         2
 *   Cualquier cambio sobre un ADMINISTRADOR                2
 *   Apagar la doble firma                                  2
 *   Dar de baja o quitar permisos a un NO administrador    1, inmediato
 *
 * La última fila no es una excepción cómoda: cortarle el acceso a una cuenta
 * robada no puede esperar al segundo firmante, y quitar permisos nunca le da
 * ventaja a nadie. No aplica a administradores, porque ahí sí la daría: un
 * admin podría sacar al otro y quedarse solo.
 *
 * ── Lo que se revalida al aprobar ───────────────────────────────────────
 *
 * Todo. Entre que se pidió y se firma pasaron hasta 72 horas: la persona pudo
 * haberse dado de baja, el módulo pudo dejar de estar contratado, el
 * solicitante pudo dejar de ser admin. Una orden guarda lo que se PIDIÓ, no
 * un permiso para saltearse los controles cuando se aplique.
 */
import type { PoolClient } from "pg";

import { withTenant } from "../config/database";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";
import type { ContextoAuditoria } from "./platformAudit.service";
import { registrarAuditoria } from "./platformAudit.service";
import {
  cambiarEstadoUsuarioService,
  crearUsuarioEnTenantService,
  type EstadoPerfil,
} from "./platform.service";
import { resetearClaveUsuarioService } from "./auth.service";
import {
  guardarPermisosUsuarioService,
  listarPermisosUsuarioService,
  type CambioDePermisos,
} from "./permisosTenant.service";

export type TipoDeOrden =
  | "alta_usuario"
  | "baja_usuario"
  | "reactivar_usuario"
  | "desbloquear_usuario"
  | "resetear_clave"
  | "cambiar_permisos"
  | "cambiar_doble_firma";

export type EstadoDeOrden = "pendiente" | "aplicada" | "rechazada" | "vencida" | "fallida";

export interface Orden {
  id: string;
  correlativo: string;
  tipo: TipoDeOrden;
  estado: EstadoDeOrden;
  usuarioId: string | null;
  usuarioNombre: string | null;
  payload: Record<string, unknown>;
  antes: Record<string, unknown> | null;
  motivo: string;
  solicitanteId: string;
  solicitanteNombre: string;
  firmasRequeridas: number;
  aprobadorId: string | null;
  aprobadorNombre: string | null;
  motivoResolucion: string | null;
  resueltaEn: string | null;
  expiraEn: string;
  error: string | null;
  creadoEn: string;
}

/** 72 horas. Una orden más vieja que eso se aplicaría sobre un mundo que ya
 *  cambió; que la vuelvan a pedir. */
const HORAS_PARA_FIRMAR = 72;

/** ORD-2026-000123. El año adentro porque el correlativo se reinicia cada año,
 *  como cualquier numeración de documentos. */
function formatearCorrelativo(anio: number, numero: number): string {
  return `ORD-${anio}-${String(numero).padStart(6, "0")}`;
}

/** La fila cruda de `ordenes_admin`, con los nombres de columna tal cual y
 *  los tres nombres que trae el JOIN. */
interface FilaDeOrden {
  id: string;
  anio: number;
  numero: number;
  tipo: TipoDeOrden;
  estado: EstadoDeOrden;
  usuario_id: string | null;
  usuario_nombre?: string | null;
  payload: Record<string, unknown>;
  antes: Record<string, unknown> | null;
  motivo: string;
  solicitante_id: string;
  solicitante_nombre?: string | null;
  firmas_requeridas: number;
  aprobador_id: string | null;
  aprobador_nombre?: string | null;
  motivo_resolucion: string | null;
  resuelta_en: string | null;
  expira_en: string;
  error: string | null;
  creado_en: string;
}

function aOrden(fila: FilaDeOrden): Orden {
  return {
    id: fila.id,
    correlativo: formatearCorrelativo(fila.anio, fila.numero),
    tipo: fila.tipo,
    estado: fila.estado,
    usuarioId: fila.usuario_id,
    usuarioNombre: fila.usuario_nombre ?? null,
    payload: fila.payload ?? {},
    antes: fila.antes ?? null,
    motivo: fila.motivo,
    solicitanteId: fila.solicitante_id,
    solicitanteNombre: fila.solicitante_nombre ?? "",
    firmasRequeridas: fila.firmas_requeridas,
    aprobadorId: fila.aprobador_id,
    aprobadorNombre: fila.aprobador_nombre ?? null,
    motivoResolucion: fila.motivo_resolucion,
    resueltaEn: fila.resuelta_en,
    expiraEn: fila.expira_en,
    error: fila.error,
    creadoEn: fila.creado_en,
  };
}

// ═══════════════════════ Cuántas firmas hace falta ═══════════════════════

export interface DatosDeLaSolicitud {
  tipo: TipoDeOrden;
  /** Sobre quién recae. Ausente en un alta y en la doble firma. */
  usuarioId?: string;
  payload: Record<string, unknown>;
  motivo: string;
}

/** Si la empresa tiene la doble firma encendida. */
async function dobleFirmaEncendida(client: PoolClient, tenantId: string): Promise<boolean> {
  const result = await client.query(`SELECT doble_firma FROM tenants WHERE id = $1`, [tenantId]);
  return result.rows[0]?.doble_firma === true;
}

async function esAdministrador(
  client: PoolClient,
  tenantId: string,
  usuarioId: string
): Promise<boolean> {
  const result = await client.query(`SELECT rol FROM usuarios WHERE id = $1 AND tenant_id = $2`, [
    usuarioId,
    tenantId,
  ]);
  return result.rows[0]?.rol === "admin";
}

async function administradoresActivos(client: PoolClient, tenantId: string): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::int AS total FROM usuarios
      WHERE tenant_id = $1 AND rol = 'admin' AND estado = 'activo'`,
    [tenantId]
  );
  return result.rows[0].total;
}

/** ¿Este cambio de permisos le SACA algo a la persona? Lo mismo que decide en
 *  permisosTenant.service si se le cierran las sesiones. */
function permisosRecortan(
  antes: { rol: string; modulos: { modulo: string; asignado: boolean; nivel: string }[] },
  pedido: CambioDePermisos
): boolean {
  if (pedido.rol && pedido.rol !== antes.rol && pedido.rol !== "admin") return true;

  const previo = new Map(antes.modulos.map((m) => [m.modulo, m]));
  return pedido.modulos.some((ahora) => {
    const era = previo.get(ahora.modulo);
    if (!era?.asignado) return false;
    if (!ahora.asignado) return true;
    return era.nivel === "operar" && ahora.nivel === "consultas";
  });
}

/** Las reglas de la tabla del encabezado. */
async function firmasRequeridas(
  client: PoolClient,
  tenantId: string,
  solicitud: DatosDeLaSolicitud
): Promise<number> {
  if (!(await dobleFirmaEncendida(client, tenantId))) return 1;

  // Todo lo que toque a un administrador necesita dos firmas, sea lo que sea:
  // si no, un admin saca al otro y se queda solo.
  if (solicitud.usuarioId && (await esAdministrador(client, tenantId, solicitud.usuarioId))) {
    return 2;
  }

  switch (solicitud.tipo) {
    case "baja_usuario":
      // Cortar el acceso de un no administrador: una firma, ya.
      return 1;
    case "cambiar_permisos": {
      const antes = await listarPermisosUsuarioService(tenantId, solicitud.usuarioId!);
      return permisosRecortan(antes, solicitud.payload as unknown as CambioDePermisos) ? 1 : 2;
    }
    case "cambiar_doble_firma":
      // Encenderla, una firma (endurecer). Apagarla, dos.
      return solicitud.payload.dobleFirma === true ? 1 : 2;
    default:
      return 2;
  }
}

// ═══════════════════════════ Pedir una orden ═════════════════════════════

/** Cómo estaba la cosa antes, para que el segundo firmante vea el cambio sin
 *  tener que reconstruirlo. */
async function fotoDelAntes(
  client: PoolClient,
  tenantId: string,
  solicitud: DatosDeLaSolicitud
): Promise<Record<string, unknown> | null> {
  if (solicitud.tipo === "cambiar_doble_firma") {
    return { dobleFirma: await dobleFirmaEncendida(client, tenantId) };
  }
  if (!solicitud.usuarioId) return null;

  const result = await client.query(
    `SELECT nombre, email, dni, rol, estado, celular FROM usuarios
      WHERE id = $1 AND tenant_id = $2`,
    [solicitud.usuarioId, tenantId]
  );
  if (!result.rows[0]) throw new AppError(404, "Usuario no encontrado");

  if (solicitud.tipo === "cambiar_permisos") {
    const permisos = await listarPermisosUsuarioService(tenantId, solicitud.usuarioId);
    return { ...result.rows[0], modulos: permisos.modulos };
  }
  return result.rows[0];
}

export interface ResultadoSolicitud {
  orden: Orden;
  /** Lo que devolvió la acción cuando se aplicó de una (una sola firma). */
  resultado?: unknown;
}

export async function solicitarOrdenService(
  tenantId: string,
  actor: { id: string; nombre: string },
  solicitud: DatosDeLaSolicitud,
  contexto: ContextoAuditoria
): Promise<ResultadoSolicitud> {
  const { orden, firmas } = await withTenant(tenantId, async (client) => {
    const firmas = await firmasRequeridas(client, tenantId, solicitud);
    const antes = await fotoDelAntes(client, tenantId, solicitud);

    // El correlativo se toma acá adentro, con el lock puesto: dos altas
    // simultáneas en la misma empresa no pueden llevarse el mismo número.
    const anio = new Date().getFullYear();
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`orden:${tenantId}:${anio}`]);
    const siguiente = await client.query(
      `SELECT COALESCE(MAX(numero), 0) + 1 AS numero FROM ordenes_admin
        WHERE tenant_id = $1 AND anio = $2`,
      [tenantId, anio]
    );

    let fila;
    try {
      fila = await client.query(
        `INSERT INTO ordenes_admin
           (tenant_id, anio, numero, tipo, usuario_id, payload, antes, motivo,
            solicitante_id, firmas_requeridas, expira_en)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 now() + ($11 || ' hours')::interval)
         RETURNING *`,
        [
          tenantId,
          anio,
          siguiente.rows[0].numero,
          solicitud.tipo,
          solicitud.usuarioId ?? null,
          JSON.stringify(solicitud.payload),
          antes ? JSON.stringify(antes) : null,
          solicitud.motivo,
          actor.id,
          firmas,
          String(HORAS_PARA_FIRMAR),
        ]
      );
    } catch (err) {
      // El índice único parcial de 0091: ya hay una orden esperando firma
      // sobre esta misma persona.
      if ((err as { code?: string }).code === "23505") {
        throw new AppError(
          409,
          "Ya hay una orden pendiente sobre esa persona. Resolvé esa antes de pedir otra"
        );
      }
      throw err;
    }

    return { orden: fila.rows[0], firmas };
  });

  await registrarAuditoria({
    accion: "orden_admin.solicitada",
    tenantId,
    usuarioId: solicitud.usuarioId ?? null,
    detalle: {
      correlativo: formatearCorrelativo(orden.anio, orden.numero),
      tipo: solicitud.tipo,
      motivo: solicitud.motivo,
      firmasRequeridas: firmas,
    },
    contexto,
  });

  // Una sola firma: la orden se aplica en el acto. El documento queda igual.
  if (firmas === 1) {
    const aplicada = await aplicarOrden(tenantId, orden, actor, contexto);
    return { orden: aplicada.orden, resultado: aplicada.resultado };
  }

  return { orden: await leerOrden(tenantId, orden.id) };
}

// ═══════════════════════════ Firmar o rechazar ═══════════════════════════

export async function aprobarOrdenService(
  tenantId: string,
  actor: { id: string; nombre: string },
  ordenId: string,
  motivo: string | undefined,
  contexto: ContextoAuditoria
): Promise<ResultadoSolicitud> {
  const orden = await withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM ordenes_admin WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [ordenId, tenantId]
    );
    const fila = result.rows[0];
    if (!fila) throw new AppError(404, "Orden no encontrada");
    if (fila.estado !== "pendiente") {
      throw new AppError(409, `Esta orden ya está ${fila.estado}`);
    }
    if (new Date(fila.expira_en).getTime() < Date.now()) {
      await client.query(
        `UPDATE ordenes_admin SET estado = 'vencida', actualizado_en = now() WHERE id = $1`,
        [ordenId]
      );
      throw new AppError(409, "Esta orden venció. Pedila de nuevo");
    }
    if (fila.solicitante_id === actor.id) {
      // El corazón de la doble firma.
      throw new AppError(403, "No podés firmar una orden que pediste vos");
    }
    return fila;
  });

  const aplicada = await aplicarOrden(tenantId, orden, actor, contexto, motivo);
  return { orden: aplicada.orden, resultado: aplicada.resultado };
}

export async function rechazarOrdenService(
  tenantId: string,
  actor: { id: string; nombre: string },
  ordenId: string,
  motivo: string,
  contexto: ContextoAuditoria
): Promise<Orden> {
  const fila = await withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM ordenes_admin WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [ordenId, tenantId]
    );
    const orden = result.rows[0];
    if (!orden) throw new AppError(404, "Orden no encontrada");
    if (orden.estado !== "pendiente") throw new AppError(409, `Esta orden ya está ${orden.estado}`);
    if (orden.solicitante_id === actor.id) {
      throw new AppError(403, "No podés rechazar una orden que pediste vos");
    }

    await client.query(
      `UPDATE ordenes_admin
          SET estado = 'rechazada', aprobador_id = $2, motivo_resolucion = $3,
              resuelta_en = now(), actualizado_en = now()
        WHERE id = $1`,
      [ordenId, actor.id, motivo]
    );
    return orden;
  });

  await registrarAuditoria({
    accion: "orden_admin.rechazada",
    tenantId,
    usuarioId: fila.usuario_id,
    detalle: {
      correlativo: formatearCorrelativo(fila.anio, fila.numero),
      tipo: fila.tipo,
      motivo,
    },
    contexto,
  });

  return leerOrden(tenantId, ordenId);
}

// ═══════════════════════════ Aplicar la orden ════════════════════════════

/** Ejecuta lo que la orden pide, reusando los mismos servicios que usaría un
 *  cambio directo. Ahí se vuelve a validar todo: la orden no es un permiso
 *  para saltearse los controles. */
async function aplicarOrden(
  tenantId: string,
  orden: FilaDeOrden,
  actor: { id: string; nombre: string },
  contexto: ContextoAuditoria,
  motivoResolucion?: string
): Promise<{ orden: Orden; resultado?: unknown }> {
  const payload = orden.payload;

  /** Las órdenes que recaen sobre alguien SIEMPRE lo tienen: lo garantiza el
   *  tipo de orden, no el schema de la tabla (donde es nullable por el alta y
   *  la doble firma). Si faltara, la orden está mal armada y no se aplica. */
  const sobreQuien = (): string => {
    if (!orden.usuario_id) {
      throw new AppError(409, "La orden no dice sobre quién se aplica");
    }
    return orden.usuario_id;
  };

  try {
    let resultado: unknown;

    switch (orden.tipo as TipoDeOrden) {
      case "alta_usuario":
        resultado = await crearUsuarioEnTenantService(tenantId, payload as never, contexto);
        break;

      case "baja_usuario":
      case "reactivar_usuario":
      case "desbloquear_usuario": {
        const estado: EstadoPerfil = orden.tipo === "baja_usuario" ? "inactivo" : "activo";
        resultado = await cambiarEstadoUsuarioService(
          tenantId,
          sobreQuien(),
          estado,
          orden.motivo,
          contexto
        );
        break;
      }

      case "resetear_clave": {
        const usuario = await resetearClaveUsuarioService(
          tenantId,
          sobreQuien(),
          payload.password as string
        );
        // La acción propia además de la de la orden: quien busca en el log
        // "a quién le resetearon la clave" no tiene por qué saber que eso hoy
        // pasa por una orden. Nunca la contraseña: solo a quién y CÓMO
        // (`correo-enviado` = el admin no puso ninguna, la elige la persona).
        await registrarAuditoria({
          accion: "resetear_clave_usuario",
          tenantId,
          usuarioId: usuario.id,
          detalle: { identificador: usuario.email ?? usuario.dni, modo: usuario.modo },
          contexto,
        });
        resultado = usuario;
        break;
      }

      case "cambiar_permisos":
        resultado = await guardarPermisosUsuarioService(
          tenantId,
          sobreQuien(),
          payload as unknown as CambioDePermisos,
          // Quien APLICA es quien firma. Que no pueda tocarse sus propios
          // permisos sigue valiendo, y ahora también impide que alguien se los
          // cambie a sí mismo pidiéndolo y firmándolo otro... no: eso es
          // exactamente lo que la doble firma permite y está bien. Lo que se
          // impide es firmar lo propio, que se chequea al aprobar.
          actor.id
        );
        // El antes y el después completos, igual que antes de las órdenes:
        // sin eso, meses después nadie puede reconstruir por qué alguien
        // tenía el acceso que tenía.
        {
          const cambio = resultado as {
            antes: { rol: string; modulos: unknown };
            despues: { rol: string; modulos: unknown };
            recorta: boolean;
          };
          await registrarAuditoria({
            accion: "cambiar_permisos_usuario",
            tenantId,
            usuarioId: orden.usuario_id,
            detalle: {
              motivo: orden.motivo,
              recorta: cambio.recorta,
              antes: cambio.antes,
              despues: cambio.despues,
            },
            contexto,
          });
        }
        break;

      case "cambiar_doble_firma":
        resultado = await aplicarDobleFirma(tenantId, payload.dobleFirma === true);
        break;
    }

    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE ordenes_admin
            SET estado = 'aplicada', aprobador_id = $2, motivo_resolucion = $3,
                resuelta_en = now(), actualizado_en = now()
          WHERE id = $1`,
        [orden.id, actor.id, motivoResolucion ?? null]
      )
    );

    await registrarAuditoria({
      accion: "orden_admin.aplicada",
      tenantId,
      usuarioId: orden.usuario_id,
      detalle: {
        correlativo: formatearCorrelativo(orden.anio, orden.numero),
        tipo: orden.tipo,
        // Las dos firmas, que es lo que hay que poder mostrar meses después.
        solicitanteId: orden.solicitante_id,
        aprobadorId: actor.id,
        firmasRequeridas: orden.firmas_requeridas,
      },
      contexto,
    });

    return { orden: await leerOrden(tenantId, orden.id), resultado };
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : "No se pudo aplicar la orden";
    // La orden queda como fallida y NO se pierde: dice qué se pidió, quién lo
    // firmó y por qué no se pudo.
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE ordenes_admin
            SET estado = 'fallida', aprobador_id = $2, error = $3,
                resuelta_en = now(), actualizado_en = now()
          WHERE id = $1`,
        [orden.id, actor.id, mensaje]
      )
    ).catch((errorAlMarcar) => {
      logger.error({ err: errorAlMarcar }, "No se pudo marcar la orden como fallida");
    });

    await registrarAuditoria({
      accion: "orden_admin.fallida",
      tenantId,
      usuarioId: orden.usuario_id,
      detalle: {
        correlativo: formatearCorrelativo(orden.anio, orden.numero),
        tipo: orden.tipo,
        error: mensaje,
      },
      contexto,
      resultado: "failure",
    });

    throw err;
  }
}

/** Encender o apagar la doble firma. Encenderla exige dos administradores
 *  activos: con uno solo, la empresa se traba en la primera orden que pida --
 *  nadie podría firmarla, porque nadie firma lo propio. */
async function aplicarDobleFirma(
  tenantId: string,
  encender: boolean
): Promise<{ dobleFirma: boolean }> {
  await withTenant(tenantId, async (client) => {
    if (encender && (await administradoresActivos(client, tenantId)) < 2) {
      throw new AppError(
        400,
        "Para activar la doble firma hacen falta dos administradores activos: nadie puede firmar sus propias órdenes"
      );
    }
    await client.query(`UPDATE tenants SET doble_firma = $2 WHERE id = $1`, [tenantId, encender]);
  });
  return { dobleFirma: encender };
}

// ═══════════════════════════════ Consultas ═══════════════════════════════

const SELECT_ORDEN = `
  SELECT o.*, u.nombre AS usuario_nombre,
         s.nombre AS solicitante_nombre, a.nombre AS aprobador_nombre
    FROM ordenes_admin o
    LEFT JOIN usuarios u ON u.id = o.usuario_id
    LEFT JOIN usuarios s ON s.id = o.solicitante_id
    LEFT JOIN usuarios a ON a.id = o.aprobador_id`;

async function leerOrden(tenantId: string, ordenId: string): Promise<Orden> {
  const fila = await withTenant(tenantId, (client) =>
    client.query(`${SELECT_ORDEN} WHERE o.id = $1 AND o.tenant_id = $2`, [ordenId, tenantId])
  );
  if (!fila.rows[0]) throw new AppError(404, "Orden no encontrada");
  return aOrden(fila.rows[0]);
}

export async function listarOrdenesService(
  tenantId: string,
  filtro: { estado?: EstadoDeOrden; limite?: number } = {}
): Promise<Orden[]> {
  // Las vencidas se marcan al leer: sin un worker que las persiga, una orden
  // sin firmar quedaría "pendiente" para siempre en la pantalla.
  await withTenant(tenantId, (client) =>
    client.query(
      `UPDATE ordenes_admin SET estado = 'vencida', actualizado_en = now()
        WHERE tenant_id = $1 AND estado = 'pendiente' AND expira_en < now()`,
      [tenantId]
    )
  );

  const condiciones = ["o.tenant_id = $1"];
  const valores: unknown[] = [tenantId];
  if (filtro.estado) {
    valores.push(filtro.estado);
    condiciones.push(`o.estado = $${valores.length}`);
  }
  valores.push(Math.min(filtro.limite ?? 100, 500));

  const result = await withTenant(tenantId, (client) =>
    client.query(
      `${SELECT_ORDEN} WHERE ${condiciones.join(" AND ")}
        ORDER BY o.creado_en DESC LIMIT $${valores.length}`,
      valores
    )
  );
  return result.rows.map(aOrden);
}

export async function estadoDobleFirmaService(
  tenantId: string
): Promise<{ dobleFirma: boolean; administradoresActivos: number }> {
  return withTenant(tenantId, async (client) => ({
    dobleFirma: await dobleFirmaEncendida(client, tenantId),
    administradoresActivos: await administradoresActivos(client, tenantId),
  }));
}

/** Con la doble firma encendida no se puede dar de baja al penúltimo
 *  administrador: quedaría uno solo, y con uno solo no hay quien firme. Se
 *  chequea al PEDIR la baja y otra vez al aplicarla. */
export async function verificarNoDejaSinFirmantes(
  tenantId: string,
  usuarioId: string
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    if (!(await dobleFirmaEncendida(client, tenantId))) return;
    if (!(await esAdministrador(client, tenantId, usuarioId))) return;
    if ((await administradoresActivos(client, tenantId)) > 2) return;

    throw new AppError(
      400,
      "Con la doble firma activa no podés quedarte con un solo administrador. Nombrá a otro primero, o pedile a MinCore que lo reemplace"
    );
  });
}
