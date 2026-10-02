import type { Request, Response, NextFunction } from "express";

import { pestanaPermitida } from "../../services/permisosPestanas.service";

export function requirePestana(modulo: string, pestana: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const usuario = req.usuario;
    if (!usuario) return res.status(401).json({ ok: false, message: "No autenticado" });
    if (!pestanaPermitida(usuario, modulo, pestana)) {
      return res.status(403).json({ ok: false, message: "Pestaña no disponible para este perfil" });
    }
    next();
  };
}
