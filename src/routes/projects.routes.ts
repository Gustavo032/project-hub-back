import { Router } from "express";
import { authRequired } from "../middleware/auth";
import { requireProjectMembership } from "../middleware/requireMembership";
import { getAllProjects, getProjectById, getProjectsForUser } from "../sql";

export const projectsRoutes = Router();

projectsRoutes.get("/projects", authRequired, async (req, res) => {
  const userId = req.auth!.userId;
  const role = req.auth!.role;

  // ✅ admin vê todos
  if (role === "admin") {
    const items = await getAllProjects();
    return res.json({ items });
  }

  // ✅ demais: só projetos onde é membro
  const items = await getProjectsForUser(userId);
  return res.json({ items });
});

projectsRoutes.get(
  "/projects/:projectId",
  authRequired,
  requireProjectMembership,
  async (req, res) => {
    const project = await getProjectById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Projeto não encontrado" });
    return res.json(project);
  }
);
