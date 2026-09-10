/** src/server/shared/utils/moduleAudit.ts
 *
 * Parte del Contrato de Módulo (docs/adr/0002-contrato-de-modulo.md): todo
 * módulo de negocio que crea/edita/borra algo debe dejar rastro en
 * platform_audit_log, igual que ya hace platform.service.ts para las
 * acciones del panel — antes de esto ningún módulo del ERP auditaba nada.
 *
 * Uso típico en un controller:
 *   await registrarAuditoria({
 *     accion: "equipos.crear",
 *     tenantId,
 *     usuarioId: req.usuario!.id,
 *     detalle: { equipoId: equipo.id },
 *     contexto: contextoAuditoriaModulo(req),
 *   });
 *
 * `detalle` debe llevar SOLO ids/referencias, nunca el contenido de negocio
 * (mismo criterio que platform.service.ts) — la auditoría registra qué se
 * hizo y quién, no una copia de los datos del tenant.
 */
import type { Request } from "express";
import type { ContextoAuditoria } from "../../services/platformAudit.service";
import { getClientIp, getRequestId, getUserAgent } from "./request";

export function contextoAuditoriaModulo(req: Request): ContextoAuditoria {
  const usuario = req.usuario;
  if (!usuario) {
    throw new Error("contextoAuditoriaModulo requiere authMiddleware antes en la cadena");
  }

  return {
    ip: getClientIp(req),
    requestId: getRequestId(req),
    userAgent: getUserAgent(req),
    actorType: "tenant_usuario",
    // actorId queda SIN setear a propósito: platform_audit_log.actor_id
    // tiene FK contra platform_admins (migración 0016), y el autor de una
    // acción de módulo es un usuario de TENANT, que vive en `usuarios`.
    // Ponerlo acá violaba la FK en cada insert — y como registrarAuditoria
    // nunca tira (traga el error y loguea un warning), la auditoría de
    // TODOS los módulos de negocio se perdía en silencio. Se descubrió al
    // escribir el test de auditoría de cuotas: 0 filas de equipos/
    // checklists/iperc contra 4081 de plataforma.
    //
    // Quién fue va en `usuario_id` (FK contra usuarios, columna que existe
    // desde la migración 0012 y que estos call sites ya llenaban) y su
    // email en actor_label. No hace falta ninguna columna nueva.
    //
    // Desde 0084 el email puede ser NULL: un usuario de cancha entra con DNI.
    // Sin el fallback, la bitácora mostraría vacío justo para los usuarios
    // cuyas acciones más interesa poder atribuir -- el grifero que despacha.
    // El orden es correo, DNI, nombre: del más único al más ambiguo.
    actorLabel: usuario.email ?? usuario.dni ?? usuario.nombre,
  };
}
