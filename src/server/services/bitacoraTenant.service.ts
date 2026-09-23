/** src/server/services/bitacoraTenant.service.ts
 *
 * El **Log de eventos** de "Administración": todo lo que hace la gente de la
 * empresa, filtrable por fecha. Es la pantalla que Kenif señaló del
 * telebanking de su banco.
 *
 * ── De dónde salen los eventos ──────────────────────────────────────────
 *
 * De `platform_audit_log`, que es donde el ERP ya registra cada mutación de
 * cada módulo (ver docs/adr/0002-contrato-de-modulo.md). No hace falta una
 * tabla nueva ni empezar a escribir dos veces: lo que faltaba era poder
 * LEERLA desde la empresa, y hasta ahora solo la veía el dueño de la
 * plataforma.
 *
 * ── Qué NO sale ─────────────────────────────────────────────────────────
 *
 * Esa tabla también guarda lo que hace MINCORE: backups, restores, cambios de
 * plan, altas de tenants. Una empresa ve lo suyo -- sus usuarios actuando
 * sobre sus datos -- y además las acciones que MINCORE hizo SOBRE ella
 * (`actor_type = 'platform_admin'` con su tenant_id), que es justamente lo que
 * un cliente tiene derecho a auditar de su proveedor. No ve nada de otras
 * empresas: todo se filtra por `tenant_id`, que en esta tabla no es opcional
 * para las filas de negocio.
 *
 * `platform_audit_log` no tiene RLS (es infraestructura de plataforma, ver
 * migrations/0012), así que el filtro por tenant lo pone esta consulta y es
 * obligatorio -- de ahí que `tenantId` sea el primer parámetro y nunca venga
 * del cliente, sino de `req.tenantId`, que sale del JWT. Las consultas igual
 * corren dentro de `withTenant`, porque el JOIN con `usuarios` (para mostrar
 * sobre quién recayó cada acción) sí toca una tabla con RLS.
 */
import { withTenant } from "../config/database";

export interface EventoDeBitacora {
  id: string;
  accion: string;
  creadoEn: string;
  /** Quién lo hizo, ya resuelto a un nombre legible. */
  actor: string;
  actorTipo: string;
  usuarioId: string | null;
  /** Sobre quién recayó, cuando la acción es sobre una persona. */
  usuarioNombre: string | null;
  resultado: string;
  detalle: Record<string, unknown> | null;
  ip: string | null;
}

export interface FiltroBitacora {
  desde?: string;
  hasta?: string;
  accion?: string;
  usuarioId?: string;
  limite: number;
  /** Para "ver más": el id de la última fila de la página anterior. Se pagina
   *  por id y no por offset -- con eventos entrando todo el tiempo, un OFFSET
   *  repite y saltea filas. */
  antesDe?: string;
}

export interface PaginaDeBitacora {
  eventos: EventoDeBitacora[];
  /** El cursor para la página siguiente, o null si no hay más. */
  siguiente: string | null;
}

export async function listarBitacoraTenantService(
  tenantId: string,
  filtro: FiltroBitacora
): Promise<PaginaDeBitacora> {
  const condiciones: string[] = ["a.tenant_id = $1"];
  const valores: unknown[] = [tenantId];

  const agregar = (sql: string, valor: unknown) => {
    valores.push(valor);
    condiciones.push(sql.replace("$N", `$${valores.length}`));
  };

  // "2026-09-15" tiene que interpretarse como medianoche en Lima, sin
  // importar el TimeZone de la SESIÓN de Postgres -- `$N::date` a secas se
  // castea con ese TimeZone, y ahí está el bug real que encontró CI: en
  // local, Postgres arranca en America/Lima porque así está instalado, pero
  // el postgres:16 de CI (y casi seguro el de producción) arranca en UTC.
  // Entre las 19:00 y la medianoche en Lima, UTC ya rodó al día siguiente, y
  // "hoy" (Lima) quedaba buscando eventos desde mañana a medianoche UTC:
  // vacío, para cualquier empresa que consultara el log en esa ventana.
  // `(fecha)::timestamp AT TIME ZONE 'America/Lima'` fija la zona en la
  // CONSULTA en vez de heredarla de la sesión, así que da el mismo resultado
  // sin importar en qué TimeZone esté conectado el pool.
  if (filtro.desde)
    agregar("a.creado_en >= ($N::date)::timestamp AT TIME ZONE 'America/Lima'", filtro.desde);
  // El "hasta" se recibe como fecha (2026-09-15) y se interpreta hasta el
  // final de ese día: quien filtra "del 1 al 15" espera que el 15 entre.
  if (filtro.hasta)
    agregar(
      "a.creado_en < ($N::date + interval '1 day')::timestamp AT TIME ZONE 'America/Lima'",
      filtro.hasta
    );
  if (filtro.accion) agregar("a.accion = $N", filtro.accion);
  if (filtro.usuarioId) agregar("a.usuario_id = $N", filtro.usuarioId);
  if (filtro.antesDe) agregar("a.id < $N", filtro.antesDe);

  // Se pide uno de más para saber si hay página siguiente sin contar el total
  // (un COUNT sobre una tabla que crece sin parar es caro y no lo mira nadie).
  valores.push(filtro.limite + 1);

  // Dentro de withTenant aunque `platform_audit_log` no tenga RLS: el LEFT
  // JOIN toca `usuarios`, que sí la tiene, y su política de 0010 llama a
  // current_setting('app.tenant_id') sin missing_ok. Sin la variable seteada
  // la consulta falla antes de devolver una fila. De paso, el nombre que se
  // muestra sale filtrado por empresa por el propio RLS, no solo por el WHERE.
  const result = await withTenant(tenantId, (client) =>
    client.query(
      `SELECT a.id, a.accion, a.creado_en AS "creadoEn", a.actor_label AS actor,
              a.actor_type AS "actorTipo", a.usuario_id AS "usuarioId",
              u.nombre AS "usuarioNombre", a.resultado, a.detalle, a.ip
         FROM platform_audit_log a
         LEFT JOIN usuarios u ON u.id = a.usuario_id
        WHERE ${condiciones.join(" AND ")}
        ORDER BY a.id DESC
        LIMIT $${valores.length}`,
      valores
    )
  );

  const hayMas = result.rows.length > filtro.limite;
  const eventos = (hayMas ? result.rows.slice(0, filtro.limite) : result.rows).map((fila) => ({
    ...fila,
    id: String(fila.id),
  }));

  return {
    eventos,
    siguiente: hayMas ? eventos[eventos.length - 1].id : null,
  };
}

/** Las acciones que aparecieron en esta empresa, para llenar el filtro. Se
 *  saca de los datos y no de una lista fija: un módulo nuevo trae acciones
 *  nuevas y el filtro las tiene que ofrecer sin que nadie lo actualice. */
export async function accionesDeBitacoraService(tenantId: string): Promise<string[]> {
  const result = await withTenant(tenantId, (client) =>
    client.query(
      `SELECT DISTINCT accion FROM platform_audit_log WHERE tenant_id = $1 ORDER BY accion`,
      [tenantId]
    )
  );
  return result.rows.map((f) => f.accion as string);
}
