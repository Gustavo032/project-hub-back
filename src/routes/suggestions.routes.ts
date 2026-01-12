import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../middleware/auth";
import { requireProjectMembership } from "../middleware/requireMembership";
import { pool } from "../db";
import { requireRole } from "../middleware/requireRole";

export const suggestionsRoutes = Router();

// GET list
suggestionsRoutes.get(
  "/projects/:projectId/suggestions",
  authRequired,
  requireProjectMembership,
  async (req, res) => {
    const { projectId } = req.params;
    const userId = req.auth!.userId;
    const role = req.auth!.role;

    // Sugestões do projeto
    const sugRes = await pool.query(
      `SELECT s.id, s.project_id, s.title, s.description, s.status, s.progress_percent,
              s.score, s.upvotes_count, s.downvotes_count, s.backlog_item_id, s.created_at,
              u.id as author_id, u.name as author_name
       FROM suggestions s
       JOIN users u ON u.id = s.created_by_user_id
       WHERE s.project_id = $1
       ORDER BY s.created_at DESC`,
      [projectId]
    );

    // Meu voto por sugestão
    const voteRes = await pool.query(
      `SELECT suggestion_id, vote
       FROM suggestion_votes
       WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId]
    );
    const voteMap = new Map<string, number>(voteRes.rows.map(r => [r.suggestion_id, r.vote]));

    const canSeeAuthor = role === "developer" || role === "admin";

    type SuggestionRow = {
      id: string;
      project_id: string;
      title: string;
      description: string;
      status: string;
      progress_percent: number;
      score: number;
      upvotes_count: number;
      downvotes_count: number;
      backlog_item_id: string | null;
      created_at: string;
      author_id: string;
      author_name: string;
    };

    const items = sugRes.rows.map((r: SuggestionRow) => ({
      id: r.id,
      project_id: r.project_id,
      title: r.title,
      description: r.description,
      status: r.status,
      progress_percent: r.progress_percent,
      score: r.score,
      likes: r.upvotes_count,         // compat com seu front mock
      dislikes: r.downvotes_count,    // compat
      backlog_item_id: r.backlog_item_id,
      created_at: r.created_at,
      author_id: canSeeAuthor ? r.author_id : undefined,
      author_name: canSeeAuthor ? r.author_name : undefined,
      user_vote: voteMap.get(r.id) ?? 0,
    }));

    return res.json(items);
  }
);

// GET detail
suggestionsRoutes.get(
  "/projects/:projectId/suggestions/:suggestionId",
  authRequired,
  requireProjectMembership,
  async (req, res) => {
    const { projectId, suggestionId } = req.params;
    const userId = req.auth!.userId;
    const role = req.auth!.role;

    const sugRes = await pool.query(
      `SELECT s.id, s.project_id, s.title, s.description, s.status, s.progress_percent,
              s.score, s.upvotes_count, s.downvotes_count, s.backlog_item_id, s.created_at,
              u.id as author_id, u.name as author_name
       FROM suggestions s
       JOIN users u ON u.id = s.created_by_user_id
       WHERE s.project_id = $1 AND s.id = $2`,
      [projectId, suggestionId]
    );
    const row = sugRes.rows[0];
    if (!row) return res.status(404).json({ error: "Sugestão não encontrada" });

    const vRes = await pool.query(
      `SELECT vote
       FROM suggestion_votes
       WHERE project_id = $1 AND suggestion_id = $2 AND user_id = $3`,
      [projectId, suggestionId, userId]
    );

    const canSeeAuthor = role === "developer" || role === "admin";

    return res.json({
      id: row.id,
      project_id: row.project_id,
      title: row.title,
      description: row.description,
      status: row.status,
      progress_percent: row.progress_percent,
      score: row.score,
      likes: row.upvotes_count,
      dislikes: row.downvotes_count,
      backlog_item_id: row.backlog_item_id,
      created_at: row.created_at,
      author_id: canSeeAuthor ? row.author_id : undefined,
      author_name: canSeeAuthor ? row.author_name : undefined,
      user_vote: vRes.rows[0]?.vote ?? 0,
    });
  }
);

// CREATE suggestion (qualquer membro)
suggestionsRoutes.post(
  "/projects/:projectId/suggestions",
  authRequired,
  requireProjectMembership,
  async (req, res) => {
    const { projectId } = req.params;
    const userId = req.auth!.userId;

    const body = z.object({
      title: z.string().min(1).max(200),
      description: z.string().min(1).max(10_000),
    }).parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO suggestions (project_id, created_by_user_id, title, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, project_id, title, description, status, progress_percent, score,
                 upvotes_count, downvotes_count, backlog_item_id, created_at`,
      [projectId, userId, body.title, body.description]
    );

    const s = rows[0];
    return res.status(201).json({
      id: s.id,
      project_id: s.project_id,
      title: s.title,
      description: s.description,
      status: s.status,
      progress_percent: s.progress_percent,
      score: s.score,
      likes: s.upvotes_count,
      dislikes: s.downvotes_count,
      backlog_item_id: s.backlog_item_id,
      created_at: s.created_at,
      user_vote: 0,
    });
  }
);

