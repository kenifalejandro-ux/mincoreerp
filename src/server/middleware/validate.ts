import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodTypeAny } from "zod";
import { asyncHandler } from "../shared/utils/asyncHandler";

export const validate = (schema: ZodTypeAny) =>
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedData = await schema.parseAsync(req.body);
      req.validatedBody = parsedData;
      next();
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        const errors = error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        }));

        if (req.log) {
          req.log.warn({ errors }, "Datos invalidos en formulario");
        } else {
          console.warn("Datos invalidos en formulario", { errors });
        }

        return res.status(400).json({ errors });
      }

      if (req.log) {
        req.log.error({ err: error }, "Error inesperado validando formulario");
      } else {
        console.error("Error inesperado validando formulario", error);
      }

      return res.status(500).json({ message: "Error interno validando formulario" });
    }
  });

/** Igual que `validate`, pero sobre la query string.
 *
 *  Nació con el kardex (GET /:id/kardex?desde=&hasta=), el primer endpoint
 *  del ERP con parámetros de query que NO pueden faltar ni venir en
 *  cualquier forma: sin fechas válidas el reporte no significa nada. Hasta
 *  acá la query se leía a mano con `typeof req.query.x === "string"`, que
 *  alcanza para un filtro opcional y no para un parámetro obligatorio.
 *
 *  Devuelve el MISMO shape de error que `validate` para que el cliente no
 *  tenga que distinguir de dónde vino la falla.
 *
 *  Ojo: en Express la query es de solo lectura, así que el resultado va a
 *  `req.validatedQuery` y nunca se reasigna `req.query`. */
export const validateQuery = (schema: ZodTypeAny) =>
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.validatedQuery = await schema.parseAsync(req.query);
      next();
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        const errors = error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        }));
        if (req.log) req.log.warn({ errors }, "Parámetros de consulta inválidos");
        return res.status(400).json({ errors });
      }
      if (req.log) req.log.error({ err: error }, "Error inesperado validando la query");
      return res.status(500).json({ message: "Error interno validando la consulta" });
    }
  });
