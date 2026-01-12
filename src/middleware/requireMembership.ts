import { NextFunction, Request, Response } from "express";
import { requireMembership as isMember } from "../sql";

export async function requireProjectMembership(req: Request, res: Response, next: NextFunction) {
  const userId = req.auth?.userId;
  const projectId = req.params.projectId;

  if (!userId) return res.status(401).json({ error: "Não autenticado" });
  if (!projectId) return res.status(400).json({ error: "projectId obrigatório" });

  const ok = await isMember(userId, projectId);
  if (!ok) return res.status(403).json({ error: "Acesso negado (não é membro do projeto)" });

  next();
}