// UPDATE suggestion (somente autor e somente se não puxada)
suggestionsRoutes.patch(
  "/projects/:projectId/suggestions/:suggestionId",
  authRequired,
  requireProjectMembership,
  async (req, res) => {
    const { projectId, suggestionId } = req.params;
    const userId = req.auth!.userId;

    const body = z.object({
      title: z.string().min(1).max(200).optional(),
      description: z.string().min(1).max(10_000).optional(),
    }).refine((v) => v.title || v.description, "Nada para atualizar").parse(req.body);

    const check = await pool.query(
      `SELECT created_by_user_id, backlog_item_id
       FROM suggestions
       WHERE project_id = $1 AND id = $2`,
      [projectId, suggestionId]
    );
    const row = check.rows[0];
    if (!row) return res.status(404).json({ error: "Sugestão não encontrada" });
    if (row.created_by_user_id !== userId) return res.status(403).json({ error: "Sem permissão" });
    if (row.backlog_item_id) return res.status(409).json({ error: "Sugestão já foi puxada para desenvolvimento" });

    const { rows } = await pool.query(
      `UPDATE suggestions
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           updated_at = now()
       WHERE project_id = $3 AND id = $4
       RETURNING id, title, description`,
      [body.title ?? null, body.description ?? null, projectId, suggestionId]
    );

    return res.json(rows[0]);
  }
);

// DELETE suggestion (somente autor e somente se não puxada)
suggestionsRoutes.delete(
  "/projects/:projectId/suggestions/:suggestionId",
  authRequired,
  requireProjectMembership,
  async (req, res) => {
    const { projectId, suggestionId } = req.params;
    const userId = req.auth!.userId;

    const check = await pool.query(
      `SELECT created_by_user_id, backlog_item_id
       FROM suggestions
       WHERE project_id = $1 AND id = $2`,
      [projectId, suggestionId]
    );
    const row = check.rows[0];
    if (!row) return res.status(404).json({ error: "Sugestão não encontrada" });
    if (row.created_by_user_id !== userId) return res.status(403).json({ error: "Sem permissão" });
    if (row.backlog_item_id) return res.status(409).json({ error: "Sugestão já foi puxada para desenvolvimento" });

    await pool.query(
      `DELETE FROM suggestions WHERE project_id = $1 AND id = $2`,
      [projectId, suggestionId]
    );

    return res.json({ ok: true });
  }
);

// VOTE (vote -1/0/1) - atualiza contadores na suggestion
suggestionsRoutes.put(
  "/projects/:projectId/suggestions/:suggestionId/vote",
  authRequired,
  requireProjectMembership,
  async (req, res) => {
    const { projectId, suggestionId } = req.params;
    const userId = req.auth!.userId;

    const body = z.object({
      vote: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    }).parse(req.body);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // garante que suggestion existe
      const sRes = await client.query(
        `SELECT upvotes_count, downvotes_count
         FROM suggestions
         WHERE project_id = $1 AND id = $2
         FOR UPDATE`,
        [projectId, suggestionId]
      );
      if (sRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Sugestão não encontrada" });
      }

      // voto anterior (se houver)
      const oldRes = await client.query(
        `SELECT vote
         FROM suggestion_votes
         WHERE project_id = $1 AND suggestion_id = $2 AND user_id = $3
         FOR UPDATE`,
        [projectId, suggestionId, userId]
      );
      const oldVote: number = oldRes.rows[0]?.vote ?? 0;

      // upsert vote
      await client.query(
        `INSERT INTO suggestion_votes (project_id, suggestion_id, user_id, vote)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, suggestion_id, user_id)
         DO UPDATE SET vote = EXCLUDED.vote, updated_at = now()`,
        [projectId, suggestionId, userId, body.vote]
      );

      // recalcular contadores: mais simples e correto
      const aggRes = await client.query(
        `SELECT
            SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END)::int AS up,
            SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END)::int AS down
         FROM suggestion_votes
         WHERE project_id = $1 AND suggestion_id = $2`,
        [projectId, suggestionId]
      );

      const up = aggRes.rows[0]?.up ?? 0;
      const down = aggRes.rows[0]?.down ?? 0;
      const score = up - down;

      await client.query(
        `UPDATE suggestions
         SET upvotes_count = $1,
             downvotes_count = $2,
             score = $3,
             updated_at = now()
         WHERE project_id = $4 AND id = $5`,
        [up, down, score, projectId, suggestionId]
      );

      await client.query("COMMIT");

      return res.json({
        suggestion_id: suggestionId,
        score,
        likes: up,
        dislikes: down,
        my_vote: body.vote,
        old_vote: oldVote
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
);

// PULL-TO-BACKLOG (somente developer/admin)
suggestionsRoutes.post(
  "/projects/:projectId/suggestions/:suggestionId/pull-to-backlog",
  authRequired,
  requireProjectMembership,
  requireRole(["developer", "admin"]),
  async (req, res) => {
    const { projectId, suggestionId } = req.params;
    const userId = req.auth!.userId;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const sRes = await client.query(
        `SELECT id, title, description, backlog_item_id
         FROM suggestions
         WHERE project_id = $1 AND id = $2
         FOR UPDATE`,
        [projectId, suggestionId]
      );
      const sug = sRes.rows[0];
      if (!sug) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Sugestão não encontrada" });
      }
      if (sug.backlog_item_id) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Sugestão já está no backlog" });
      }

      // cria backlog item (1:1)
      const bRes = await client.query(
        `INSERT INTO backlog_items (project_id, origin_type, suggestion_id, title, summary, created_by_user_id)
         VALUES ($1, 'suggestion', $2, $3, $4, $5)
         RETURNING id, project_id, suggestion_id, title, summary, stage, priority, progress_percent, created_at`,
        [projectId, suggestionId, sug.title, sug.description, userId]
      );
      const backlog = bRes.rows[0];

      // atualiza suggestion
      await client.query(
        `UPDATE suggestions
         SET status = 'in_progress',
             backlog_item_id = $1,
             locked_at = now(),
             updated_at = now()
         WHERE project_id = $2 AND id = $3`,
        [backlog.id, projectId, suggestionId]
      );

      await client.query("COMMIT");
      return res.status(201).json(backlog);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
);
