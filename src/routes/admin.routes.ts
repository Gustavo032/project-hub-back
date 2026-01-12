import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import { authRequired } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";

export const adminRoutes = Router();

// Tudo aqui é admin-only
adminRoutes.use(authRequired, requireRole(["admin"]));

const RoleSchema = z.enum(["user", "manager", "developer", "admin"]);
const StackSchema = z.array(z.enum(["frontend", "backend", "infra"])).default([]);

// ---------- helpers ----------
async function getStacksMap(userIds: string[]) {
  const map = new Map<string, string[]>();
  if (userIds.length === 0) return map;

  const { rows } = await pool.query(
    `SELECT uds.user_id, ds.code
     FROM user_developer_stacks uds
     JOIN developer_stacks ds ON ds.id = uds.stack_id
     WHERE uds.user_id = ANY($1::uuid[])
     ORDER BY ds.code`,
    [userIds]
  );

  for (const r of rows) {
    const arr = map.get(r.user_id) ?? [];
    arr.push(r.code);
    map.set(r.user_id, arr);
  }
  return map;
}

async function setUserStacks(userId: string, stacks: string[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`DELETE FROM user_developer_stacks WHERE user_id = $1`, [userId]);

    for (const code of stacks) {
      const stackRes = await client.query(`SELECT id FROM developer_stacks WHERE code=$1`, [code]);
      const stackId = stackRes.rows[0]?.id;
      if (!stackId) throw new Error(`Stack inválida: ${code}`);

      await client.query(
        `INSERT INTO user_developer_stacks (user_id, stack_id) VALUES ($1,$2)`,
        [userId, stackId]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ---------- USERS ----------

/**
 * GET /api/admin/users
 * -> { items: User[] }
 */
adminRoutes.get("/admin/users", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, created_at
     FROM users
     ORDER BY created_at DESC`
  );

  const ids = rows.map((u) => u.id);
  const stacksMap = await getStacksMap(ids);

  return res.json({
    items: rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      stacks: stacksMap.get(u.id) ?? [],
      created_at: u.created_at,
    })),
  });
});

/**
 * GET /api/admin/users/:userId
 * -> User
 */
adminRoutes.get("/admin/users/:userId", async (req, res) => {
  const { userId } = req.params;

  const userRes = await pool.query(
    `SELECT id, name, email, role, created_at
     FROM users WHERE id=$1`,
    [userId]
  );
  const user = userRes.rows[0];
  if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

  const stacksMap = await getStacksMap([userId]);

  return res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    stacks: stacksMap.get(userId) ?? [],
    created_at: user.created_at,
  });
});

/**
 * POST /api/admin/users
 *
 * body: { name, email, role, stacks? }
 */
adminRoutes.post("/admin/users", async (req, res) => {
  const body = z.object({
		name: z.string().min(1).max(120),
		email: z.string().email().max(200),
		role: RoleSchema,
		password: z.string().min(6).max(200), // ✅ novo
		stacks: StackSchema.optional(),
	}).parse(req.body);


  // (recomendado você depois criar endpoint de "reset password" / "invite")
  const password_hash = await bcrypt.hash(body.password, 10);


  try {
    const insertRes = await pool.query(
      `INSERT INTO users (name, email, role, password_hash)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, email, role, created_at`,
      [body.name, body.email, body.role, password_hash]
    );

    const user = insertRes.rows[0];

    const stacks = body.stacks ?? [];
    const finalStacks =
      body.role === "developer" || body.role === "admin" ? stacks : [];

    if (finalStacks.length > 0) {
      await setUserStacks(user.id, finalStacks);
    }

    return res.status(201).json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      stacks: finalStacks,
      created_at: user.created_at,
      // opcional: se você quiser mostrar no UI depois
      // temp_password: defaultPassword
    });
  } catch (e: any) {
    if (String(e?.code) === "23505") {
      return res.status(409).json({ error: "E-mail já cadastrado" });
    }
    throw e;
  }
});

/**
 * PATCH /api/admin/users/:userId
 * body: { name?, email?, role?, stacks? }
 */
adminRoutes.patch("/admin/users/:userId", async (req, res) => {
  const { userId } = req.params;

  const body = z
    .object({
      name: z.string().min(1).max(120).optional(),
      email: z.string().email().max(200).optional(),
      role: RoleSchema.optional(),
	password: z.string().min(6).max(200), // ✅ novo
      stacks: StackSchema.optional(),
    })
    .refine((v) => Object.keys(v).length > 0, "Nada para atualizar")
    .parse(req.body);

  const exists = await pool.query(`SELECT id FROM users WHERE id=$1`, [userId]);
  if (exists.rowCount === 0) return res.status(404).json({ error: "Usuário não encontrado" });
  const password_hash = await bcrypt.hash(body.password, 10);

  try {
    const updRes = await pool.query(
      `UPDATE users
       SET name = COALESCE($1, name),
           email = COALESCE($2, email),
           role = COALESCE($3, role),
		   password_hash = COALESCE($X, password_hash),
           updated_at = now()
       WHERE id = $4
       RETURNING id, name, email, role, created_at`,
      [body.name ?? null, body.email ?? null, body.role ?? null, userId]
    );

    const user = updRes.rows[0];

    // stacks
    if (body.stacks) {
      const finalStacks =
        user.role === "developer" || user.role === "admin" ? body.stacks : [];
      await setUserStacks(userId, finalStacks);
    } else if (user.role !== "developer" && user.role !== "admin") {
      // se virou user/manager, zera stacks por segurança
      await pool.query(`DELETE FROM user_developer_stacks WHERE user_id=$1`, [userId]);
    }

    const stacksMap = await getStacksMap([userId]);

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      stacks: stacksMap.get(userId) ?? [],
      created_at: user.created_at,
    });
  } catch (e: any) {
    if (String(e?.code) === "23505") {
      return res.status(409).json({ error: "E-mail já cadastrado" });
    }
    throw e;
  }
});

/**
 * DELETE /api/admin/users/:userId
 */
adminRoutes.delete("/admin/users/:userId", async (req, res) => {
  const { userId } = req.params;

  const del = await pool.query(`DELETE FROM users WHERE id=$1`, [userId]);
  if (del.rowCount === 0) return res.status(404).json({ error: "Usuário não encontrado" });

  return res.json({ ok: true });
});

// ---------- MEMBERSHIPS ----------

/**
 * GET /api/admin/projects/:projectId/members
 * -> { items: ProjectMembership[] }  where ProjectMembership = { project_id, user_id }
 */
adminRoutes.get("/admin/projects/:projectId/members", async (req, res) => {
  const { projectId } = req.params;

  const p = await pool.query(`SELECT id FROM projects WHERE id=$1`, [projectId]);
  if (p.rowCount === 0) return res.status(404).json({ error: "Projeto não encontrado" });

  const { rows } = await pool.query(
    `SELECT project_id, user_id
     FROM project_members
     WHERE project_id=$1`,
    [projectId]
  );

  return res.json({ items: rows });
});

/**
 * POST /api/admin/projects/:projectId/members/:userId
 * -> { ok: true }
 */
adminRoutes.post("/admin/projects/:projectId/members/:userId", async (req, res) => {
  const { projectId, userId } = req.params;

  // valida existência
  const [p, u] = await Promise.all([
    pool.query(`SELECT id FROM projects WHERE id=$1`, [projectId]),
    pool.query(`SELECT id FROM users WHERE id=$1`, [userId]),
  ]);

  if (p.rowCount === 0) return res.status(404).json({ error: "Projeto não encontrado" });
  if (u.rowCount === 0) return res.status(404).json({ error: "Usuário não encontrado" });

  await pool.query(
    `INSERT INTO project_members (project_id, user_id)
     VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [projectId, userId]
  );

  return res.status(201).json({ ok: true });
});

/**
 * DELETE /api/admin/projects/:projectId/members/:userId
 * -> { ok: true }
 */
adminRoutes.delete("/admin/projects/:projectId/members/:userId", async (req, res) => {
  const { projectId, userId } = req.params;

  const del = await pool.query(
    `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`,
    [projectId, userId]
  );

  if (del.rowCount === 0) {
    return res.status(404).json({ error: "Atrelamento não encontrado" });
  }

  return res.json({ ok: true });
});
