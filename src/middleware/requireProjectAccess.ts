// src/middleware/requireProjectAccess.ts
import { NextFunction, Request, Response } from "express";
import { requireMembership } from "../sql";

export async function requireProjectAccess(req: Request, res: Response, next: NextFunction) {
  const userId = req.auth!.userId;
  const role = req.auth!.role;
  const { projectId } = req.params;

  // admin pode tudo
  if (role === "admin") return next();

  const ok = await requireMembership(userId, projectId);
  if (!ok) return res.status(403).json({ error: "Acesso negado" });

  return next();
}
