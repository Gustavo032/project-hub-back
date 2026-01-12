// src/routes/admin.projects.routes.ts
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { authRequired } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";

export const adminProjectsRoutes = Router();

// tudo admin-only
adminProjectsRoutes.use(authRequired, requireRole(["admin"]));

/**
 * GET /api/admin/projects
 * Lista todos (inclui inativos) para telas admin
 */
adminProjectsRoutes.get("/admin/projects", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, status, created_at, is_active, deleted_at
     FROM projects
     ORDER BY created_at DESC`
  );
  return res.json({ items: rows });
});

/**
 * POST /api/admin/projects
 * body: { name, description? }
 * cria projeto + adiciona criador como member (boa prática)
 */
adminProjectsRoutes.post("/admin/projects", async (req, res) => {
  const body = z.object({
    name: z.string().min(2).max(120),
    description: z.string().max(1000).optional().nullable(),
  }).parse(req.body);

  const adminId = req.auth!.userId;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertRes = await client.query(
      `INSERT INTO projects (name, description, status, created_by_user_id, is_active)
       VALUES ($1, $2, 'active', $3, true)
       RETURNING id, name, description, status, created_at, is_active, deleted_at`,
      [body.name, body.description ?? null, adminId]
    );

    const project = insertRes.rows[0];

    // ✅ garante que admin criador é membro
    await client.query(
      `INSERT INTO project_members (project_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [project.id, adminId]
    );

    await client.query("COMMIT");
    return res.status(201).json(project);
  } catch (e: any) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/admin/projects/:projectId
 * body: { name?, description?, status? }
 */
adminProjectsRoutes.patch("/admin/projects/:projectId", async (req, res) => {
  const { projectId } = req.params;

  const body = z.object({
    name: z.string().min(2).max(120).optional(),
    description: z.string().max(1000).optional().nullable(),
    status: z.enum(["active", "archived"]).optional(),
  }).refine((v) => Object.keys(v).length > 0, "Nada para atualizar").parse(req.body);

  const exists = await pool.query(
    `SELECT id FROM projects WHERE id = $1`,
    [projectId]
  );
  if (exists.rowCount === 0) return res.status(404).json({ error: "Projeto não encontrado" });

  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (body.name !== undefined) { fields.push(`name = $${idx++}`); values.push(body.name); }
  if (body.description !== undefined) { fields.push(`description = $${idx++}`); values.push(body.description); }
  if (body.status !== undefined) { fields.push(`status = $${idx++}`); values.push(body.status); }

  values.push(projectId);

  const { rows } = await pool.query(
    `UPDATE projects
     SET ${fields.join(", ")},
         updated_at = now()
     WHERE id = $${idx}
     RETURNING id, name, description, status, created_at, is_active, deleted_at`,
    values
  );

  return res.json(rows[0]);
});

/**
 * DELETE /api/admin/projects/:projectId
 * soft delete (is_active=false)
 *
 * regra: não apaga do banco, preserva sugestões/backlog etc.
 */
adminProjectsRoutes.delete("/admin/projects/:projectId", async (req, res) => {
  const { projectId } = req.params;
  const adminId = req.auth!.userId;

  const upd = await pool.query(
    `UPDATE projects
     SET is_active = false,
         deleted_at = now(),
         deleted_by_user_id = $1,
         updated_at = now()
     WHERE id = $2 AND is_active = true
     RETURNING id`,
    [adminId, projectId]
  );

  if (upd.rowCount === 0) return res.status(404).json({ error: "Projeto não encontrado" });

  return res.json({ ok: true });
});

/**
 * POST /api/admin/projects/:projectId/restore
 * reativa projeto (desfaz soft delete)
 */
adminProjectsRoutes.post("/admin/projects/:projectId/restore", async (req, res) => {
  const { projectId } = req.params;

  const upd = await pool.query(
    `UPDATE projects
     SET is_active = true,
         deleted_at = NULL,
         deleted_by_user_id = NULL,
         updated_at = now()
     WHERE id = $1
     RETURNING id, name, description, status, created_at, is_active, deleted_at`,
    [projectId]
  );

  if (upd.rowCount === 0) return res.status(404).json({ error: "Projeto não encontrado" });

  return res.json(upd.rows[0]);
});
