import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { authRequired } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";

export const adminMembershipRoutes = Router();

/**
 * GET /api/admin/projects
 * (para dialog de assignment listar TODOS os projetos)
 */
// adminMembershipRoutes.get(
//   "/admin/projects",
//   authRequired,
//   requireRole(["admin"]),
//   async (_req, res) => {
//     const { rows } = await pool.query(
//       `SELECT id, name, description, status, created_at
//        FROM projects
//        ORDER BY created_at DESC`
//     );

//     return res.json({ items: rows });
//   }
// );

/**
 * GET /api/admin/projects/:projectId/members
 * Retorna { items: ProjectMembership[] } onde ProjectMembership = { project_id, user_id }
 */
adminMembershipRoutes.get(
  "/admin/projects/:projectId/members",
  authRequired,
  requireRole(["admin"]),
  async (req, res) => {
    const { projectId } = req.params;

    // valida projeto existe
    const p = await pool.query(`SELECT id FROM projects WHERE id = $1`, [projectId]);
    if (p.rows.length === 0) return res.status(404).json({ error: "Projeto não encontrado" });

    const { rows } = await pool.query(
      `SELECT project_id, user_id
       FROM project_members
       WHERE project_id = $1`,
      [projectId]
    );

    return res.json({ items: rows });
  }
);

/**
 * POST /api/admin/projects/:projectId/members
 * body: { user_id: string }
 */
adminMembershipRoutes.post(
  "/admin/projects/:projectId/members",
  authRequired,
  requireRole(["admin"]),
  async (req, res) => {
    const { projectId } = req.params;

    const body = z.object({
      user_id: z.string().uuid(),
    }).parse(req.body);

    // valida projeto e user
    const [p, u] = await Promise.all([
      pool.query(`SELECT id FROM projects WHERE id = $1`, [projectId]),
      pool.query(`SELECT id FROM users WHERE id = $1`, [body.user_id]),
    ]);
    if (p.rows.length === 0) return res.status(404).json({ error: "Projeto não encontrado" });
    if (u.rows.length === 0) return res.status(404).json({ error: "Usuário não encontrado" });

    await pool.query(
      `INSERT INTO project_members (project_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [projectId, body.user_id]
    );

    return res.status(201).json({ ok: true });
  }
);

/**
 * DELETE /api/admin/projects/:projectId/members/:userId
 */
adminMembershipRoutes.delete(
  "/admin/projects/:projectId/members/:userId",
  authRequired,
  requireRole(["admin"]),
  async (req, res) => {
    const { projectId, userId } = req.params;

    const del = await pool.query(
      `DELETE FROM project_members
       WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId]
    );

    if (del.rowCount === 0) {
      return res.status(404).json({ error: "Atrelamento não encontrado" });
    }

    return res.json({ ok: true });
  }
);
