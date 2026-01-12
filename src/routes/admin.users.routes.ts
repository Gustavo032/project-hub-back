import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import { authRequired } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";

export const adminUsersRoutes = Router();

/**
 * Helpers
 */
async function getStacksForUsers(userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string[]>();

  const { rows } = await pool.query(
    `SELECT uds.user_id, ds.code
     FROM user_developer_stacks uds
     JOIN developer_stacks ds ON ds.id = uds.stack_id
     WHERE uds.user_id = ANY($1::uuid[])
     ORDER BY ds.id`,
    [userIds]
  );

  const map = new Map<string, string[]>();
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
      const stackIdRes = await client.query(`SELECT id FROM developer_stacks WHERE code = $1`, [code]);
      const stackId = stackIdRes.rows[0]?.id;
      if (!stackId) throw new Error(`Stack inválida: ${code}`);

      await client.query(
        `INSERT INTO user_developer_stacks (user_id, stack_id) VALUES ($1, $2)`,
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

/**
 * Schema
 */
const RoleSchema = z.enum(["user", "manager", "developer", "admin"]);
const StackSchema = z.array(z.enum(["frontend", "backend", "infra"])).default([]);

/**
 * GET /api/admin/users
 * Retorna { items: User[] } no formato que o front espera.
 */
adminUsersRoutes.get(
  "/admin/users",
  authRequired,
  requireRole(["admin"]),
  async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, created_at
       FROM users
       ORDER BY created_at DESC`
    );

    const ids = rows.map((r) => r.id);
    const stacksMap = await getStacksForUsers(ids);

    const items = rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      stacks: stacksMap.get(u.id) ?? [],
      created_at: u.created_at,
    }));

    return res.json({ items });
  }
);

/**
 * GET /api/admin/users/:userId
 */
adminUsersRoutes.get(
  "/admin/users/:userId",
  authRequired,
  requireRole(["admin"]),
  async (req, res) => {
    const { userId } = req.params;

    const userRes = await pool.query(
      `SELECT id, name, email, role, created_at
       FROM users
       WHERE id = $1`,
      [userId]
    );

    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    const stacksMap = await getStacksForUsers([userId]);

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      stacks: stacksMap.get(userId) ?? [],
      created_at: user.created_at,
    });
  }
);

/**
 * POST /api/admin/users
 * body: { name, email, role, password, stacks? }
 *
 * - password obrigatório na criação
 * - stacks opcionais (só faz sentido para developer/admin)
 */
adminUsersRoutes.post(
  "/admin/users",
  authRequired,
  requireRole(["admin"]),
  async (req, res) => {
    const body = z.object({
      name: z.string().min(1).max(120),
      email: z.string().email().max(200),
      role: RoleSchema,
      password: z.string().min(6).max(200),
      stacks: StackSchema.optional(),
    }).parse(req.body);

    const password_hash = await bcrypt.hash(body.password, 10);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const insertRes = await client.query(
        `INSERT INTO users (name, email, role, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, email, role, created_at`,
        [body.name, body.email, body.role, password_hash]
      );

      const user = insertRes.rows[0];

      const stacks = body.stacks ?? [];
      // se for user/manager, stacks devem ficar vazias
      const finalStacks = (body.role === "developer" || body.role === "admin") ? stacks : [];

      await client.query("COMMIT");

      // stacks fora da transação (ou dentro, tanto faz) — aqui vou fazer fora usando helper:
      if (finalStacks.length > 0) {
        await setUserStacks(user.id, finalStacks);
      } else {
        await pool.query(`DELETE FROM user_developer_stacks WHERE user_id = $1`, [user.id]);
      }

      return res.status(201).json({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        stacks: finalStacks,
        created_at: user.created_at,
      });
    } catch (e: any) {
      await client.query("ROLLBACK");
      // email unique
      if (String(e?.code) === "23505") {
        return res.status(409).json({ error: "E-mail já cadastrado" });
      }
      throw e;
    } finally {
      client.release();
    }
  }
);

/**
 * PATCH /api/admin/users/:userId
 * body: { name?, email?, role?, password?, stacks? }
 *
 * - password opcional (se vier, atualiza hash)
 * - stacks atualizáveis (admin decide)
 */
adminUsersRoutes.patch(
  "/admin/users/:userId",
  authRequired,
  requireRole(["admin"]),
  async (req, res) => {
    const { userId } = req.params;

    const body = z.object({
      name: z.string().min(1).max(120).optional(),
      email: z.string().email().max(200).optional(),
      role: RoleSchema.optional(),
      password: z.string().min(6).max(200).optional(),
      stacks: StackSchema.optional(),
    }).refine((v) => Object.keys(v).length > 0, "Nada para atualizar").parse(req.body);

    const exists = await pool.query(`SELECT id, role FROM users WHERE id = $1`, [userId]);
    if (exists.rows.length === 0) return res.status(404).json({ error: "Usuário não encontrado" });

    const newHash = body.password ? await bcrypt.hash(body.password, 10) : null;

    // update user
    try {
      const updRes = await pool.query(
        `UPDATE users
         SET name = COALESCE($1, name),
             email = COALESCE($2, email),
             role = COALESCE($3, role),
             password_hash = COALESCE($4, password_hash),
             updated_at = now()
         WHERE id = $5
         RETURNING id, name, email, role, created_at`,
        [
          body.name ?? null,
          body.email ?? null,
          body.role ?? null,
          newHash,
          userId,
        ]
      );

      const user = updRes.rows[0];

      // stacks
      const role = user.role as string;
      const stacks = body.stacks ?? null;

      if (stacks) {
        const finalStacks = (role === "developer" || role === "admin") ? stacks : [];
        await setUserStacks(userId, finalStacks);
      } else if (role !== "developer" && role !== "admin") {
        // se virou user/manager e não mandou stacks, zera por segurança
        await pool.query(`DELETE FROM user_developer_stacks WHERE user_id = $1`, [userId]);
      }

      // retorna com stacks
      const stacksMap = await getStacksForUsers([userId]);

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
  }
);

/**
 * DELETE /api/admin/users/:userId
 * (cascata: memberships + stacks + votes etc., depende das FKs; aqui só deletamos o user)
 */
adminUsersRoutes.delete(
  "/admin/users/:userId",
  authRequired,
  requireRole(["admin"]),
  async (req, res) => {
    const { userId } = req.params;

    const delRes = await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    if (delRes.rowCount === 0) return res.status(404).json({ error: "Usuário não encontrado" });

    return res.json({ ok: true });
  }
);
