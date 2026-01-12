import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../middleware/auth";
import { requireProjectMembership } from "../middleware/requireMembership";
import { requireRole } from "../middleware/requireRole";
import { pool } from "../db";
import { recalcProgress } from "../services/progress.service";
import { getUserStacks } from "../sql";

export const backlogRoutes = Router();

// GET backlog list (developer/manager/admin)
backlogRoutes.get(
  "/projects/:projectId/backlog",
  authRequired,
  requireProjectMembership,
  requireRole(["developer", "manager", "admin"]),
  async (req, res) => {
    const { projectId } = req.params;

    const { rows } = await pool.query(
      `SELECT id, project_id, origin_type, suggestion_id, title, summary,
              stage, priority, progress_percent, created_at
       FROM backlog_items
       WHERE project_id = $1
       ORDER BY created_at DESC`,
      [projectId]
    );

    return res.json(rows);
  }
);

// GET backlog item detail + tasks (developer/manager/admin)
backlogRoutes.get(
  "/projects/:projectId/backlog/:backlogItemId",
  authRequired,
  requireProjectMembership,
  requireRole(["developer", "manager", "admin"]),
  async (req, res) => {
    const { projectId, backlogItemId } = req.params;

    const itemRes = await pool.query(
      `SELECT id, project_id, origin_type, suggestion_id, title, summary,
              stage, priority, progress_percent, created_at
       FROM backlog_items
       WHERE project_id = $1 AND id = $2`,
      [projectId, backlogItemId]
    );
    const item = itemRes.rows[0];
    if (!item) return res.status(404).json({ error: "Item não encontrado" });

    const tasksRes = await pool.query(
      `SELECT t.id, t.backlog_item_id, ds.code as stack, t.title, t.description,
              t.is_done, t.order_index, t.created_at
       FROM backlog_tasks t
       JOIN developer_stacks ds ON ds.id = t.stack_id
       WHERE t.project_id = $1 AND t.backlog_item_id = $2
       ORDER BY t.order_index ASC, t.created_at ASC`,
      [projectId, backlogItemId]
    );

    return res.json({ ...item, tasks: tasksRes.rows });
  }
);

// CREATE backlog item manual (developer/admin)
backlogRoutes.post(
  "/projects/:projectId/backlog",
  authRequired,
  requireProjectMembership,
  requireRole(["developer", "admin"]),
  async (req, res) => {
    const { projectId } = req.params;
    const userId = req.auth!.userId;

    const body = z.object({
      title: z.string().min(1).max(200),
      summary: z.string().max(10_000).optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    }).parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO backlog_items (project_id, origin_type, title, summary, priority, created_by_user_id)
       VALUES ($1, 'manual', $2, $3, $4, $5)
       RETURNING id, project_id, origin_type, title, summary, stage, priority, progress_percent, created_at`,
      [projectId, body.title, body.summary ?? null, body.priority ?? "medium", userId]
    );

    return res.status(201).json(rows[0]);
  }
);

// CREATE task (developer/admin) - respeita stack do developer
backlogRoutes.post(
  "/projects/:projectId/backlog/:backlogItemId/tasks",
  authRequired,
  requireProjectMembership,
  requireRole(["developer", "admin"]),
  async (req, res) => {
    const { projectId, backlogItemId } = req.params;
    const userId = req.auth!.userId;
    const role = req.auth!.role;

    const body = z.object({
      stack: z.enum(["frontend", "backend", "infra"]),
      title: z.string().min(1).max(200),
      description: z.string().max(10_000).optional(),
      order_index: z.number().int().optional(),
    }).parse(req.body);

    if (role === "developer") {
      const stacks = await getUserStacks(userId);
      if (!stacks.includes(body.stack)) {
        return res.status(403).json({ error: `Sem permissão para stack ${body.stack}` });
      }
    }

    // map stack -> stack_id
    const stackIdRes = await pool.query(`SELECT id FROM developer_stacks WHERE code = $1`, [body.stack]);
    const stackId = stackIdRes.rows[0]?.id;
    if (!stackId) return res.status(400).json({ error: "Stack inválida" });

    // backlog existe?
    const bRes = await pool.query(
      `SELECT id FROM backlog_items WHERE project_id = $1 AND id = $2`,
      [projectId, backlogItemId]
    );
    if (bRes.rows.length === 0) return res.status(404).json({ error: "Backlog não encontrado" });

    const { rows } = await pool.query(
      `INSERT INTO backlog_tasks (project_id, backlog_item_id, stack_id, title, description, order_index, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [projectId, backlogItemId, stackId, body.title, body.description ?? null, body.order_index ?? 0, userId]
    );

    const progress = await recalcProgress(projectId, backlogItemId);

    return res.status(201).json({
      task_id: rows[0].id,
      backlog_progress_percent: progress.backlogProgress,
      suggestion_progress_percent: progress.suggestionProgress ?? undefined
    });
  }
);

