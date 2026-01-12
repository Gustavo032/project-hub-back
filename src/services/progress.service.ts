import { pool } from "../db";

/**
 * Recalcula progresso do backlog item e, se houver sugestão vinculada,
 * espelha progresso/status na sugestão.
 * Retorna { backlogProgress, suggestionProgress? }.
 */
export async function recalcProgress(projectId: string, backlogItemId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tasksRes = await client.query(
      `SELECT COUNT(*)::int AS total,
              SUM(CASE WHEN is_done THEN 1 ELSE 0 END)::int AS done
       FROM backlog_tasks
       WHERE project_id = $1 AND backlog_item_id = $2`,
      [projectId, backlogItemId]
    );

    const total = tasksRes.rows[0]?.total ?? 0;
    const done = tasksRes.rows[0]?.done ?? 0;
    const progress = total === 0 ? 0 : Math.round((done / total) * 100);

    await client.query(
      `UPDATE backlog_items
       SET progress_percent = $1, updated_at = now()
       WHERE project_id = $2 AND id = $3`,
      [progress, projectId, backlogItemId]
    );

    // Se backlog tiver suggestion_id, espelhar na suggestions
    const linkRes = await client.query(
      `SELECT suggestion_id
       FROM backlog_items
       WHERE project_id = $1 AND id = $2`,
      [projectId, backlogItemId]
    );

    const suggestionId = linkRes.rows[0]?.suggestion_id as string | null;

    let suggestionProgress: number | null = null;
    if (suggestionId) {
      suggestionProgress = progress;

      await client.query(
        `UPDATE suggestions
         SET progress_percent = $1, updated_at = now()
         WHERE project_id = $2 AND id = $3`,
        [progress, projectId, suggestionId]
      );
    }

    await client.query("COMMIT");
    return { backlogProgress: progress, suggestionProgress };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
