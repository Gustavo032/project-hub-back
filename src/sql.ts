import { pool } from "./db";
import { StackCode } from "./types";

export async function getUserByEmail(email: string) {
  const { rows } = await pool.query(
    `SELECT id, name, email, password_hash, role
     FROM users
     WHERE email = $1`,
    [email]
  );
  return rows[0] ?? null;
}

export async function getUserById(userId: string) {
  const { rows } = await pool.query(
    `SELECT id, name, email, role
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function getUserStacks(userId: string): Promise<StackCode[]> {
  const { rows } = await pool.query(
    `SELECT ds.code
     FROM user_developer_stacks uds
     JOIN developer_stacks ds ON ds.id = uds.stack_id
     WHERE uds.user_id = $1
     ORDER BY ds.id`,
    [userId]
  );
  return rows.map((r:any) => r.code as StackCode);
}

export async function requireMembership(userId: string, projectId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1
     FROM project_members
     WHERE project_id = $1 AND user_id = $2`,
    [projectId, userId]
  );
  return rows.length > 0;
}

export async function getProjectById(projectId: string) {
  const { rows } = await pool.query(
    `SELECT id, name, description, status, created_at
     FROM projects
     WHERE id = $1`,
    [projectId]
  );
  return rows[0] ?? null;
}

export async function getProjectsForUser(userId: string) {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.description, p.status, p.created_at
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id
     WHERE pm.user_id = $1
     ORDER BY p.created_at DESC`,
    [userId]
  );
  return rows;
}

export async function getAllProjects() {
  const { rows } = await pool.query(
    `SELECT id, name, description, created_at
     FROM projects
     ORDER BY created_at DESC`
  );
  return rows;
}
