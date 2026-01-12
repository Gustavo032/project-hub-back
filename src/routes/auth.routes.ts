import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt, { Secret } from "jsonwebtoken";
import { env } from "../env";
import { getUserByEmail } from "../sql";

export const authRoutes = Router();

authRoutes.post("/auth/login", async (req, res) => {
  const body = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }).parse(req.body);

  const user = await getUserByEmail(body.email);
  if (!user) return res.status(401).json({ error: "Credenciais inválidas" });

  const ok = await bcrypt.compare(body.password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Credenciais inválidas" });

  const expiresIn = (env.JWT_EXPIRES_IN || "7d").trim();

	// fallback seguro se ainda vier inválido
	const safeExpiresIn = expiresIn.length ? expiresIn : "7d";

  const token = jwt.sign(
    { sub: user.id, role: user.role },
    env.JWT_SECRET as Secret,
    { expiresIn: safeExpiresIn } as jwt.SignOptions
  );


  return res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});
