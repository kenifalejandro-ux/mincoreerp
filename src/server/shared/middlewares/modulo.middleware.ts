/** src/server/shared/middlewares/modulo.middleware.ts */

import type { Request, Response, NextFunction } from "express";

/** Debe usarse siempre después de authMiddleware. Bloquea un módulo entero
 *  (repuestos, combustible, etc.) si el tenant no lo tiene contratado o si
 *  el panel de plataforma no se lo asignó a este usuario en particular —
 *  ver modulosPermitidos en UsuarioPayload (auth.service.ts). */
export function requireModulo(modulo: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const usuario = req.usuario;
    if (!usuario) {
      return res.status(401).json({ ok: false, message: "No autenticado" });
    }
    if (!usuario.modulosPermitidos.includes(modulo)) {
      return res.status(403).json({ ok: false, message: "Módulo no disponible" });
    }
    next();
  };
}

/** Los métodos que no escriben nada. HEAD y OPTIONS entran porque el
 *  navegador los manda solo: bloquearlos rompería el preflight de CORS sin
 *  proteger nada. */
const METODOS_DE_LECTURA = new Set(["GET", "HEAD", "OPTIONS"]);

/** Nivel del módulo (migración 0089, las "autonomías"): quien lo tiene en
 *  `consultas` lo ve y lo exporta, pero no escribe.
 *
 *  Se aplica por MÉTODO y no ruta por ruta, a propósito: un módulo nuevo, o
 *  un endpoint nuevo dentro de uno existente, queda cubierto sin que nadie se
 *  acuerde de agregarlo. En un control de acceso, lo que hay que acordarse de
 *  hacer es lo que tarde o temprano no se hace.
 *
 *  La contracara: un endpoint de solo lectura que use POST (una consulta con
 *  filtros en el body) le va a dar 403 a quien tenga `consultas`. Hoy no hay
 *  ninguno --todas las consultas y exportaciones del ERP son GET-- y si
 *  alguna vez hace falta, la salida correcta es que esa consulta sea GET, no
 *  aflojar esta regla.
 *
 *  Va DESPUÉS de requireModulo: a quien no tiene el módulo se le responde
 *  "no disponible", no "solo podés consultar", que ya admitiría que existe. */
export function requireNivelParaEscribir(modulo: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const usuario = req.usuario;
    if (!usuario) {
      return res.status(401).json({ ok: false, message: "No autenticado" });
    }
    // Ausente = sesión emitida antes de 0089, cuando todo módulo asignado era
    // para operar. Se respeta eso hasta que la sesión se renueve.
    const soloConsulta = usuario.modulosConsulta ?? [];
    if (!METODOS_DE_LECTURA.has(req.method) && soloConsulta.includes(modulo)) {
      return res.status(403).json({
        ok: false,
        message:
          "Tenés este módulo para consultar. Para cargar o modificar, pedíselo a un administrador",
      });
    }
    next();
  };
}
