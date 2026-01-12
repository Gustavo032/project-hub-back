import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../env";
import { JwtPayload } from "../types";

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; role: JwtPayload["role"] };
    }
  }
}

export function authRequired(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  const token = header.slice("Bearer ".length);
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    const payload = decoded as unknown as JwtPayload;

    if (!payload?.sub || !payload?.role) {
      return res.status(401).json({ error: "Token inválido" });
    }

    req.auth = { userId: payload.sub, role: payload.role };
    return next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}
