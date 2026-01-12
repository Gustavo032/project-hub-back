import { NextFunction, Request, Response } from "express";
import { Role } from "../types";

export function requireRole(allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.auth?.role;
    if (!role) return res.status(401).json({ error: "Não autenticado" });
    if (!allowed.includes(role)) return res.status(403).json({ error: "Acesso negado" });
    next();
  };
}
