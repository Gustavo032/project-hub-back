import { Router } from "express";
import { authRequired } from "../middleware/auth";
import { requireProjectMembership } from "../middleware/requireMembership";
import { getAllProjects, getAllProjectsAdmin, getProjectById, getProjectsForUser } from "../sql";
import { requireProjectAccess } from "../middleware/requireProjectAccess";

export const projectsRoutes = Router();

projectsRoutes.get("/projects", authRequired, async (req, res) => {
  const userId = req.auth!.userId;
  const role = req.auth!.role;

  // ✅ admin vê todos os projetos ativos (ou todos, se preferir)
  if (role === "admin") {
    const items = await getAllProjectsAdmin({ includeInactive: false }); // só ativos
    return res.json({ items });
  }

  // demais: só os que é membro
  const items = await getProjectsForUser(userId);
  return res.json({ items });
});


projectsRoutes.get(
  "/projects/:projectId",
  authRequired,
  requireProjectAccess,
  async (req, res) => {
    const project = await getProjectById(req.params.projectId);
    if (!project || project.is_active === false) {
      return res.status(404).json({ error: "Projeto não encontrado" });
    }
    return res.json(project);
  }
);