// UPDATE task (developer/admin) - respeita stack do developer
backlogRoutes.patch(
  "/projects/:projectId/backlog/:backlogItemId/tasks/:taskId",
  authRequired,
  requireProjectMembership,
  requireRole(["developer", "admin"]),
  async (req, res) => {
    const { projectId, backlogItemId, taskId } = req.params;
    const userId = req.auth!.userId;
    const role = req.auth!.role;

    const body = z.object({
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(10_000).optional(),
      is_done: z.boolean().optional(),
      order_index: z.number().int().optional(),
    }).refine((v) => Object.keys(v).length > 0, "Nada para atualizar").parse(req.body);

    // buscar stack da task
    const tRes = await pool.query(
      `SELECT ds.code as stack
       FROM backlog_tasks t
       JOIN developer_stacks ds ON ds.id = t.stack_id
       WHERE t.project_id = $1 AND t.backlog_item_id = $2 AND t.id = $3`,
      [projectId, backlogItemId, taskId]
    );
    const task = tRes.rows[0];
    if (!task) return res.status(404).json({ error: "Task não encontrada" });

    if (role === "developer") {
      const stacks = await getUserStacks(userId);
      if (!stacks.includes(task.stack)) {
        return res.status(403).json({ error: `Sem permissão para stack ${task.stack}` });
      }
    }

    // atualizar
    await pool.query(
      `UPDATE backlog_tasks
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           is_done = COALESCE($3, is_done),
           done_at = CASE
                      WHEN COALESCE($3, is_done) = true AND is_done = false THEN now()
                      WHEN COALESCE($3, is_done) = false THEN NULL
                      ELSE done_at
                    END,
           order_index = COALESCE($4, order_index),
           updated_at = now()
       WHERE project_id = $5 AND backlog_item_id = $6 AND id = $7`,
      [
        body.title ?? null,
        body.description ?? null,
        typeof body.is_done === "boolean" ? body.is_done : null,
        typeof body.order_index === "number" ? body.order_index : null,
        projectId,
        backlogItemId,
        taskId
      ]
    );

    const progress = await recalcProgress(projectId, backlogItemId);

    const updatedRes = await pool.query(
      `SELECT t.id, ds.code as stack, t.title, t.description, t.is_done, t.order_index
       FROM backlog_tasks t
       JOIN developer_stacks ds ON ds.id = t.stack_id
       WHERE t.project_id = $1 AND t.backlog_item_id = $2 AND t.id = $3`,
      [projectId, backlogItemId, taskId]
    );

    return res.json({
      task: updatedRes.rows[0],
      backlog_progress_percent: progress.backlogProgress,
      suggestion_progress_percent: progress.suggestionProgress ?? undefined
    });
  }
);

// DELETE task (developer/admin) - respeita stack
backlogRoutes.delete(
  "/projects/:projectId/backlog/:backlogItemId/tasks/:taskId",
  authRequired,
  requireProjectMembership,
  requireRole(["developer", "admin"]),
  async (req, res) => {
    const { projectId, backlogItemId, taskId } = req.params;
    const userId = req.auth!.userId;
    const role = req.auth!.role;

    const tRes = await pool.query(
      `SELECT ds.code as stack
       FROM backlog_tasks t
       JOIN developer_stacks ds ON ds.id = t.stack_id
       WHERE t.project_id = $1 AND t.backlog_item_id = $2 AND t.id = $3`,
      [projectId, backlogItemId, taskId]
    );
    const task = tRes.rows[0];
    if (!task) return res.status(404).json({ error: "Task não encontrada" });

    if (role === "developer") {
      const stacks = await getUserStacks(userId);
      if (!stacks.includes(task.stack)) {
        return res.status(403).json({ error: `Sem permissão para stack ${task.stack}` });
      }
    }

    await pool.query(
      `DELETE FROM backlog_tasks
       WHERE project_id = $1 AND backlog_item_id = $2 AND id = $3`,
      [projectId, backlogItemId, taskId]
    );

    const progress = await recalcProgress(projectId, backlogItemId);

    return res.json({
      ok: true,
      backlog_progress_percent: progress.backlogProgress,
      suggestion_progress_percent: progress.suggestionProgress ?? undefined
    });
  }
);
