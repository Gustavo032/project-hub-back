import { Router } from "express";
import { authRequired } from "../middleware/auth";
import { getUserById, getUserStacks } from "../sql";

export const meRoutes = Router();

meRoutes.get("/me", authRequired, async (req, res) => {
  const userId = req.auth!.userId;
  const user = await getUserById(userId);
  if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

  const stacks = await getUserStacks(userId);

	return res.json({
		id: user.id,
		name: user.name,
		email: user.email,
		role: user.role,
		stacks,
		is_active: user.is_active,
		deleted_at: user.deleted_at,
	});

});
